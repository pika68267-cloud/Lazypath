// Sign-up / sign-in against a Cloudflare D1 database, mocked as a local REST server that
// speaks the real /query wire format. Proves the one-owner claim, hashed passwords,
// stateless sessions across instances, and the local (no-database) fallback.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

const HOME = mkdtempSync(join(tmpdir(), "lazypath-accounts-"));
const OWNER = "pika";
const PASSWORD = "correct-horse-9";
const HOSTHEADER = "lazypath.vercel.app";

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}

// ---- the mock D1 endpoint -----------------------------------------------------
const rows = [];
const store = new Map();
const queries = [];
const d1 = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== "Bearer test-cf-token") return send(401, { success: false, errors: [{ message: "Authentication error" }] });
    if (!req.url.endsWith("/accounts/testacc/d1/database/testdb/query")) return send(404, { success: false, errors: [{ message: "not found" }] });
    const { sql, params } = JSON.parse(body || "{}");
    queries.push(sql);
    const ok = (results, meta = {}) => send(200, { success: true, errors: [], result: [{ results, meta }] });
    if (sql.startsWith("CREATE TABLE")) return ok([]);
    if (sql.startsWith("SELECT json FROM store WHERE key = ?")) return ok(store.has(params[0]) ? [{ json: store.get(params[0]) }] : []);
    if (sql.startsWith("SELECT key, json FROM store")) return ok([...store].map(([key, json]) => ({ key, json })));
    if (sql.startsWith("INSERT INTO store")) {
      store.set(params[0], params[1]);
      return ok([], { changes: 1 });
    }
    if (sql.startsWith("DELETE FROM store")) {
      store.delete(params[0]);
      return ok([], { changes: 1 });
    }
    if (sql.startsWith("INSERT INTO accounts")) {
      if (rows.length) return ok([], { changes: 0 });
      rows.push({ username: params[0], hash: params[1], created: params[2] });
      return ok([], { changes: 1, last_row_id: 1 });
    }
    if (sql.startsWith("SELECT username, hash FROM accounts")) return ok(rows.slice(0, 1));
    return send(400, { success: false, errors: [{ message: "unsupported sql" }] });
  });
});
await new Promise((r) => d1.listen(0, "127.0.0.1", r));
const D1_PORT = d1.address().port;

process.env.VERCEL = "1";
process.env.LAZYPATH_HOME = HOME;
process.env.LAZYPATH_MOCKS = "1";
process.env.LAZYPATH_NO_OPEN = "1";
process.env.CLOUDFLARE_ACCOUNT_ID = "testacc";
process.env.CLOUDFLARE_D1_DATABASE_ID = "testdb";
process.env.CLOUDFLARE_API_TOKEN = "test-cf-token";
process.env.CLOUDFLARE_API_BASE = `http://127.0.0.1:${D1_PORT}`;
process.env.LAZYPATH_TOKENS = JSON.stringify({ okmock: { provider: "okmock", accessToken: "seeded-token", authMode: "oauth" } });
delete process.env.LAZYPATH_USER;
delete process.env.LAZYPATH_PASSWORD;
delete process.env.LAZYPATH_CONFIG;
delete process.env.PORT;
delete process.env.HOST;

const { default: handle } = await import("../lazypath.ts");

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

