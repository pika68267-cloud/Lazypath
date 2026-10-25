import { spawn } from "node:child_process";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TESTDIR = join(homedir(), ".lazypath-e2e");
rmSync(TESTDIR, { recursive: true, force: true });
mkdirSync(TESTDIR, { recursive: true });

const GW = "http://127.0.0.1:8791";
const started = [];

function jwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}

function spawnAndWait(args, env, port, matcher) {
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.on("error", (e) => console.error(`[:${port}] spawn error: ${e.message}`));
  p.on("exit", (code, sig) => console.error(`[:${port}] child exited code=${code} sig=${sig}`));
  p.stdout.on("data", (d) => console.error(`[:${port}] out: ` + d.toString().trim()));
  p.stderr.on("data", (d) => console.error(`[:${port}] err: ` + d.toString().trim()));
  started.push(p);
  return poll(port, matcher);
}

async function poll(port, matcher) {
  let last = "no attempt";
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (matcher(r.status)) return;
      last = `status ${r.status}`;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server on ${port} never came up (last: ${last})`);
}

const post = (path, body, headers = {}) =>
  fetch(GW + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}

async function connect(id, wait = true) {
  const r = await post("/api/connect", { provider: id });
  if (!r.ok) throw new Error(`connect ${id} -> ${r.status}`);
  const session = await r.json();
  if (wait && session.kind === "device" && !(await waitConnected(id))) throw new Error(`connect ${id}: device login never completed`);
  return session;
}

async function isConnected(id) {
  const s = await (await fetch(GW + "/api/summary")).json();
  return s.providers.find((p) => p.id === id)?.connected === true;
}

async function waitConnected(id) {
  for (let i = 0; i < 40; i++) {
    if (await isConnected(id)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  await spawnAndWait(["test/mock-provider.mjs"], {}, 8788, (s) => s >= 200);
  await spawnAndWait(["lazypath.ts"], { LAZYPATH_HOME: TESTDIR, PORT: "8791", LAZYPATH_MOCKS: "1", LAZYPATH_NO_OPEN: "1" }, 8791, (s) => s === 200);

  const cfg = JSON.parse(readFileSync(join(TESTDIR, "config.json"), "utf8"));
  const key = cfg.gatewayKey;
  const auth = { authorization: `Bearer ${key}` };

  const badKey = await post("/v1/chat/completions", { model: "smart", messages: [] }, { authorization: "Bearer nope" });
  check("rejects wrong gateway key", badKey.status === 401);

  const noProviders = await post("/v1/chat/completions", { model: "smart", messages: [{ role: "user", content: "hi" }] }, auth);
  const noProvidersJson = await noProviders.json();
  check("nothing linked is answered by the keyless floor", noProviders.status === 200 && noProvidersJson.choices?.[0]?.message?.content === "hello from keyless mock");

  const unlinked = await post("/v1/chat/completions", { model: "failmock/whatever", messages: [{ role: "user", content: "hi" }] }, auth);
  check("a provider you never linked -> 502 with attempts", unlinked.status === 502 && Array.isArray((await unlinked.json()).error.attempts));

  await connect("failmock");
  await connect("okmock");
  await post("/api/preset", { preset: "smart", chain: ["failmock", "okmock"] });

  const fallback = await post("/v1/chat/completions", { model: "smart", messages: [{ role: "user", content: "hi" }] }, auth);
  const fallbackJson = await fallback.json();
  check("fallback recovers after 503", fallback.status === 200 && fallbackJson.choices?.[0]?.message?.content === "hello from mock");
  check("reports which provider answered", fallback.headers.get("x-lazypath-provider") === "okmock");

  const streamed = await post("/v1/chat/completions", { model: "smart", messages: [{ role: "user", content: "hi" }], stream: true }, auth);
  const text = await streamed.text();
  check("SSE streaming passes through", streamed.headers.get("content-type")?.includes("text/event-stream") && text.includes("[DONE]"));

  const bare = await post("/v1/chat/completions", { model: "mock-model", messages: [] }, auth);
  check("bare model id routes to connected provider", bare.status === 200);

  const explicit = await post("/v1/chat/completions", { model: "okmock/mock-model", messages: [] }, auth);
  check("explicit provider/model targeting", explicit.status === 200 && explicit.headers.get("x-lazypath-provider") === "okmock");

  const models = await (await fetch(GW + "/v1/models")).json();
  check("/v1/models lists namespaced ids", models.data.some((m) => m.id === "okmock/mock-model"));

  const summary = await (await fetch(GW + "/api/summary")).json();
  check("dashboard summary marks connected", summary.providers.find((p) => p.id === "okmock")?.connected === true);
  check("usage bar data: ok provider counted", summary.providers.find((p) => p.id === "okmock")?.usage.ok >= 2);
  check("usage bar data: failing provider counted", summary.providers.find((p) => p.id === "failmock")?.usage.failed >= 1);
  check("usage bar data: tokens recorded", summary.providers.find((p) => p.id === "okmock")?.usage.inputTokens >= 0);

  const unknown = await post("/api/connect", { provider: "deepseek" });
  check("connect on unknown provider errors cleanly", unknown.status >= 400);

  // Anthropic wire-format provider: request translated out, response translated back.
  await connect("anthmock");
  const anth = await (await post("/v1/chat/completions", { model: "anthmock/mock-anth", messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }] }, auth)).json();
  check("anthropic-format provider returns OpenAI shape", anth.choices?.[0]?.message?.content === "hello from anthropic mock");
  check("anthropic usage mapped to openai fields", anth.usage?.prompt_tokens === 11 && anth.usage?.completion_tokens === 7);
  const anthStream = await post("/v1/chat/completions", { model: "anthmock/mock-anth", messages: [{ role: "user", content: "hi" }], stream: true }, auth);
  const anthStreamText = await anthStream.text();
  check("anthropic SSE converted to openai chunks", anthStreamText.includes("hello from anthropic mock") && anthStreamText.includes("[DONE]"));

  // Kiro wire: AWS JSON request out, binary eventstream back.
  await connect("kiromock");
  const kiro = await (await post("/v1/chat/completions", { model: "kiromock/mock-kiro", messages: [{ role: "user", content: "hi" }] }, auth)).json();
  check("kiro eventstream decoded to openai shape", kiro.choices?.[0]?.message?.content === "hello from kiro mock", JSON.stringify(kiro).slice(0, 120));
  check("kiro usage mapped to openai fields", kiro.usage?.prompt_tokens === 9 && kiro.usage?.completion_tokens === 4);

  // Responses wire (ChatGPT Codex + Grok): chat in, SSE responses out, collapsed back.
  await connect("respmock");
  const resp = await (await post("/v1/chat/completions", { model: "respmock/mock-resp", messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }] }, auth)).json();
  check("responses SSE collapsed to openai json", resp.choices?.[0]?.message?.content === "hello from responses mock");
  check("responses usage mapped to openai fields", resp.usage?.prompt_tokens === 13 && resp.usage?.completion_tokens === 6);
  const respStream = await post("/v1/chat/completions", { model: "respmock/mock-resp", messages: [{ role: "user", content: "hi" }], stream: true }, auth);
  const respStreamText = await respStream.text();
  check("responses SSE converted to openai chunks", respStreamText.includes("hello from responses mock") && respStreamText.includes("[DONE]"));
  check("responses role chunk emitted once", (respStreamText.match(/"role":"assistant"/g) ?? []).length === 1);

  // Cookie login: no OAuth at all, the session cookie is the credential.
  const cookieSession = await post("/api/connect", { provider: "cookiemock" });
  const cookieSessionJson = await cookieSession.json();
  check("cookie login asks for a pasted cookie", cookieSessionJson.kind === "paste");
  const noCookie = await post("/v1/chat/completions", { model: "cookiemock/mock-cookie", messages: [{ role: "user", content: "hi" }] }, auth);
  check("cookie provider refuses before login", noCookie.status >= 400);
  await post("/api/finish", { provider: "cookiemock", code: "hf-chat=session-abc" });
  const cookieChat = await (await post("/v1/chat/completions", { model: "cookiemock/mock-cookie", messages: [{ role: "user", content: "hi" }] }, auth)).json();
  check("cookie sent as Cookie header, SSE decoded", cookieChat.choices?.[0]?.message?.content === "hello from cookie mock");

  // Kimi web wire: Connect-framed JSON in, Connect frames out.
  await post("/api/finish", { provider: "kimimock", code: "mock-kimi-token" });
  const kimiWeb = await (await post("/v1/chat/completions", { model: "kimimock/k3", messages: [{ role: "user", content: "hi" }] }, auth)).json();
  check("kimi web frames decoded to openai shape", kimiWeb.choices?.[0]?.message?.content === "hello from kimi web mock", JSON.stringify(kimiWeb).slice(0, 120));
  const kimiWebStream = await post("/v1/chat/completions", { model: "kimimock/k3", messages: [{ role: "user", content: "hi" }], stream: true }, auth);
  const kimiWebStreamText = await kimiWebStream.text();
  check("kimi web frames re-emitted as openai chunks", kimiWebStreamText.includes("hello from kimi web mock") && kimiWebStreamText.includes("[DONE]"));

  // Dola wire: folded prompt + fingerprint out, content-block SSE back.
  await post("/api/finish", { provider: "dolamock", code: "sessionid=abc; s_v_web_id=verify_abc" });
  const dola = await (await post("/v1/chat/completions", { model: "dolamock/dola-speed", messages: [{ role: "user", content: "hi" }] }, auth)).json();
  check("dola content blocks decoded to openai shape", dola.choices?.[0]?.message?.content === "hello from dola mock", JSON.stringify(dola).slice(0, 120));
  const dolaStream = await post("/v1/chat/completions", { model: "dolamock/dola-speed", messages: [{ role: "user", content: "hi" }], stream: true }, auth);
  const dolaStreamText = await dolaStream.text();
  check("dola SSE re-emitted as openai chunks", dolaStreamText.includes("hello from dola mock") && dolaStreamText.includes("[DONE]"));

  // Z.ai wire: JWT token, HMAC signature, new-chat then streaming completions.
  await connect("zaimock");
  await post("/api/finish", { provider: "zaimock", code: jwt({ id: "user-123" }) });
  const zai = await (await post("/v1/chat/completions", { model: "zaimock/glm-5.3", messages: [{ role: "user", content: "hi" }] }, auth)).json();
  check("z.ai signed chat decoded to openai shape", zai.choices?.[0]?.message?.content === "hello from z.ai mock", JSON.stringify(zai).slice(0, 120));
  const zaiStream = await post("/v1/chat/completions", { model: "zaimock/glm-5.3", messages: [{ role: "user", content: "hi" }], stream: true }, auth);
  const zaiStreamText = await zaiStream.text();
  check("z.ai SSE envelope re-emitted as openai chunks", zaiStreamText.includes("hello from z.ai mock") && zaiStreamText.includes("[DONE]"));

  // Inner AI wire: JWT token with device_id, SSE text/end_stream out.
  await connect("inneraimock");
  await post("/api/finish", { provider: "inneraimock", code: `token=${jwt({ device_id: "dev-123" })} user@example.com` });
  const inner = await (await post("/v1/chat/completions", { model: "inneraimock/gpt-4o", messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }] }, auth)).json();
  check("inner.ai SSE decoded to openai shape", inner.choices?.[0]?.message?.content === "hello from inner.ai mock", JSON.stringify(inner).slice(0, 120));
  const innerStream = await post("/v1/chat/completions", { model: "inneraimock/gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }, auth);
  const innerStreamText = await innerStream.text();
  check("inner.ai SSE re-emitted as openai chunks", innerStreamText.includes("hello from inner.ai mock") && innerStreamText.includes("[DONE]"));

  // Perplexity web wire: a bare session token is wrapped into its cookie, the ask is posted
  // with the schematized params, and the answer arrives as workflow_block diffs.
  await connect("pplxmock");
  await post("/api/finish", { provider: "pplxmock", code: "pplx-session-token" });
  const pplx = await (await post("/v1/chat/completions", { model: "pplxmock/pplx_pro", messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }] }, auth)).json();
  check("perplexity workflow diffs decoded to openai shape", pplx.choices?.[0]?.message?.content === "hello from perplexity mock", JSON.stringify(pplx).slice(0, 160));
  const pplxStream = await post("/v1/chat/completions", { model: "pplxmock/pplx_pro", messages: [{ role: "user", content: "hi" }], stream: true }, auth);
  const pplxStreamText = await pplxStream.text();
  check("perplexity end_of_stream re-emitted as openai chunks", pplxStreamText.includes("hello from perplexity mock") && pplxStreamText.includes("[DONE]"));

  // Claude web wire: sessionKey cookie, org discovery, then an Anthropic-shaped completion stream.
  await connect("claudemock");
  await post("/api/finish", { provider: "claudemock", code: jwt({ sub: "user-1" }) });
  const claudeWeb = await (await post("/v1/chat/completions", { model: "claudemock/claude-sonnet-4-6", messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }, { role: "assistant", content: "sure" }, { role: "user", content: "again" }] }, auth)).json();
  check("claude web org lookup + completion decoded", claudeWeb.choices?.[0]?.message?.content === "hello from claude web mock", JSON.stringify(claudeWeb).slice(0, 160));
  const claudeWebStream = await post("/v1/chat/completions", { model: "claudemock/claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }], stream: true }, auth);
  const claudeWebStreamText = await claudeWebStream.text();
  const claudeWebDeltas = [...claudeWebStreamText.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join("");
  check("claude web SSE re-emitted as openai chunks", claudeWebDeltas === "hello from claude web mock" && claudeWebStreamText.includes("[DONE]"));

  // Keyless login: connected without a token, and no bearer reaches the provider.
  check("keyless provider counts as connected with no login", await isConnected("keymock"));
  const keyless = await (await post("/v1/chat/completions", { model: "keymock/mock-keyless", messages: [{ role: "user", content: "hi" }] }, auth)).json();
  check("keyless request goes out without an authorization header", keyless.choices?.[0]?.message?.content === "hello from keyless mock", JSON.stringify(keyless).slice(0, 160));

  // ZenMux free tier: the ctoken cookie is replayed as a query parameter and the answer
  // comes back as an Anthropic stream that always streams, even for a non-stream ask.
  await connect("zenmuxmock");
  await post("/api/finish", { provider: "zenmuxmock", code: "ctoken=zx-1; theme=dark" });
  const zenmux = await (await post("/v1/chat/completions", { model: "zenmuxmock/glm-free", messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }] }, auth)).json();
  check("zenmux always-streaming answer collected for a non-stream ask", zenmux.choices?.[0]?.message?.content === "hello from zenmux mock", JSON.stringify(zenmux).slice(0, 160));
  const zenmuxStream = await post("/v1/chat/completions", { model: "zenmuxmock/glm-free", messages: [{ role: "user", content: "hi" }], stream: true }, auth);
  const zenmuxStreamText = await zenmuxStream.text();
  const zenmuxDeltas = [...zenmuxStreamText.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join("");
  check("zenmux SSE re-emitted as openai chunks", zenmuxDeltas === "hello from zenmux mock" && !zenmuxStreamText.includes("thinking aloud") && zenmuxStreamText.includes("[DONE]"));

  // Adapta web: the __client cookie buys a clerk session, which buys a short-lived JWT.
  await connect("adaptamock");
  await post("/api/finish", { provider: "adaptamock", code: jwt({ sid: "sess-1" }) });
  const adapta = await (await post("/v1/chat/completions", { model: "adaptamock/one", messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }] }, auth)).json();
  check("adapta clerk token bootstrap + parts wire decoded", adapta.choices?.[0]?.message?.content === "hello from adapta mock", JSON.stringify(adapta).slice(0, 160));
  const adaptaStream = await post("/v1/chat/completions", { model: "adaptamock/one", messages: [{ role: "user", content: "hi" }], stream: true }, auth);
  const adaptaStreamText = await adaptaStream.text();
  const adaptaDeltas = [...adaptaStreamText.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join("");
  check("adapta text-delta stream re-emitted, quick-response skipped", adaptaDeltas === "hello from adapta mock" && !adaptaStreamText.includes("IGNORED") && adaptaStreamText.includes("[DONE]"));

  // Hyperagent web: open a thread, latch the model on it, then chat inside it.
  await connect("hypermock");
  await post("/api/finish", { provider: "hypermock", code: "__session=hyper-1; __cf_bm=abc" });
  const hyper = await (await post("/v1/chat/completions", { model: "hypermock/claude-sonnet-5", messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }] }, auth)).json();
  check("hyperagent thread bootstrap + chat decoded", hyper.choices?.[0]?.message?.content === "hello from hyperagent mock", JSON.stringify(hyper).slice(0, 160));
  const hyperStream = await post("/v1/chat/completions", { model: "hypermock/claude-opus-4-8", messages: [{ role: "user", content: "hi" }], stream: true }, auth);
  const hyperStreamText = await hyperStream.text();
  const hyperDeltas = [...hyperStreamText.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join("");
  check("hyperagent SSE re-emitted as openai chunks", hyperDeltas === "hello from hyperagent mock" && hyperStreamText.includes("[DONE]"));

  // OAuth login shapes.
  const gated = await connect("devmock", false);
  check("device login returns a code to approve", gated.kind === "device" && gated.userCode === "MOCK-9241");
  check("device login stays pending until approved", (await isConnected("devmock")) === false);
  await fetch("http://127.0.0.1:8788/oauth/approve", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "device_code=devmock",
  });
  check("device login completes after approval", await waitConnected("devmock"));

  const pasted = await connect("pastedmock");
  check("paste login hands back a url and waits", pasted.kind === "paste");
  const badPaste = await post("/api/finish", { provider: "pastedmock", code: "wrong-code" });
  check("bad pasted code rejected", badPaste.status >= 400 && !(await isConnected("pastedmock")));
  await post("/api/finish", { provider: "pastedmock", code: "good-code" });
  check("pasted code completes the login", await isConnected("pastedmock"));

  await post("/api/toggle", { provider: "okmock" });
  const skipped = await post("/v1/chat/completions", { model: "okmock/mock-model", messages: [{ role: "user", content: "hi" }] }, auth);
  check("disabled provider is skipped", skipped.status === 502);
  await post("/api/toggle", { provider: "okmock" });
  const back = await post("/v1/chat/completions", { model: "okmock/mock-model", messages: [{ role: "user", content: "hi" }] }, auth);
  check("re-enabled provider serves again", back.status === 200);

  const disconnected = await post("/api/disconnect", { provider: "pastedmock" });
  check("disconnect clears the token", disconnected.ok && !(await isConnected("pastedmock")));

  const rotated = await (await post("/api/rotate", {})).json();  check("key rotation returns a new key", rotated.gatewayKey !== key);
  const oldKeyWorks = await post("/v1/chat/completions", { model: "smart", messages: [] }, auth);
  check("old key rejected after rotation", oldKeyWorks.status === 401, `got ${oldKeyWorks.status}`);
  const newKeyWorks = await post("/v1/chat/completions", { model: "smart", messages: [] }, { authorization: `Bearer ${rotated.gatewayKey}` });
  check("new key accepted after rotation", newKeyWorks.status === 200 || newKeyWorks.status === 502, `got ${newKeyWorks.status}`);
}

await main().catch((e) => {
  console.error("harness error:", e.message);
  failures++;
});
for (const p of started) p.kill();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
