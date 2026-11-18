// Guards the artifact Vercel actually runs. Vercel transpiles api/ files one at a time and
// never bundles, so the entry must resolve to real .js — importing ../lazypath.ts here would
// pass on Node 24 and still 500 on the platform. This drives the built chain end to end.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

const HOME = mkdtempSync(join(tmpdir(), "lazypath-build-"));
const USER = "ops";
const PASSWORD = "build-test-password";
const HOSTHEADER = "lazypath.vercel.app";

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}

// ---- the build step itself ---------------------------------------------------
const built = spawnSync(process.execPath, ["build-vercel.mjs"], { encoding: "utf8" });
check("vercel-build exits cleanly", built.status === 0, (built.stderr || "").trim().slice(0, 200));
check("vercel-build emits lazypath.js", existsSync("lazypath.js"));

const entry = readFileSync("api/index.ts", "utf8");
const specifier = entry.match(/from\s+"([^"]+)"/)?.[1] ?? "";
check("entry imports .js, never .ts", specifier.endsWith(".js"), specifier);
check("entry specifier resolves to a built file", existsSync(join("api", specifier)), specifier);
check("built gateway is gitignored", readFileSync(".gitignore", "utf8").split("\n").includes("lazypath.js"));

const js = readFileSync("lazypath.js", "utf8");
check("no type-only import survived the strip", !/import\s+type\s/.test(js));
check("no runtime dependency crept in", !/^\s*import\s[^;]*from\s+"(?!node:)/m.test(js));
check("handler is still the default export", /export\s+default\s+handle/.test(js));

// ---- drive the built chain exactly as the platform would ---------------------
process.env.VERCEL = "1";
process.env.LAZYPATH_HOME = HOME;
process.env.LAZYPATH_MOCKS = "1";
process.env.LAZYPATH_NO_OPEN = "1";
process.env.LAZYPATH_USER = USER;
process.env.LAZYPATH_PASSWORD = PASSWORD;
process.env.LAZYPATH_TOKENS = JSON.stringify({ okmock: { provider: "okmock", accessToken: "seeded-token", authMode: "oauth" } });
delete process.env.PORT;
delete process.env.HOST;

const { default: handle } = await import("../api/index.ts");
check("built entry exports a callable handler", typeof handle === "function");

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

function call(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = new Res();
    res.on("finish", () => resolve(res));
    res.on("error", reject);
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = path;
    req.headers = { host: HOSTHEADER, ...headers };
    handle(req, res).catch(reject);
  });
}

const bearer = { authorization: `Bearer ${PASSWORD}` };
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
  const gate = await call("GET", "/");
  check("built function serves the sign-in gate", gate.status === 200 && gate.text().includes("Sign in to open the dashboard"), gate.text().slice(0, 90));
  check("built function rejects a keyless api call", (await call("GET", "/api/summary")).status === 401);
  const summary = (await call("GET", "/api/summary", { headers: bearer })).json();
  check("built function reports serverless mode", summary.serverless === true);
  check("built function keeps the whole catalog", summary.providers.filter((p) => p.group !== "Mocks").length === 34, String(summary.providers.length));
  check("built function seeds tokens from the environment", summary.providers.find((p) => p.id === "okmock")?.connected === true);
  const chat = await call("POST", "/v1/chat/completions", { body: { model: "okmock/mock-model", messages: [{ role: "user", content: "hi" }] }, headers: bearer });
  check("built function serves a chat", chat.status === 200 && chat.json().choices?.[0]?.message?.content === "hello from mock", chat.text().slice(0, 120));
  const models = (await call("GET", "/v1/models", { headers: bearer })).json();
  check("built function lists models", models.data.some((m) => m.id === "groq/openai/gpt-oss-120b"));
} finally {
  mock.kill();
  rmSync(HOME, { recursive: true, force: true });
}

// ---- a hostile config must not crash module load -----------------------------
// loadConfig() runs at import time, outside the handler's try/catch: if it throws, the
// platform answers FUNCTION_INVOCATION_FAILED and no request ever reaches our code.
const entryUrl = pathToFileURL(join(process.cwd(), "api/index.ts")).href;
const probe = `
import { Readable, Writable } from "node:stream";
const { default: h } = await import(${JSON.stringify(entryUrl)});
class R extends Writable {
  constructor() { super(); this.parts = []; }
  setHeader() {}
  writeHead(s) { this.status = s; return this; }
  _write(c, e, cb) { this.parts.push(Buffer.from(c)); cb(); }
}
const res = new R();
const done = new Promise((r) => res.on("finish", r));
const req = Readable.from([]);
req.method = "GET"; req.url = "/api/summary";
req.headers = { host: "x.vercel.app", authorization: "Bearer " + process.env.LAZYPATH_PASSWORD };
await h(req, res); await done;
console.log(res.status);
`;
const hostile = [
  ["preset is a string", '{"presets":{"smart":"kimi"}}', null],
  ["presets is a string", '{"presets":"nope"}', null],
  ["config is a number", "42", null],
  ["config is an array", "[]", null],
  ["config json is truncated", '{"presets":', null],
  ["config file on disk is truncated", null, '{"password":'],
];
for (const [name, envValue, diskValue] of hostile) {
  const home = mkdtempSync(join(tmpdir(), "lazypath-hostile-"));
  if (diskValue !== null) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), diskValue);
  }
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    encoding: "utf8",
    env: { ...process.env, VERCEL: "1", LAZYPATH_HOME: home, LAZYPATH_USER: USER, LAZYPATH_PASSWORD: PASSWORD, LAZYPATH_NO_OPEN: "1", LAZYPATH_MOCKS: "", LAZYPATH_CONFIG: envValue ?? "" },
  });
  check(`survives ${name}`, r.status === 0 && r.stdout.trim() === "200", (r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" ").slice(0, 160));
  rmSync(home, { recursive: true, force: true });
}

// An unset password on serverless is a lockout, so the gate has to say so instead of
// asking for a random secret that is regenerated on every cold start and never shown.
const noPwHome = mkdtempSync(join(tmpdir(), "lazypath-nopw-"));
const noPassword = spawnSync(process.execPath, ["--input-type=module", "-e", probe.replace('req.url = "/api/summary"', 'req.url = "/"').replace("console.log(res.status)", "console.log(Buffer.concat(res.parts).toString())")], {
  encoding: "utf8",
  env: { ...process.env, VERCEL: "1", LAZYPATH_HOME: noPwHome, LAZYPATH_PASSWORD: "", LAZYPATH_NO_OPEN: "1", LAZYPATH_MOCKS: "" },
});
check("an unset password is explained at the gate", noPassword.status === 0 && noPassword.stdout.includes("No LAZYPATH_PASSWORD is set"), (noPassword.stderr || "").trim().split("\n").slice(-2).join(" ").slice(0, 160));
rmSync(noPwHome, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : "\nall vercel-build checks passed");
process.exit(failures ? 1 : 0);