const formPost = (path, fields) => call("POST", path, { form: new URLSearchParams(fields).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
const get = (path, headers) => call("GET", path, { headers });
const post = (path, body, headers) => call("POST", path, { body, headers });
const signup = (user, password, confirm = password) => formPost("/signup", { user, password, confirm });
const signin = (user, password) => formPost("/signin", { user, password });

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

let jar = {};
try {
  // ---- the public surface ------------------------------------------------------
  const home = await get("/");
  check("home page offers sign in and sign up", home.status === 200 && home.text().includes('href="/signin"') && home.text().includes('href="/signup"'));
  const open = await get("/signup");
  check("sign-up is open before anyone claims", open.status === 200 && open.text().includes("Claim your gateway") && open.text().includes('name="confirm"'));
  check("sign-up states the one-owner rule", open.text().includes("the only account"));

  // ---- validation ---------------------------------------------------------------
  check("bad username is rejected", (await signup("x!", PASSWORD)).status === 400);
  check("short password is rejected", (await signup(OWNER, "short")).status === 400);
  check("mismatched confirm is rejected", (await signup(OWNER, PASSWORD, PASSWORD + "x")).status === 400);
  check("nothing was claimed by invalid attempts", rows.length === 0);

  // ---- the atomic claim ----------------------------------------------------------
  const claimed = await signup(OWNER, PASSWORD);
  check("sign-up redirects to sign-in with a welcome", claimed.status === 302 && claimed.headers.location === "/signin?welcome=1");
  check("the account landed in D1", rows.length === 1 && rows[0].username === OWNER);
  check("the password is stored hashed, never plaintext", rows[0].hash.includes("$") && !rows[0].hash.includes(PASSWORD) && rows[0].hash.length > 100);
  check("the schema was created over REST", queries.some((q) => q.startsWith("CREATE TABLE IF NOT EXISTS accounts")));
  check("the claim is a single atomic INSERT", queries.some((q) => q.startsWith("INSERT INTO accounts") && q.includes("WHERE NOT EXISTS")));
  const closed = await get("/signup");
  check("sign-up closes after the claim", closed.status === 200 && closed.text().includes("Already claimed") && !closed.text().includes('action="/signup"'));
  check("a second sign-up is refused", (await signup("stranger", "another-password-1")).status === 409);
  check("the stranger never landed in D1", rows.length === 1);
  check("the welcome note renders", (await get("/signin?welcome=1")).text().includes("Account created"));

  // ---- signing in ------------------------------------------------------------------
  check("wrong password is refused", (await signin(OWNER, "nope-nope-nope")).status === 401);
  check("wrong username is refused", (await signin("someone-else", PASSWORD)).status === 401);
  const login = await signin(OWNER, PASSWORD);
  const cookie = login.headers["set-cookie"] ?? "";
  const session = cookie.match(/lp_session=([^;]+)/)?.[1] ?? "";
  check("sign-in redirects to the dashboard", login.status === 302 && login.headers.location === "/");
  check("cookie is HttpOnly, SameSite=Lax and Secure", cookie.includes("HttpOnly") && cookie.includes("SameSite=Lax") && cookie.includes("Secure"));
  check("cookie is username.hmac, not the password", session.startsWith(OWNER + ".") && /^[0-9a-f]{64}$/.test(session.split(".")[1]) && !cookie.includes(PASSWORD));
  jar = { cookie: `lp_session=${session}` };
  check("cookie opens the dashboard", (await get("/", jar)).text().includes('id="groups"'));
  const s = (await get("/api/summary", jar)).json();
  check("summary knows the D1 owner", s.user === OWNER && s.accountMode === "cloudflare" && s.public === true);
  check("the hashed password is never served", s.password === null);
  check("a forged cookie is refused", (await get("/api/summary", { cookie: `lp_session=${OWNER}.deadbeef` })).status === 401);
  check("unauthenticated api is refused", (await get("/api/summary")).status === 401 && (await get("/v1/models")).status === 401);

  // ---- the password doubles as the API key -------------------------------------------
  const bearer = { authorization: `Bearer ${PASSWORD}` };
  const chat = await post("/v1/chat/completions", { model: "okmock/mock-model", messages: [{ role: "user", content: "hi" }] }, bearer);
  check("bearer password serves a chat (scrypt check)", chat.status === 200 && chat.json().choices?.[0]?.message?.content === "hello from mock", chat.text().slice(0, 120));
  check("wrong bearer is refused", (await get("/api/summary", { authorization: "Bearer wrong-password-1" })).status === 401);
  check("empty bearer is refused", (await get("/api/summary", { authorization: "Bearer " })).status === 401);
  const basic = { authorization: "Basic " + Buffer.from(`${OWNER}:${PASSWORD}`).toString("base64") };
  check("basic auth works against D1", (await get("/api/summary", basic)).status === 200);
  check("wrong basic is refused", (await get("/api/summary", { authorization: "Basic " + Buffer.from(`${OWNER}:nope`).toString("base64") })).status === 401);

  // ---- the token store lives in D1, not on this instance ----------------------------
  check("the store table was created", queries.some((q) => q.startsWith("CREATE TABLE IF NOT EXISTS store")));
  check("the env seed was copied into D1 once", store.get("meta:tokens") === "1" && String(store.get("token:okmock")).includes("seeded-token"));
  const pasted = await post("/api/finish", { provider: "pastedmock", code: "good-code" }, bearer);
  check("a login completed on the deployed dashboard", pasted.status === 200 && pasted.json().ok === true, pasted.text().slice(0, 100));
  check("that token went to D1 rather than only to /tmp", String(store.get("token:pastedmock")).includes('"provider":"pastedmock"'));
  store.set("login:device:kiro", JSON.stringify({ provider: "kiro", clientId: "aws-client", clientSecret: "aws-secret", deviceCode: "aws-device-code", verifyUrl: "https://example.test/device", userCode: "ABCD-EFGH", startedAt: Date.now() - 16 * 60_000 }));
  await post("/api/disconnect", { provider: "okmock" }, bearer);
  check("disconnect removes the row from D1", !store.has("token:okmock"));
  const afterDrop = (await get("/api/summary", bearer)).json();
  check("the env seed cannot resurrect a disconnected provider", afterDrop.providers.find((p) => p.id === "okmock")?.connected !== true);

  // ---- rotation and sign-out -----------------------------------------------------------
  const rot = await post("/api/rotate", {}, bearer);
  check("rotation is refused in D1 mode", rot.status === 400 && rot.json().error?.message?.includes("D1"));
  const out = await post("/signout", {}, jar);
  check("sign-out clears the cookie", out.status === 302 && (out.headers["set-cookie"] ?? "").includes("Max-Age=0"));

  // ---- a cold instance verifies the same cookie ------------------------------------------
  // spawn, not spawnSync: the mock D1 answers from this process, so the parent's event loop
  // has to stay free while the child reads its tokens out of the database.
  const cold = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
import { Readable, Writable } from "node:stream";
const { default: h } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "lazypath.ts")).href)});
class R extends Writable { constructor(){super();this.parts=[]} setHeader(){} writeHead(s){this.status=s;return this} _write(c,e,cb){this.parts.push(Buffer.from(c));cb()} }
async function hit(url, cookie, raw) {
  const res = new R(); const done = new Promise((r) => res.on("finish", r));
  const req = Readable.from([]); req.method = "GET"; req.url = url; req.headers = { host: "x.vercel.app", cookie };
  await h(req, res); await done; return raw ? Buffer.concat(res.parts).toString() : res.status;
}
const jar = ${JSON.stringify(`lp_session=${session}`)};
console.log(await hit("/api/summary", jar));
console.log(await hit("/", jar));
const seen = JSON.parse(await hit("/api/summary", jar, true));
console.log(seen.providers.find((p) => p.id === "pastedmock")?.connected === true);
console.log(String(seen.providers.find((p) => p.id === "okmock")?.connected));
const statusReq = Readable.from([Buffer.from(JSON.stringify({provider:"kiro"}))]);
statusReq.method="POST";statusReq.url="/api/login-status";statusReq.headers={host:"x.vercel.app",cookie:jar,authorization:"Bearer ${PASSWORD}","content-type":"application/json"};
const statusRes=new R();const statusDone=new Promise((r)=>statusRes.on("finish",r));await h(statusReq,statusRes);await statusDone;const status=JSON.parse(Buffer.concat(statusRes.parts).toString());console.log("STATUS:" + statusRes.status);console.log("EXPIRED:" + (status.pending === false && status.connected === false));
`], { env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
  });
  const coldLines = cold.out.trim().split(/\r?\n/);
  check("a fresh instance accepts the session cookie", cold.code === 0 && coldLines[0] === "200" && coldLines[1] === "200", (cold.err || cold.out).trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 160));
  check("a cold instance reads the token straight out of D1", coldLines[2] === "true" && coldLines[3] === "false", coldLines.join(" | "));
  check("a cold instance detects and cleans expired Kiro device session from D1", coldLines.some((l) => l === "STATUS:200") && coldLines.some((l) => l === "EXPIRED:true"), coldLines.slice(4).join(" | "));

  // ---- a local gateway links into the very same database --------------------------------
  // The point of the store table: a provider linked in the process that *can* keep a poller
  // alive lands in D1, and the deployment reads that row. It finds the database through
  // .cloudflare.env only, with no CLOUDFLARE_* in its environment, which is how it is set up
  // on a real machine.
  const LINK_HOME = mkdtempSync(join(tmpdir(), "lazypath-d1local-"));
  writeFileSync(
    join(LINK_HOME, ".cloudflare.env"),
    [
      "CLOUDFLARE_ACCOUNT_ID=testacc",
      "CLOUDFLARE_D1_DATABASE_ID=testdb",
      "CLOUDFLARE_API_TOKEN=test-cf-token",
      `CLOUDFLARE_API_BASE=http://127.0.0.1:${D1_PORT}`,
    ].join("\r\n"),
  );
  const seededRow = store.get("token:pastedmock");
  const localLink = await new Promise(async (resolve) => {
    const env = { ...process.env, PORT: "8793", LAZYPATH_HOME: LINK_HOME };
    delete env.VERCEL;
    for (const k of Object.keys(env)) if (k.startsWith("CLOUDFLARE_")) delete env[k];
    const child = spawn(process.execPath, ["lazypath.ts"], { env, stdio: "ignore" });
    try {
      let up = null;
      for (let i = 0; i < 120; i++) {
        try {
          const r = await fetch("http://127.0.0.1:8793/api/summary");
          if (r.ok) {
            up = await r.json();
            break;
          }
        } catch {
          /* not listening yet */
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const r = await fetch("http://127.0.0.1:8793/api/finish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "pastedmock", code: "good-code" }),
      });
      resolve({ summary: up, body: await r.text() });
    } catch (e) {
      resolve({ summary: null, body: `local gateway never came up: ${String(e)}` });
    } finally {
      child.kill();
      rmSync(LINK_HOME, { recursive: true, force: true });
    }
  });
  check("a local gateway finds the database in .cloudflare.env", localLink.summary?.accountMode === "cloudflare", JSON.stringify(localLink.summary?.accountMode));
  check(
    "a local gateway writes its link into the shared database",
    localLink.body.includes('"ok":true') && String(store.get("token:pastedmock")) !== String(seededRow),
    localLink.body.slice(0, 90),
  );

  // ---- a dead database degrades to an error page, not a crash -----------------------------
  await new Promise((r) => d1.close(r));
  const dead = await signin(OWNER, PASSWORD);
  check("sign-in surfaces a database outage", dead.status === 502 && dead.text().includes("Cloudflare D1"));
  const deadSignup = await get("/signup");
  check("sign-up surfaces a database outage", deadSignup.status === 502 && deadSignup.text().includes("Cloudflare D1"));
} finally {
  mock.kill();
  d1.close();
  rmSync(HOME, { recursive: true, force: true });
}

