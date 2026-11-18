// Vercel mode: there is no port to bind, so the handler is imported in-process with
// VERCEL=1 and driven with mock req/res objects.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

const HOME = mkdtempSync(join(tmpdir(), "lazypath-faas-"));
const USER = "ops";
const PASSWORD = "faas-test-password";
const HOSTHEADER = "lazypath.vercel.app";

process.env.VERCEL = "1";
process.env.LAZYPATH_HOME = HOME;
process.env.LAZYPATH_MOCKS = "1";
process.env.LAZYPATH_NO_OPEN = "1";
process.env.LAZYPATH_USER = USER;
process.env.LAZYPATH_PASSWORD = PASSWORD;
// A device login done on a laptop, handed to the deployment through the environment.
process.env.LAZYPATH_TOKENS = JSON.stringify({ okmock: { provider: "okmock", accessToken: "seeded-token", authMode: "oauth" } });
delete process.env.PORT;
delete process.env.HOST;

const { default: handle } = await import("../lazypath.ts");

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}

class Res extends Writable {
  status = 0;
  headers = {};
  parts = [];
  setHeader(k, v) {
    this.headers[k.toLowerCase()] = String(v);
  }
  writeHead(status, headers) {
    this.status = status;
    for (const k in headers ?? {}) this.setHeader(k, headers[k]);
    return this;
  }
  _write(chunk, _enc, cb) {
    this.parts.push(Buffer.from(chunk));
    cb();
  }
  text() {
    return Buffer.concat(this.parts).toString("utf8");
  }
  json() {
    return JSON.parse(this.text());
  }
}

function call(method, path, { body, headers = {}, form } = {}) {
  return new Promise((resolve, reject) => {
    const res = new Res();
    res.on("finish", () => resolve(res));
    res.on("error", reject);
    const payload = form ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = Readable.from(payload === undefined ? [] : [Buffer.from(payload)]);
    req.method = method;
    req.url = path;
    req.headers = { host: HOSTHEADER, ...headers };
    handle(req, res).catch(reject);
  });
}

const bearer = { authorization: `Bearer ${PASSWORD}` };
const basic = { authorization: "Basic " + Buffer.from(`${USER}:${PASSWORD}`).toString("base64") };
const signIn = (user, password, path = "/signin") => call("POST", path, { form: new URLSearchParams({ user, password }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
const get = (path, headers) => call("GET", path, { headers });
const post = (path, body, headers) => call("POST", path, { body, headers });
const summary = async (headers) => (await get("/api/summary", headers)).json();
const connected = async (id, headers) => (await summary(headers)).providers.find((p) => p.id === id)?.connected === true;

const mock = spawn(process.execPath, ["test/mock-provider.mjs"], { stdio: ["ignore", "pipe", "pipe"] });
mock.stdout.on("data", () => {});
mock.stderr.on("data", (d) => console.error("[mock] " + d.toString().trim()));
for (let i = 0; i < 60; i++) {
  try {
    await fetch("http://127.0.0.1:8788/");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}

try {
  // ---- the environment is the durable store --------------------------------
  check("env-seeded token counts as connected", await connected("okmock", bearer));
  const seeded = await post("/v1/chat/completions", { model: "okmock/mock-model", messages: [{ role: "user", content: "hi" }] }, bearer);
  check("env-seeded token serves a chat", seeded.status === 200 && seeded.json().choices?.[0]?.message?.content === "hello from mock", seeded.text().slice(0, 120));
  const envCreds = await summary(bearer);
  check("env username is the one in force", envCreds.user === USER);
  check("env password is the one in force", envCreds.password === PASSWORD);

  // ---- nothing is readable without signing in --------------------------------
  const gate = await get("/");
  check("unauthenticated root is the public home page", gate.status === 200 && gate.text().includes('href="/signup"') && gate.text().includes('href="/signin"') && !gate.text().includes('id="groups"'));
  const form = await get("/signin");
  check("the sign-in page is a username + password form", form.text().includes('name="user"') && form.text().includes('name="password"') && form.text().includes('method="post"') && form.text().includes('action="/signin"'));
  check("wrong password is rejected at sign-in", (await signIn(USER, "nope")).status === 401);
  check("wrong username is rejected at sign-in", (await signIn("someone-else", PASSWORD)).status === 401);
  check("the old POST / sign-in alias still works", (await signIn(USER, PASSWORD, "/")).status === 302);
  check("a password in the query string does not sign in", (await get(`/?password=${PASSWORD}`)).text().includes('href="/signin"'));
  check("summary needs a login", (await get("/api/summary")).status === 401);
  check("model list needs a login", (await get("/v1/models")).status === 401);
  check("chat needs a login", (await post("/v1/chat/completions", { model: "smart", messages: [] })).status === 401);
  check("connect needs a login", (await post("/api/connect", { provider: "groq" })).status === 401);
  check("disconnect needs a login", (await post("/api/disconnect", { provider: "okmock" })).status === 401);

  // ---- env-managed deployments do not offer sign-up ---------------------------
  const signupGet = await get("/signup");
  check("sign-up explains env-managed login", signupGet.status === 200 && signupGet.text().includes("Login is set by env") && signupGet.text().includes("LAZYPATH_PASSWORD"));
  check("sign-up POST is refused when env-managed", (await call("POST", "/signup", { form: "user=stranger&password=longenough1&confirm=longenough1", headers: { "content-type": "application/x-www-form-urlencoded" } })).status === 409);
  check("the welcome note shows after sign-up", (await get("/signin?welcome=1")).text().includes("Account created"));
  const out = await post("/signout", {});
  check("sign-out clears the cookie", out.status === 302 && (out.headers["set-cookie"] ?? "").includes("Max-Age=0"));

  // ---- signing in issues a signed cookie, not the password -------------------
  const login = await signIn(USER, PASSWORD);
  const cookie = login.headers["set-cookie"] ?? "";
  const session = cookie.match(/lp_session=([^;]+)/)?.[1] ?? "";
  check("correct credentials redirect to the dashboard", login.status === 302 && login.headers.location === "/");
  check("session cookie is HttpOnly, SameSite and Secure", cookie.includes("HttpOnly") && cookie.includes("SameSite=Lax") && cookie.includes("Secure"));
  check("the cookie does not carry the password", session.length > 0 && !cookie.includes(PASSWORD));
  check("the cookie names the user and a signature", session.startsWith(USER + ".") && session.split(".").length === 2);
  check("a forged session cookie is refused", (await get("/", { cookie: "lp_session=deadbeef" })).text().includes('href="/signin"'));
  check("a forged cookie with a real username is refused", (await get("/api/summary", { cookie: `lp_session=${USER}.deadbeef` })).status === 401);
  const jar = { cookie: `lp_session=${session}` };
  const dash = await get("/", jar);
  check("cookie opens the dashboard", dash.status === 200 && dash.text().includes('id="groups"'));
  const viaCookie = await summary(jar);
  check("cookie authenticates the api", viaCookie.serverless === true);
  check("summary reports the account mode and public flag", viaCookie.accountMode === "local" && viaCookie.public === true);
  check("base url is https on serverless", viaCookie.baseUrl === `https://${HOSTHEADER}`, viaCookie.baseUrl);
  check("bearer password authenticates the api", (await summary(bearer)).serverless === true);
  check("http basic authenticates the api", (await summary(basic)).serverless === true);
  check("basic with a wrong password is refused", (await get("/api/summary", { authorization: "Basic " + Buffer.from(`${USER}:nope`).toString("base64") })).status === 401);
  check("an empty bearer is refused", (await get("/api/summary", { authorization: "Bearer " })).status === 401);
  check("empty basic credentials are refused", (await get("/api/summary", { authorization: "Basic " + Buffer.from(":").toString("base64") })).status === 401);
  const basicChat = await post("/v1/chat/completions", { model: "okmock/mock-model", messages: [{ role: "user", content: "hi" }] }, basic);
  check("basic auth serves a chat", basicChat.status === 200 && basicChat.json().choices?.[0]?.message?.content === "hello from mock", basicChat.text().slice(0, 120));

  // ---- logins that need a live process are refused, with a way forward ------
  for (const id of ["kimi", "copilot", "gitlab", "anthropic"]) {
    const r = await post("/api/connect", { provider: id }, bearer);
    const msg = r.json().error?.message ?? "";
    check(`${id} login refused on serverless`, r.status === 400 && msg.includes("lazypath export"), msg.slice(0, 90));
  }
  const rotated = await post("/api/rotate", {}, bearer);
  check("password rotation refused on serverless", rotated.status === 400 && rotated.json().error?.message?.includes("LAZYPATH_PASSWORD"));
  check("env password survived the refused rotation", (await summary(bearer)).password === PASSWORD);
  check("the session still works after the refused rotation", (await summary(jar)).serverless === true);

  // ---- stateless logins survive a cold start between connect and finish -----
  const finished = await post("/api/finish", { provider: "pastedmock", code: "good-code" }, bearer);
  check("paste finish rebuilds a session it never saw", finished.status === 200 && finished.json().ok === true, finished.text().slice(0, 120));
  check("rebuilt paste login is connected", await connected("pastedmock", bearer));
  const bad = await post("/api/finish", { provider: "pastedmock", code: "wrong-code" }, bearer);
  check("bad pasted code still rejected", bad.status >= 400);

  const cookieLogin = await post("/api/connect", { provider: "cookiemock" }, bearer);
  check("cookie login still starts on serverless", cookieLogin.status === 200 && cookieLogin.json().kind === "paste");
  await post("/api/finish", { provider: "cookiemock", code: "session=abc" }, bearer);
  check("cookie login completes on serverless", await connected("cookiemock", bearer));

  const keyPaste = await post("/api/connect", { provider: "groq" }, bearer);
  check("platform-key login starts on serverless", keyPaste.status === 200 && keyPaste.json().kind === "paste" && keyPaste.json().url.includes("groq.com"));

  // ---- disconnect must not be undone by the env seed ------------------------
  await post("/api/disconnect", { provider: "okmock" }, bearer);
  check("disconnect is not resurrected by LAZYPATH_TOKENS", !(await connected("okmock", bearer)));

  // ---- the expanded catalog -------------------------------------------------
  const keys = (await summary(bearer)).providers.filter((p) => p.group === "API key");
  check("twelve platform-key providers ship", keys.length === 12, String(keys.length));
  const svg = (p) => typeof p.logo === "string" && p.logo.trim().startsWith("<svg") && p.logo.trim().endsWith("</svg>");
  check("every one has a real brand svg", keys.every(svg), keys.filter((p) => !svg(p)).map((p) => p.id).join(","));
  const shipping = (await summary(bearer)).providers.filter((p) => p.group !== "Mocks");
  const noMark = shipping.filter((p) => !(typeof p.logo === "string" && /<svg|<img/.test(p.logo)));
  check("no shipping provider falls back to a monogram", noMark.length === 0, noMark.map((p) => p.id).join(","));
  const ids = (await get("/v1/models", bearer)).json().data.map((m) => m.id);
  check("new providers are addressable", ids.includes("openrouter/google/gemma-4-31b-it:free") && ids.includes("groq/openai/gpt-oss-120b") && ids.includes("deepseek/deepseek-flash"));
  check("presets still resolve", ["smart", "fast", "cheap"].every((p) => ids.includes(p)));
} finally {
  mock.kill();
  rmSync(HOME, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall serverless checks passed");
process.exit(failures ? 1 : 0);