// ---- the local fallback: no database, loopback, sign-up still works ----------------------
const LOCAL_HOME = mkdtempSync(join(tmpdir(), "lazypath-local-"));
const localScript = `
await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "lazypath.ts")).href)});
const GW = "http://127.0.0.1:8791";
let failures = 0;
const check = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) failures++; };
const j = async (path, opts = {}) => { const r = await fetch(GW + path, { redirect: "manual", ...opts }); return { status: r.status, headers: r.headers, text: await r.text() }; };
const form = (fields) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
for (let i = 0; i < 80; i++) { try { await j("/"); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const before = JSON.parse((await j("/api/summary")).text);
check("loopback dashboard is open without sign-in", (await j("/")).text.includes('id="groups"'));
check("local sign-up is open before a claim", (await j("/signup")).text.includes("Claim your gateway"));
const claimed = await j("/signup", form({ user: "localowner", password: "local-password-1", confirm: "local-password-1" }));
check("local sign-up claims the gateway", claimed.status === 302 && claimed.headers.get("location") === "/signin?welcome=1");
check("local sign-up closes afterwards", (await j("/signup")).text.includes("Already claimed"));
check("a second local claim is refused", (await j("/signup", form({ user: "other", password: "other-password-1", confirm: "other-password-1" }))).status === 409);
const login = await j("/signin", form({ user: "localowner", password: "local-password-1" }));
const cookie = (login.headers.get("set-cookie") ?? "").match(/lp_session=([^;]+)/)?.[1] ?? "";
check("local sign-in issues a session", login.status === 302 && cookie.startsWith("localowner."));
check("local session opens the dashboard", (await j("/", { headers: { cookie: "lp_session=" + cookie } })).text.includes('id="groups"'));
const after = JSON.parse((await j("/api/summary", { headers: { authorization: "Bearer local-password-1" } })).text);
check("the chosen credentials are in force", after.user === "localowner" && after.password === "local-password-1" && after.accountMode === "local");
const chatProbe = (pw) => j("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + pw }, body: JSON.stringify({ model: "smart", messages: [{ role: "user", content: "hi" }] }) });
check("the generated password stopped working", (await chatProbe(before.password)).status === 401);
check("the chosen password passes the key check", (await chatProbe("local-password-1")).status !== 401);
process.exit(failures ? 1 : 0);
`;
const localEnv = { ...process.env, PORT: "8791", LAZYPATH_HOME: LOCAL_HOME, LAZYPATH_NO_OPEN: "1", LAZYPATH_MOCKS: "" };
delete localEnv.VERCEL;
delete localEnv.CLOUDFLARE_ACCOUNT_ID;
delete localEnv.CLOUDFLARE_D1_DATABASE_ID;
delete localEnv.CLOUDFLARE_API_TOKEN;
delete localEnv.CLOUDFLARE_API_BASE;
delete localEnv.LAZYPATH_TOKENS;
delete localEnv.LAZYPATH_USER;
delete localEnv.LAZYPATH_PASSWORD;
delete localEnv.LAZYPATH_CONFIG;
const local = spawnSync(process.execPath, ["--input-type=module", "-e", localScript], { encoding: "utf8", env: localEnv, timeout: 60000 });
for (const line of (local.stdout || "").split("\n")) {
  if (line.startsWith("PASS") || line.startsWith("FAIL")) check(line.slice(6), line.startsWith("PASS"));
}
if (local.status !== 0 && !(local.stdout || "").includes("FAIL")) {
  check("local sign-up flow ran", false, (local.stderr || local.stdout || "").trim().split("\n").slice(-3).join(" ").slice(0, 200));
}
rmSync(LOCAL_HOME, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : "\nall accounts checks passed");
process.exit(failures ? 1 : 0);