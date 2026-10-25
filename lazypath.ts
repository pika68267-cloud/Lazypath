#!/usr/bin/env node
// lazypath — one OpenAI-compatible endpoint for every LLM, logged in by account, not API key.
//
// Single file, zero runtime dependencies. Node >= 24:  node lazypath.ts
// Data (config, tokens, usage) lives in ~/.lazypath/ — delete that folder to reset.

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

// --------------------------------------------------------------------------- types

type WireFormat = "openai" | "anthropic" | "kiro" | "responses" | "huggingchat" | "kimiweb" | "dola" | "zaiweb" | "innerai" | "pplxweb" | "claudeweb" | "zenmux" | "adapta" | "hyperagent";
/** device = show a code, user approves in browser (RFC 8628 style)
 *  paste  = open a login page, user pastes back the code the provider shows
 *  none   = the provider serves anonymous requests, nothing to connect */
type LoginKind = "device" | "paste" | "cookie" | "none";

interface ModelInfo {
  id: string;
  label: string;
}

interface ProviderDef {
  id: string;
  label: string;
  color: string;
  logo: string | null;
  monogram: string;
  login: LoginKind;
  /** official = the provider publishes this flow for its own CLI.
   *  community = reverse-engineered but stable.  tosrisk = documented, but the
   *  provider restricts the client id to its first-party tool. */
  trust: "official" | "community" | "tosrisk";
  group: string;
  inference: { baseUrl: string; format: WireFormat; path?: string; headers?: Record<string, string>; /** where a cookie login gets exchanged for the token inference actually uses */ authUrl?: string };
  /** page the user signs in on, for logins that start from the provider's website */
  site?: string;
  /** what exactly to paste for a cookie login, when "the Cookie header" is not the answer */
  hint?: string;
  models: ModelInfo[];
}

interface TokenSet {
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  authMode: "oauth" | "cookie";
  /** extra material some providers need on every call (e.g. Copilot's account id) */
  headers?: Record<string, string>;
}

interface UsageRow {
  requests: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  lastUsedAt: number;
}

interface Presets {
  smart: string[];
  fast: string[];
  cheap: string[];
}

interface Config {
  gatewayKey: string;
  port: number;
  deviceId: string;
  disabled: string[];
  presets: Presets;
}

// --------------------------------------------------------------------------- store

const DATA_DIR = process.env.LAZYPATH_HOME ?? join(homedir(), ".lazypath");
const CONFIG_FILE = join(DATA_DIR, "config.json");
const TOKENS_FILE = join(DATA_DIR, "tokens.json");
const USAGE_FILE = join(DATA_DIR, "usage.json");

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
}

const DEFAULT_PRESETS: Presets = {
  smart: ["kimi", "minimax", "copilot", "qwen"],
  fast: ["qwen", "copilot", "kimi"],
  cheap: ["qwen", "kimi", "minimax"],
};

function loadConfig(): Config {
  if (existsSync(CONFIG_FILE)) {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
    if (!Array.isArray(cfg.disabled)) cfg.disabled = [];
    // a config written by an older build can name providers that no longer ship,
    // which would leave a preset resolving to an empty chain
    const known = new Set(PROVIDERS.map((p) => p.id));
    cfg.presets ??= {} as Presets;
    for (const name of Object.keys(DEFAULT_PRESETS) as (keyof Presets)[]) {
      const kept = (cfg.presets[name] ?? []).filter((id) => known.has(id));
      cfg.presets[name] = kept.length ? kept : DEFAULT_PRESETS[name];
    }
    return cfg;
  }
  const cfg: Config = {
    gatewayKey: `lp-${randomBytes(16).toString("hex")}`,
    port: 8787,
    deviceId: randomBytes(16).toString("hex"),
    disabled: [],
    presets: DEFAULT_PRESETS,
  };
  writeJson(CONFIG_FILE, cfg);
  return cfg;
}

const saveConfig = (cfg: Config) => writeJson(CONFIG_FILE, cfg);
const loadTokens = () => readJson<Record<string, TokenSet>>(TOKENS_FILE, {});

/** Keyless providers are always connected: they get a placeholder entry here rather
 *  than on disk, so nothing can revoke or expire. */
function tokenStore(): Record<string, TokenSet> {
  const all = loadTokens();
  for (const p of PROVIDERS) if (p.login === "none" && !all[p.id]) all[p.id] = { provider: p.id, accessToken: "keyless", authMode: "oauth" };
  return all;
}

function saveToken(token: TokenSet) {
  const all = loadTokens();
  all[token.provider] = token;
  writeJson(TOKENS_FILE, all);
}

function clearToken(provider: string) {
  const all = loadTokens();
  delete all[provider];
  writeJson(TOKENS_FILE, all);
}

const emptyRow = (): UsageRow => ({ requests: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: 0 });

function recordUsage(provider: string, ok: boolean, inputTokens: number, outputTokens: number) {
  const all = readJson<Record<string, UsageRow>>(USAGE_FILE, {});
  const row = all[provider] ?? emptyRow();
  row.requests += 1;
  row[ok ? "ok" : "failed"] += 1;
  row.inputTokens += inputTokens;
  row.outputTokens += outputTokens;
  row.lastUsedAt = Date.now();
  all[provider] = row;
  writeJson(USAGE_FILE, all);
}

// --------------------------------------------------------------------------- brand marks

// Full-colour brand marks, inlined so the file stays a single copy-pasteable script.
// Each entry is a complete <svg> document; the dashboard drops it on a black tile.
const QODER_PNG = "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";
const POLLINATIONS_PNG = "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";
const MARKS: Record<string, string> = {
  kimi: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"> <path d=\"M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z\" fill=\"#1783FF\"/> <path d=\"M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z\" fill=\"#fff\"/> </svg>",
  qwen: "<svg fill=\"#ffff\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z\"></path></svg>",
  minimax: "<svg fill=\"#E73562\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997\"/></svg>",
  copilot: "<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M17.533 1.829A2.528 2.528 0 0015.11 0h-.737a2.531 2.531 0 00-2.484 2.087l-1.263 6.937.314-1.08a2.528 2.528 0 012.424-1.833h4.284l1.797.706 1.731-.706h-.505a2.528 2.528 0 01-2.423-1.829l-.715-2.453z\" fill=\"url(#lobe-icons-copilot-0-_R_0_)\" transform=\"translate(0 1)\"></path><path d=\"M6.726 20.16A2.528 2.528 0 009.152 22h1.566c1.37 0 2.49-1.1 2.525-2.48l.17-6.69-.357 1.228a2.528 2.528 0 01-2.423 1.83h-4.32l-1.54-.842-1.667.843h.497c1.124 0 2.113.75 2.426 1.84l.697 2.432z\" fill=\"url(#lobe-icons-copilot-1-_R_0_)\" transform=\"translate(0 1)\"></path><path d=\"M15 0H6.252c-2.5 0-4 3.331-5 6.662-1.184 3.947-2.734 9.225 1.75 9.225H6.78c1.13 0 2.12-.753 2.43-1.847.657-2.317 1.809-6.359 2.713-9.436.46-1.563.842-2.906 1.43-3.742A1.97 1.97 0 0115 0\" fill=\"url(#lobe-icons-copilot-2-_R_0_)\" transform=\"translate(0 1)\"></path><path d=\"M15 0H6.252c-2.5 0-4 3.331-5 6.662-1.184 3.947-2.734 9.225 1.75 9.225H6.78c1.13 0 2.12-.753 2.43-1.847.657-2.317 1.809-6.359 2.713-9.436.46-1.563.842-2.906 1.43-3.742A1.97 1.97 0 0115 0\" fill=\"url(#lobe-icons-copilot-3-_R_0_)\" transform=\"translate(0 1)\"></path><path d=\"M9 22h8.749c2.5 0 4-3.332 5-6.663 1.184-3.948 2.734-9.227-1.75-9.227H17.22c-1.129 0-2.12.754-2.43 1.848a1149.2 1149.2 0 01-2.713 9.437c-.46 1.564-.842 2.907-1.43 3.743A1.97 1.97 0 019 22\" fill=\"url(#lobe-icons-copilot-4-_R_0_)\" transform=\"translate(0 1)\"></path><path d=\"M9 22h8.749c2.5 0 4-3.332 5-6.663 1.184-3.948 2.734-9.227-1.75-9.227H17.22c-1.129 0-2.12.754-2.43 1.848a1149.2 1149.2 0 01-2.713 9.437c-.46 1.564-.842 2.907-1.43 3.743A1.97 1.97 0 019 22\" fill=\"url(#lobe-icons-copilot-5-_R_0_)\" transform=\"translate(0 1)\"></path><defs><radialGradient cx=\"85.44%\" cy=\"100.653%\" fx=\"85.44%\" fy=\"100.653%\" gradientTransform=\"scale(-.8553 -1) rotate(50.927 2.041 -1.946)\" id=\"lobe-icons-copilot-0-_R_0_\" r=\"105.116%\"><stop offset=\"9.6%\" stop-color=\"#00AEFF\"></stop><stop offset=\"77.3%\" stop-color=\"#2253CE\"></stop><stop offset=\"100%\" stop-color=\"#0736C4\"></stop></radialGradient><radialGradient cx=\"18.143%\" cy=\"32.928%\" fx=\"18.143%\" fy=\"32.928%\" gradientTransform=\"scale(.8897 1) rotate(52.069 .193 .352)\" id=\"lobe-icons-copilot-1-_R_0_\" r=\"95.612%\"><stop offset=\"0%\" stop-color=\"#FFB657\"></stop><stop offset=\"63.4%\" stop-color=\"#FF5F3D\"></stop><stop offset=\"92.3%\" stop-color=\"#C02B3C\"></stop></radialGradient><radialGradient cx=\"82.987%\" cy=\"-9.792%\" fx=\"82.987%\" fy=\"-9.792%\" gradientTransform=\"scale(-1 -.9441) rotate(-70.872 .142 1.17)\" id=\"lobe-icons-copilot-4-_R_0_\" r=\"140.622%\"><stop offset=\"6.6%\" stop-color=\"#8C48FF\"></stop><stop offset=\"50%\" stop-color=\"#F2598A\"></stop><stop offset=\"89.6%\" stop-color=\"#FFB152\"></stop></radialGradient><linearGradient id=\"lobe-icons-copilot-2-_R_0_\" x1=\"39.465%\" x2=\"46.884%\" y1=\"12.117%\" y2=\"103.774%\"><stop offset=\"15.6%\" stop-color=\"#0D91E1\"></stop><stop offset=\"48.7%\" stop-color=\"#52B471\"></stop><stop offset=\"65.2%\" stop-color=\"#98BD42\"></stop><stop offset=\"93.7%\" stop-color=\"#FFC800\"></stop></linearGradient><linearGradient id=\"lobe-icons-copilot-3-_R_0_\" x1=\"45.949%\" x2=\"50%\" y1=\"0%\" y2=\"100%\"><stop offset=\"0%\" stop-color=\"#3DCBFF\"></stop><stop offset=\"24.7%\" stop-color=\"#0588F7\" stop-opacity=\"0\"></stop></linearGradient><linearGradient id=\"lobe-icons-copilot-5-_R_0_\" x1=\"83.507%\" x2=\"83.453%\" y1=\"-6.106%\" y2=\"21.131%\"><stop offset=\"5.8%\" stop-color=\"#F8ADFA\"></stop><stop offset=\"70.8%\" stop-color=\"#A86EDD\" stop-opacity=\"0\"></stop></linearGradient></defs></svg>",
  claude: "<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z\" fill=\"#D97757\" fill-rule=\"nonzero\"></path></svg>",
  kiro: "<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M18.8 0H5.2A5.2 5.2 0 000 5.2v13.6A5.2 5.2 0 005.2 24h13.6a5.2 5.2 0 005.2-5.2V5.2A5.2 5.2 0 0018.8 0z\" fill=\"#9046FF\"></path><path d=\"M7.97 16.376c-1.644 3.642 1.86 4.556 4.443 2.424.76 2.39 3.608.607 4.631-1.247 2.251-4.084 1.342-8.249 1.108-9.108-1.6-5.859-9.6-5.869-10.976.03-.323 1.033-.328 2.206-.507 3.423-.09.617-.16 1.009-.393 1.655-.139.373-.323.7-.62 1.257-.458.865-.264 2.53 2.101 1.665l.224-.1h-.01l-.001.001z\" fill=\"#fff\"></path><path d=\"M12.722 10.985c-.656 0-.755-.785-.755-1.252 0-.423.074-.756.218-.97a.61.61 0 01.537-.283c.229 0 .428.095.567.289.159.218.243.55.243.964 0 .785-.303 1.252-.805 1.252h-.005zm2.703 0c-.656 0-.755-.785-.755-1.252 0-.423.074-.756.219-.97a.61.61 0 01.536-.283c.229 0 .428.095.567.289.159.218.243.55.243.964 0 .785-.303 1.252-.805 1.252h-.005z\" fill=\"#000\"></path></svg>",
  tencent: "<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M9.976 1L24 9.8l-10.587.015L10.723 23H5.489L8.18 9.8H3.244L1 5.4h8.077L9.976 1z\" fill=\"#0052D9\"></path></svg>",
  codex: "<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z\" fill=\"#fff\"></path><path d=\"M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z\" fill=\"url(#lp-codex)\"></path><defs><linearGradient gradientUnits=\"userSpaceOnUse\" id=\"lp-codex\" x1=\"12\" x2=\"12\" y1=\"3\" y2=\"21\"><stop stop-color=\"#B1A7FF\"></stop><stop offset=\".5\" stop-color=\"#7A9DFF\"></stop><stop offset=\"1\" stop-color=\"#3941FF\"></stop></linearGradient></defs></svg>",
  grok: "<svg viewBox=\"0 0 1024 1024\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M395.479 633.828L735.91 381.105C752.599 368.715 776.454 373.548 784.406 392.792C826.26 494.285 807.561 616.253 724.288 699.996C641.016 783.739 525.151 802.104 419.247 760.277L303.556 814.143C469.49 928.202 670.987 899.995 796.901 773.282C896.776 672.843 927.708 535.937 898.785 412.476L899.047 412.739C857.105 231.37 909.358 158.874 1016.4 10.6326C1018.93 7.11771 1021.47 3.60279 1024 0L883.144 141.651V141.212L395.392 633.916\" fill=\"white\"/><path d=\"M325.226 695.251C206.128 580.84 226.662 403.776 328.285 301.668C403.431 226.097 526.549 195.254 634.026 240.596L749.454 186.994C728.657 171.88 702.007 155.623 671.424 144.2C533.19 86.9942 367.693 115.465 255.323 228.382C147.234 337.081 113.244 504.215 171.613 646.833C215.216 753.423 143.739 828.818 71.7385 904.916C46.2237 931.893 20.6216 958.87 0 987.429L325.139 695.339\" fill=\"white\"/></svg>",
  gitlab: "<svg viewBox=\"0 0 100 100\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M50 88 8 57l10-32c1-4 6-4 7 0l7 20h36l7-20c1-4 6-4 7 0l10 32z\" fill=\"#FC6D26\"/><path d=\"M50 88 25 45h50z\" fill=\"#E24329\"/><path d=\"M8 57 25 45 50 88z\" fill=\"#FCA326\"/><path d=\"M92 57 75 45 50 88z\" fill=\"#FCA326\"/><path d=\"M18 25 25 45 8 57z\" fill=\"#E24329\"/><path d=\"M82 25 75 45 92 57z\" fill=\"#E24329\"/></svg>",
  huggingface: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"> <title>HuggingFace</title> <path d=\"M2.25 11.535c0-3.407 1.847-6.554 4.844-8.258a9.822 9.822 0 019.687 0c2.997 1.704 4.844 4.851 4.844 8.258 0 5.266-4.337 9.535-9.687 9.535S2.25 16.8 2.25 11.535z\" fill=\"#FF9D0B\" /> <path d=\"M11.938 20.086c4.797 0 8.687-3.829 8.687-8.551 0-4.722-3.89-8.55-8.687-8.55-4.798 0-8.688 3.828-8.688 8.55 0 4.722 3.89 8.55 8.688 8.55z\" fill=\"#FFD21E\" /> <path d=\"M11.875 15.113c2.457 0 3.25-2.156 3.25-3.263 0-.576-.393-.394-1.023-.089-.582.283-1.365.675-2.224.675-1.798 0-3.25-1.693-3.25-.586 0 1.107.79 3.263 3.25 3.263h-.003z\" fill=\"#FF323D\" /> <path d=\"M14.76 9.21c.32.108.445.753.767.585.447-.233.707-.708.659-1.204a1.235 1.235 0 00-.879-1.059 1.262 1.262 0 00-1.33.394c-.322.384-.377.92-.14 1.36.153.283.638-.177.925-.079l-.002.003zm-5.887 0c-.32.108-.448.753-.768.585a1.226 1.226 0 01-.658-1.204c.048-.495.395-.913.878-1.059a1.262 1.262 0 011.33.394c.322.384.377.92.14 1.36-.152.283-.64-.177-.925-.079l.003.003zm1.12 5.34a2.166 2.166 0 011.325-1.106c.07-.02.144.06.219.171l.192.306c.069.1.139.175.209.175.074 0 .15-.074.223-.172l.205-.302c.08-.11.157-.188.234-.165.537.168.986.536 1.25 1.026.932-.724 1.275-1.905 1.275-2.633 0-.508-.306-.426-.81-.19l-.616.296c-.52.24-1.148.48-1.824.48-.676 0-1.302-.24-1.823-.48l-.589-.283c-.52-.248-.838-.342-.838.177 0 .703.32 1.831 1.187 2.56l.18.14z\" fill=\"#3A3B45\" /> <path d=\"M17.812 10.366a.806.806 0 00.813-.8c0-.441-.364-.8-.813-.8a.806.806 0 00-.812.8c0 .442.364.8.812.8zm-11.624 0a.806.806 0 00.812-.8c0-.441-.364-.8-.812-.8a.806.806 0 00-.813.8c0 .442.364.8.813.8zM4.515 13.073c-.405 0-.765.162-1.017.46a1.455 1.455 0 00-.333.925 1.801 1.801 0 00-.485-.074c-.387 0-.737.146-.985.409a1.41 1.41 0 00-.2 1.722 1.302 1.302 0 00-.447.694c-.06.222-.12.69.2 1.166a1.267 1.267 0 00-.093 1.236c.238.533.81.958 1.89 1.405l.24.096c.768.3 1.473.492 1.478.494.89.243 1.808.375 2.732.394 1.465 0 2.513-.443 3.115-1.314.93-1.342.842-2.575-.274-3.763l-.151-.154c-.692-.684-1.155-1.69-1.25-1.912-.195-.655-.71-1.383-1.562-1.383-.46.007-.889.233-1.15.605-.25-.31-.495-.553-.715-.694a1.87 1.87 0 00-.993-.312zm14.97 0c.405 0 .767.162 1.017.46.216.262.333.588.333.925.158-.047.322-.071.487-.074.388 0 .738.146.985.409a1.41 1.41 0 01.2 1.722c.22.178.377.422.445.694.06.222.12.69-.2 1.166.244.37.279.836.093 1.236-.238.533-.81.958-1.889 1.405l-.239.096c-.77.3-1.475.492-1.48.494-.89.243-1.808.375-2.732.394-1.465 0-2.513-.443-3.115-1.314-.93-1.342-.842-2.575.274-3.763l.151-.154c.695-.684 1.157-1.69 1.252-1.912.195-.655.708-1.383 1.56-1.383.46.007.889.233 1.15.605.25-.31.495-.553.718-.694.244-.162.523-.265.814-.3l.176-.012z\" fill=\"#FF9D0B\" /> <path d=\"M9.785 20.132c.688-.994.638-1.74-.305-2.667-.945-.928-1.495-2.288-1.495-2.288s-.205-.788-.672-.714c-.468.074-.81 1.25.17 1.971.977.721-.195 1.21-.573.534-.375-.677-1.405-2.416-1.94-2.751-.532-.332-.907-.148-.782.541.125.687 2.357 2.35 2.14 2.707-.218.362-.983-.42-.983-.42S2.953 14.9 2.43 15.46c-.52.558.398 1.026 1.7 1.803 1.308.778 1.41.985 1.225 1.28-.187.295-3.07-2.1-3.34-1.083-.27 1.011 2.943 1.304 2.745 2.006-.2.7-2.265-1.324-2.685-.537-.425.79 2.913 1.718 2.94 1.725 1.075.276 3.813.859 4.77-.522zm4.432 0c-.687-.994-.64-1.74.305-2.667.943-.928 1.493-2.288 1.493-2.288s.205-.788.675-.714c.465.074.807 1.25-.17 1.971-.98.721.195 1.21.57.534.377-.677 1.407-2.416 1.94-2.751.532-.332.91-.148.782.541-.125.687-2.355 2.35-2.137 2.707.215.362.98-.42.98-.42S21.05 14.9 21.57 15.46c.52.558-.395 1.026-1.7 1.803-1.308.778-1.408.985-1.225 1.28.187.295 3.07-2.1 3.34-1.083.27 1.011-2.94 1.304-2.743 2.006.2.7 2.263-1.324 2.685-.537.423.79-2.912 1.718-2.94 1.725-1.077.276-3.815.859-4.77-.522z\" fill=\"#FFD21E\" /> </svg>",
  cursor: "<svg viewBox=\"0 0 466.73 532.09\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z\" fill=\"#edecec\"/></svg>",
  doubao: "<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M5.31 15.756c.172-3.75 1.883-5.999 2.549-6.739-3.26 2.058-5.425 5.658-6.358 8.308v1.12C1.501 21.513 4.226 24 7.59 24a6.59 6.59 0 002.2-.375c.353-.12.7-.248 1.039-.378.913-.899 1.65-1.91 2.243-2.992-4.877 2.431-7.974.072-7.763-4.5l.002.001z\" fill=\"#1E37FC\"/><path d=\"M22.57 10.283c-1.212-.901-4.109-2.404-7.397-2.8.295 3.792.093 8.766-2.1 12.773a12.782 12.782 0 01-2.244 2.992c3.764-1.448 6.746-3.457 8.596-5.219 2.82-2.683 3.353-5.178 3.361-6.66a2.737 2.737 0 00-.216-1.084v-.002z\" fill=\"#37E1BE\"/><path d=\"M14.303 1.867C12.955.7 11.248 0 9.39 0 7.532 0 5.883.677 4.545 1.807 2.791 3.29 1.627 5.557 1.5 8.125v9.201c.932-2.65 3.097-6.25 6.357-8.307.5-.318 1.025-.595 1.569-.829 1.883-.801 3.878-.932 5.746-.706-.222-2.83-.718-5.002-.87-5.617h.001z\" fill=\"#A569FF\"/><path d=\"M17.305 4.961a199.47 199.47 0 01-1.08-1.094c-.202-.213-.398-.419-.586-.622l-1.333-1.378c.151.615.648 2.786.869 5.617 3.288.395 6.185 1.898 7.396 2.8-1.306-1.275-3.475-3.487-5.266-5.323z\" fill=\"#1E37FC\"/></svg>",
  zai: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><rect width=\"64\" height=\"64\" rx=\"10\" fill=\"#303030\"></rect><path d=\"M10 13H52V22L25 42H52V51H10V42L37 22H10Z\" fill=\"#FFFFFF\"></path></svg>",
  innerai: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\"><defs><linearGradient id=\"lp-inner-g\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#62ffdb\"></stop><stop offset=\"24%\" stop-color=\"#13d8d0\"></stop><stop offset=\"48%\" stop-color=\"#087fe9\"></stop><stop offset=\"68%\" stop-color=\"#1538f5\"></stop><stop offset=\"85%\" stop-color=\"#8127ff\"></stop><stop offset=\"100%\" stop-color=\"#ed55ff\"></stop></linearGradient><radialGradient id=\"lp-inner-light\" cx=\"20%\" cy=\"8%\" r=\"95%\"><stop offset=\"0%\" stop-color=\"#a0ffe6\" stop-opacity=\".55\"></stop><stop offset=\"48%\" stop-color=\"#16c8ff\" stop-opacity=\".08\"></stop><stop offset=\"100%\" stop-color=\"#000044\" stop-opacity=\".22\"></stop></radialGradient></defs><rect width=\"256\" height=\"256\" rx=\"0\" fill=\"#080a10\"></rect><rect x=\"27\" y=\"27\" width=\"202\" height=\"202\" rx=\"48\" fill=\"url(#lp-inner-g)\"></rect><rect x=\"27\" y=\"27\" width=\"202\" height=\"202\" rx=\"48\" fill=\"url(#lp-inner-light)\"></rect></svg>",
  perplexity:
    "<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M22.3977 7.0896h-2.3106V.0676l-7.5094 6.3542V.1577h-1.1554v6.1966L4.4904 0v7.0896H1.6023v10.3976h2.8882V24l6.932-6.3591v6.2005h1.1554v-6.0469l6.9318 6.1807v-6.4879h2.8882V7.0896zm-3.4657-4.531v4.531h-5.355l5.355-4.531zm-13.2862.0676 4.8691 4.4634H5.6458V2.6262zM2.7576 16.332V8.245h7.8476l-6.1149 6.1147v1.9723H2.7576zm2.8882 5.0404v-3.8852h.0001v-2.6488l5.7763-5.7764v7.0111l-5.7764 5.2993zm12.7086.0248-5.7766-5.1509V9.0618l5.7766 5.7766v6.5588zm2.8882-5.0652h-1.733v-1.9723L13.3948 8.245h7.8478v8.087z\" fill=\"#20808D\"/></svg>",
  zenmux: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"160\" height=\"160\" xmlns=\"http://www.w3.org/2000/svg\" fill=\"none\"><path fill=\"#f8fafc\" d=\"M77.776.421c8.25-.317 24.947.775 38.304 12.768 10.957 9.839 14.733 28.078 12.18 42.221-2.341 12.965-7.858 23.572-5.696 33.394 2.16 9.821 7.658 14.663 12.334 16.696 4.519 1.965 8.886 1.375 8.055 5.108-.832 3.732-6.482 5.107-10.608 5.107-2.262 0-9.103-.59-12.139-2.554-3.587-2.322-4.386-4.402-5.752-6.074-.231-.284-.64-.087-.586.276.622 4.113 2.338 11.094 5.12 15.423 2.252 3.503 3.183 6.058 8.341 10.38 5.16 4.32 7.57 8.249 2.553 11.031-4.456 2.471-14.142-2.585-19.839-8.839-5.127-5.629-8.697-12.572-10.108-17.09-.755-2.415-1.511-6.57-2.266-9.969-.1-.446-.711-.374-.725.084-.25 8.649-1.61 16.909-3.598 25.764-1.43 6.375-4.91 14.143-8.053 18.857-3.833 5.749-9.522 7.543-13.75 5.971-3.382-1.257-.983-5.531 0-9.232.982-3.7 2.947-11.439 4.27-19.918 1.197-7.674 1.514-15.271.981-22.47-.033-.439-.708-.506-.844-.087-1.102 3.376-3.18 8.972-4.696 12.376-3.162 7.099-5.501 10.214-11.983 17.677-5.83 6.714-22.597 16.207-24.75 6.876-.59-2.553 2.498-3.671 5.345-5.893 4.28-3.339 7.857-9.264 11.248-16.5 3.045-6.497 4.592-12.782 4.83-16.794.022-.387-.464-.533-.682-.213-1.41 2.067-3.485 4.865-5.771 7.185-3.819 3.877-8.054 7.867-12.966 9.822-7.897 3.143-15.95.982-15.361-4.714.492-4.758 5.804-3.773 12.416-10.987 6.482-7.072 8.643-12.573 9.035-18.662.314-4.872-4.451-16.434-6.874-21.607-3.863-8.25-6.718-31.665 4.91-46.75C55.188.226 72.67.617 77.777.42zM55.101 33.397c-5.408 0-8.112 4.151-8.112 9.272 0 5.12 3.004 9.271 8.112 9.271 5.108 0 8.113-4.15 8.113-9.271 0-5.12-2.705-9.272-8.113-9.272zm44.04 0c-5.408 0-8.112 4.151-8.113 9.272 0 5.12 3.005 9.271 8.113 9.271s8.113-4.15 8.113-9.271c0-5.12-2.705-9.272-8.113-9.272z\" clip-rule=\"evenodd\" fill-rule=\"evenodd\"/></svg>",
  adapta: "<svg width=\"512\" height=\"512\" viewBox=\"0 0 512 512\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"512\" height=\"512\" rx=\"140\" fill=\"#141414\"/><path d=\"M146.969 421.164L241.631 421.29H266.602C270.195 421.315 273.536 419.408 275.32 416.27L295.167 381.762C298.734 375.563 298.734 367.909 295.167 361.735L282.304 339.474C280.52 336.362 277.204 334.455 273.612 334.455L226.105 334.354C225.854 334.354 225.628 334.304 225.377 334.304H201.686C201.611 334.304 201.51 334.304 201.435 334.304L76.2495 334.429C72.657 334.429 69.3659 336.337 67.5571 339.449L54.6944 361.71C51.1019 367.909 51.1019 375.538 54.6944 381.737L74.5412 416.245C76.3248 419.357 79.6661 421.29 83.2587 421.29H108.23L146.969 421.114V421.164Z\" fill=\"white\"/><path d=\"M308.212 313.38L367.878 416.98C369.687 420.092 373.003 422.025 376.596 422L416.44 421.924C423.599 421.924 430.207 418.085 433.799 411.886L446.662 389.625C448.446 386.513 448.446 382.698 446.662 379.611L422.997 338.477C422.896 338.251 422.796 338.025 422.67 337.825L413.902 322.666L410.837 317.346C410.837 317.346 410.737 317.22 410.687 317.145L347.981 208.902C346.172 205.815 342.881 203.907 339.289 203.907H313.563C306.403 203.907 299.771 207.722 296.178 213.896L276.181 248.304C274.372 251.416 274.372 255.256 276.181 258.368L288.692 279.976L308.187 313.43L308.212 313.38Z\" fill=\"white\"/><path d=\"M244.275 229.91L304.242 126.46C306.051 123.348 306.051 119.509 304.242 116.396L284.245 81.9886C280.652 75.8147 274.045 72 266.86 72H241.135C237.542 72 234.251 73.9074 232.442 76.9943L208.601 118.053C208.475 118.253 208.325 118.454 208.199 118.655L199.431 133.839L196.341 139.16C196.341 139.16 196.266 139.31 196.241 139.385L133.761 247.754C131.977 250.866 131.977 254.681 133.761 257.768L146.624 280.029C150.216 286.227 156.824 290.042 163.984 290.068L203.828 290.143C207.42 290.143 210.762 288.235 212.57 285.123L225.031 263.49L244.275 229.91Z\" fill=\"white\"/></svg>",
  hyperagent: "<svg width=\"512\" height=\"512\" viewBox=\"-3 -3 28 28\" shape-rendering=\"geometricPrecision\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path fill=\"#f8fafc\" d=\"M16.4805 0C19.2192 0.000148464 21.4403 2.22119 21.4404 4.95996C21.4404 7.69884 19.2193 9.91977 16.4805 9.91992C12.8578 9.91992 9.91992 12.8578 9.91992 16.4805C9.91977 19.2193 7.69884 21.4404 4.95996 21.4404C2.22119 21.4403 0.000148466 19.2192 0 16.4805C0 13.7416 2.2211 11.5206 4.95996 11.5205C8.58259 11.5205 11.5205 8.58259 11.5205 4.95996C11.5206 2.2211 13.7416 0 16.4805 0ZM16.5098 11.5C19.249 11.5 21.4695 13.7208 21.4697 16.46C21.4697 19.1993 19.2491 21.4199 16.5098 21.4199C13.7705 21.4198 11.5498 19.1992 11.5498 16.46C11.55 13.7209 13.7707 11.5001 16.5098 11.5ZM4.95996 0C7.69922 0 9.9198 2.22074 9.91992 4.95996C9.91992 7.69929 7.69929 9.91992 4.95996 9.91992C2.22074 9.9198 0 7.69922 0 4.95996C0.000126519 2.22081 2.22081 0.000126521 4.95996 0Z\"/></svg>",
  pollinations: `<img src="data:image/png;base64,${POLLINATIONS_PNG}" alt="">`,
  qoder: `<img src="data:image/png;base64,${QODER_PNG}" alt="">`,
};

// --------------------------------------------------------------------------- providers

const REAL_PROVIDERS: ProviderDef[] = [
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    color: "#10b981",
    logo: MARKS.kimi ?? null,
    monogram: "K",
    login: "device",
    trust: "official",
    group: "Device code",
    inference: { baseUrl: "https://api.kimi.com/coding/v1", format: "openai", headers: { "user-agent": "KimiCLI/1.5" } },
    models: [
      { id: "kimi-for-coding", label: "Kimi for Coding" },
      { id: "kimi-k2.6", label: "Kimi K2.6" },
      { id: "kimi-k2-thinking", label: "Kimi K2 Thinking" },
    ],
  },
  {
    id: "qwen",
    label: "Qwen Cloud",
    color: "#e11d48",
    logo: MARKS.qwen ?? null,
    monogram: "Q",
    login: "paste",
    trust: "official",
    group: "Browser login",
    hint: "Qwen retired the CLI device login (its token endpoint is now blocked outside a browser), so there is no account link any more. Paste an API key from docs.qwencloud.com/developer-guides/administration/api-keys instead. Token Plan keys (sk-sp-) need LAZYPATH_QWEN_BASE.",
    inference: {
      baseUrl: process.env.LAZYPATH_QWEN_BASE ?? "https://maas.qwencloudapi.com/compatible-mode/v1",
      format: "openai",
    },
    models: [
      { id: "qwen3.8-flash", label: "Qwen3.8 Flash" },
      { id: "qwen3.8-max", label: "Qwen3.8 Max" },
      { id: "qwen3.7-plus", label: "Qwen3.7 Plus" },
    ],
  },
  {
    id: "minimax",
    label: "MiniMax",
    color: "#f97316",
    logo: MARKS.minimax ?? null,
    monogram: "M",
    login: "paste",
    trust: "official",
    group: "Browser login",
    hint: "MiniMax removed the device login that the community CLI flow used (api.minimax.io/oauth/code is gone), so there is no account link any more. Paste an API key from platform.minimax.io > Account Settings > API Keys. The browser product at agent.minimax.io is an agent, not a chat API, so it cannot be driven with a cookie.",
    inference: { baseUrl: "https://api.minimax.io/anthropic", format: "anthropic" },
    models: [
      { id: "MiniMax-M3", label: "MiniMax M3" },
      { id: "MiniMax-M2.7", label: "MiniMax M2.7" },
    ],
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    color: "#6e40c9",
    logo: MARKS.copilot ?? null,
    monogram: "G",
    login: "device",
    trust: "official",
    group: "Device code",
    inference: { baseUrl: "https://api.github.com/copilot", format: "openai" },
    models: [
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    ],
  },
  {
    id: "anthropic",
    label: "Claude (browser login)",
    color: "#d97757",
    logo: MARKS.claude ?? null,
    monogram: "C",
    login: "paste",
    trust: "tosrisk",
    group: "Browser login",
    inference: { baseUrl: "https://api.anthropic.com", format: "anthropic" },
    models: [{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" }],
  },
  {
    id: "kiro",
    label: "Kiro (AWS)",
    color: "#9046ff",
    logo: MARKS.kiro ?? null,
    monogram: "K",
    login: "device",
    trust: "official",
    group: "Device code",
    inference: { baseUrl: "https://codewhisperer.us-east-1.amazonaws.com", format: "kiro" },
    models: [
      { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
      { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
      { id: "deepseek-3.2", label: "DeepSeek 3.2" },
      { id: "glm-5", label: "GLM-5" },
      { id: "minimax-m2.5", label: "MiniMax M2.5" },
      { id: "qwen3-coder-next", label: "Qwen3 Coder Next" },
    ],
  },
  {
    id: "tencent",
    label: "Tencent CodeBuddy",
    color: "#0052d9",
    logo: MARKS.tencent ?? null,
    monogram: "T",
    login: "device",
    trust: "official",
    group: "Browser login",
    inference: {
      baseUrl: `${process.env.LAZYPATH_TENCENT_BASE ?? "https://copilot.tencent.com"}/v2`,
      format: "openai",
      headers: { "user-agent": "CLI/2.108.1 CodeBuddy/2.108.1", "x-product": "SaaS", "x-codebuddy-request": "1" },
    },
    models: [
      { id: "glm-5.2", label: "GLM-5.2" },
      { id: "kimi-k2.7", label: "Kimi K2.7" },
      { id: "minimax-m3", label: "MiniMax M3" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "hy3", label: "Hunyuan 3" },
    ],
  },
  {
    id: "qoder",
    label: "Qoder",
    color: "#00b96b",
    logo: MARKS.qoder ?? null,
    monogram: "Q",
    login: "paste",
    trust: "community",
    group: "Browser login",
    inference: { baseUrl: "https://api.qoder.com/v1", format: "openai" },
    models: [
      { id: "qwen3.7-max", label: "Qwen3.7 Max" },
      { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
      { id: "glm-5.2", label: "GLM-5.2" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "minimax-m3", label: "MiniMax M3" },
    ],
  },
  {
    id: "codex",
    label: "ChatGPT (Codex)",
    color: "#7a9dff",
    logo: MARKS.codex ?? null,
    monogram: "O",
    login: "device",
    trust: "official",
    group: "Device code",
    inference: {
      baseUrl: "https://chatgpt.com/backend-api/codex",
      format: "responses",
      headers: { originator: "codex_cli_rs", version: "0.46.0" },
    },
    models: [
      { id: "gpt-6-astra", label: "GPT 6 Astra" },
      { id: "gpt-6-astra-high", label: "GPT 6 Astra High" },
      { id: "gpt-5.6-sol", label: "GPT 5.6 Sol" },
    ],
  },
  {
    id: "grok",
    label: "Grok (xAI)",
    color: "#f7f9f9",
    logo: MARKS.grok ?? null,
    monogram: "X",
    login: "device",
    trust: "official",
    group: "Device code",
    inference: {
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      format: "responses",
      headers: {
        "x-grok-client-version": "0.2.106",
        "x-grok-client-identifier": "grok-shell",
        "x-grok-client-mode": "headless",
        "x-xai-token-auth": "xai-grok-cli",
        "user-agent": "grok-shell/0.2.106 (windows; x86_64)",
      },
    },
    models: [
      { id: "grok-4.6", label: "Grok 4.6" },
      { id: "grok-4.5", label: "Grok 4.5" },
    ],
  },
  {
    id: "gitlab",
    label: "GitLab Duo",
    color: "#fc6d26",
    logo: MARKS.gitlab ?? null,
    monogram: "G",
    login: "paste",
    trust: "official",
    group: "Browser login",
    inference: { baseUrl: "https://gitlab.com/api/v4", path: "/code_suggestions/completions", format: "openai" },
    models: [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ],
  },
  {
    id: "huggingchat",
    label: "HuggingChat",
    color: "#ff9d00",
    logo: MARKS.huggingface ?? null,
    monogram: "H",
    login: "cookie",
    trust: "tosrisk",
    group: "Browser login",
    inference: { baseUrl: "https://huggingface.co/chat", format: "huggingchat" },
    site: "https://huggingface.co/chat",
    models: [
      { id: "moonshotai/Kimi-K3", label: "Kimi K3" },
      { id: "deepseek-ai/DeepSeek-V4.1-Flash", label: "DeepSeek V4.1 Flash" },
      { id: "zai-org/GLM-5.3", label: "GLM 5.3" },
      { id: "Qwen/Qwen3.8-27B", label: "Qwen3.8 27B" },
    ],
  },
  {
    id: "kimi-web",
    label: "Kimi (web)",
    color: "#1783ff",
    logo: MARKS.kimi ?? null,
    monogram: "K",
    login: "cookie",
    trust: "tosrisk",
    group: "Browser login",
    inference: {
      baseUrl: "https://www.kimi.ai",
      path: "/apiv2/kimi.gateway.chat.v1.ChatService/Chat",
      format: "kimiweb",
    },
    site: "https://www.kimi.ai",
    hint: "Sign in, then DevTools > Application > Local Storage > www.kimi.ai and copy the value of access_token. A Cookie header that contains access_token works too.",
    models: [
      { id: "k3", label: "Kimi K3" },
      { id: "k2d6", label: "Kimi K2.6" },
    ],
  },
  {
    id: "doubao",
    label: "Doubao (Dola)",
    color: "#1e37fc",
    logo: MARKS.doubao ?? null,
    monogram: "D",
    login: "cookie",
    trust: "tosrisk",
    group: "Browser login",
    inference: { baseUrl: "https://www.dola.com", path: "/chat/completion", format: "dola" },
    site: "https://www.dola.com",
    hint: "Sign in on dola.com, open DevTools > Network, copy the whole Cookie header of any request. It must contain sessionid and s_v_web_id.",
    models: [
      { id: "dola-speed", label: "Dola Speed" },
      { id: "dola-pro", label: "Dola Pro (deep think)" },
    ],
  },
  {
    id: "zai-web",
    label: "Z.ai (web)",
    color: "#303030",
    logo: MARKS.zai ?? null,
    monogram: "Z",
    login: "cookie",
    trust: "tosrisk",
    group: "Browser login",
    inference: { baseUrl: "https://chat.z.ai", format: "zaiweb" },
    site: "https://chat.z.ai",
    hint: "Sign in on chat.z.ai, open DevTools > Application > Local Storage, copy the value of token (a JWT). If Z.ai shows a captcha, paste the captcha_verify_param JSON field too.",
    models: [
      { id: "glm-5.3", label: "GLM 5.3" },
      { id: "glm-5.3-flash", label: "GLM 5.3 Flash" },
      { id: "glm-5.2", label: "GLM 5.2" },
    ],
  },
  {
    id: "inner-ai",
    label: "Inner AI",
    color: "#ed55ff",
    logo: MARKS.innerai ?? null,
    monogram: "I",
    login: "cookie",
    trust: "tosrisk",
    group: "Browser login",
    inference: { baseUrl: "https://chatapi.innerai.com", path: "/chat", format: "innerai" },
    site: "https://app.innerai.com",
    hint: "Sign in on app.innerai.com, open DevTools > Application > Cookies > .innerai.com, copy the value of token (a JWT). You can also append your email after a space.",
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o Mini" },
      { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
    ],
  },
  {
    id: "perplexity-web",
    label: "Perplexity (web)",
    color: "#20808d",
    logo: MARKS.perplexity ?? null,
    monogram: "P",
    login: "cookie",
    trust: "tosrisk",
    group: "Browser login",
    inference: { baseUrl: "https://www.perplexity.ai", path: "/rest/sse/perplexity_ask", format: "pplxweb" },
    site: "https://www.perplexity.ai/library",
    hint: "Sign in on perplexity.ai, open DevTools > Application > Cookies > https://www.perplexity.ai and copy the value of __Secure-next-auth.session-token. Pasting the whole Cookie header also works.",
    models: [
      { id: "pplx_pro", label: "Perplexity Pro" },
      { id: "turbo", label: "Sonar Turbo" },
      { id: "claude50sonnet", label: "Claude Sonnet 5" },
      { id: "claude50opus", label: "Claude Opus 5" },
      { id: "gpt56_sol", label: "GPT 5.6 Sol" },
      { id: "gemini37flash", label: "Gemini 3.7 Flash" },
    ],
  },
  {
    id: "claude-web",
    label: "Claude (web)",
    color: "#d97757",
    logo: MARKS.claude ?? null,
    monogram: "C",
    login: "cookie",
    trust: "tosrisk",
    group: "Browser login",
    inference: { baseUrl: "https://claude.ai", format: "claudeweb" },
    site: "https://claude.ai/new",
    hint: "Sign in on claude.ai, open DevTools > Application > Cookies > https://claude.ai and copy the value of sessionKey. Pasting the whole Cookie header also works.",
    models: [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ],
  },
  {
    id: "zenmux-free",
    label: "ZenMux (free tier)",
    color: "#60a5fa",
    logo: MARKS.zenmux ?? null,
    monogram: "Z",
    login: "cookie",
    trust: "tosrisk",
    group: "Browser login",
    inference: { baseUrl: "https://zenmux.ai", path: "/api/anthropic/v1/messages", format: "zenmux" },
    site: "https://zenmux.ai/platform/chat",
    hint: "Sign in on zenmux.ai, open DevTools > Network > any /api request > Request Headers, and copy the whole Cookie header. It has to contain ctoken.",
    models: [
      { id: "z-ai/glm-4.7-flash-free", label: "GLM 4.7 Flash Free" },
      { id: "z-ai/glm-4.6v-flash-free", label: "GLM 4.6V Flash Free" },
    ],
  },
  {
    id: "adapta-web",
    label: "Adapta (web)",
    color: "#a78bfa",
    logo: MARKS.adapta ?? null,
    monogram: "A",
    login: "cookie",
    trust: "tosrisk",
    group: "Browser login",
    inference: { baseUrl: "https://agent.adapta.one", path: "/api/chat/stream/v1", format: "adapta", authUrl: "https://clerk.agent.adapta.one" },
    site: "https://agent.adapta.one/agentic-chat",
    hint: "Sign in on agent.adapta.one, open DevTools > Application > Cookies > https://clerk.agent.adapta.one and copy the value of __client. Pasting the whole Cookie header also works.",
    models: [{ id: "one", label: "Adapta ONE (auto-routed)" }],
  },
  {
    id: "hyperagent-web",
    label: "Hyperagent (web)",
    color: "#f472b6",
    logo: MARKS.hyperagent ?? null,
    monogram: "H",
    login: "cookie",
    trust: "tosrisk",
    group: "Browser login",
    inference: { baseUrl: "https://hyperagent.com", format: "hyperagent" },
    site: "https://hyperagent.com/",
    hint: "Sign in on hyperagent.com, open DevTools > Network > reload > click the /api/threads request > Request Headers, and copy the whole Cookie header. The session cookie is HttpOnly, so document.cookie will not show it.",
    models: [
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
      { id: "claude-fable-5", label: "Claude Fable 5" },
    ],
  },
  {
    id: "pollinations",
    label: "Pollinations (keyless)",
    color: "#ff5ac8",
    logo: MARKS.pollinations ?? null,
    monogram: "P",
    login: "none",
    trust: "official",
    group: "No login",
    inference: { baseUrl: "https://text.pollinations.ai", path: "/openai", format: "openai" },
    site: "https://pollinations.ai",
    models: [
      { id: "openai-fast", label: "GPT-OSS (fast)" },
      { id: "openai", label: "GPT-OSS" },
    ],
  },
];

// Local stubs for the test harness only (LAZYPATH_MOCKS=1).
const MOCK_PROVIDERS: ProviderDef[] = [
  {
    id: "failmock",
    label: "Fail Mock",
    color: "#64748b",
    logo: null,
    monogram: "F",
    login: "device",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/fail", format: "openai" },
    models: [{ id: "mock-model", label: "Mock" }],
  },
  {
    id: "okmock",
    label: "OK Mock",
    color: "#8b5cf6",
    logo: null,
    monogram: "T",
    login: "device",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/ok", format: "openai" },
    models: [{ id: "mock-model", label: "Mock" }],
  },
  {
    id: "anthmock",
    label: "Anthropic Mock",
    color: "#a855f7",
    logo: null,
    monogram: "A",
    login: "device",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/anth", format: "anthropic" },
    models: [{ id: "mock-anth", label: "Mock Anthropic" }],
  },
  {
    id: "cookiemock",
    label: "Cookie Mock",
    color: "#f59e0b",
    logo: null,
    monogram: "C",
    login: "cookie",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/cookie", format: "huggingchat" },
    models: [{ id: "mock-cookie", label: "Mock Cookie" }],
  },
  {
    id: "kimimock",
    label: "Kimi Web Mock",
    color: "#1783ff",
    logo: null,
    monogram: "K",
    login: "cookie",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/kimiweb", format: "kimiweb" },
    models: [{ id: "k3", label: "K3" }],
  },
  {
    id: "dolamock",
    label: "Dola Mock",
    color: "#1e37fc",
    logo: null,
    monogram: "D",
    login: "cookie",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/dola", path: "", format: "dola" },
    models: [{ id: "dola-speed", label: "Dola Speed" }],
  },
  {
    id: "zaimock",
    label: "Z.ai Mock",
    color: "#303030",
    logo: null,
    monogram: "Z",
    login: "cookie",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/zai", format: "zaiweb" },
    models: [{ id: "glm-5.3", label: "GLM 5.3" }],
  },
  {
    id: "inneraimock",
    label: "Inner AI Mock",
    color: "#ed55ff",
    logo: null,
    monogram: "I",
    login: "cookie",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/innerai", path: "/chat", format: "innerai" },
    models: [{ id: "gpt-4o", label: "GPT-4o" }],
  },
  {
    id: "pplxmock",
    label: "Perplexity Mock",
    color: "#20808d",
    logo: null,
    monogram: "P",
    login: "cookie",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/pplx", path: "/rest/sse/perplexity_ask", format: "pplxweb" },
    models: [{ id: "pplx_pro", label: "Perplexity Pro" }],
  },
  {
    id: "claudemock",
    label: "Claude Web Mock",
    color: "#d97757",
    logo: null,
    monogram: "C",
    login: "cookie",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/claude", format: "claudeweb" },
    models: [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }],
  },
  {
    id: "zenmuxmock",
    label: "ZenMux Mock",
    color: "#60a5fa",
    logo: null,
    monogram: "Z",
    login: "cookie",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/zenmux", path: "", format: "zenmux" },
    models: [{ id: "glm-free", label: "GLM Free" }],
  },
  {
    id: "adaptamock",
    label: "Adapta Mock",
    color: "#a78bfa",
    logo: null,
    monogram: "A",
    login: "cookie",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/adapta", path: "/api/chat/stream/v1", format: "adapta", authUrl: "http://127.0.0.1:8788/adaptak" },
    models: [{ id: "one", label: "ONE" }],
  },
  {
    id: "hypermock",
    label: "Hyperagent Mock",
    color: "#f472b6",
    logo: null,
    monogram: "H",
    login: "cookie",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/hyper", format: "hyperagent" },
    models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }],
  },
  {
    id: "keymock",
    label: "Keyless Mock",
    color: "#ff5ac8",
    logo: null,
    monogram: "N",
    login: "none",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/keyless", path: "/chat/completions", format: "openai" },
    models: [{ id: "mock-keyless", label: "Keyless" }],
  },
  {
    id: "respmock",
    label: "Responses Mock",
    color: "#22d3ee",
    logo: null,
    monogram: "S",
    login: "device",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/resp", format: "responses" },
    models: [{ id: "mock-resp", label: "Mock Responses" }],
  },
  {
    id: "kiromock",
    label: "Kiro Mock",
    color: "#9046ff",
    logo: null,
    monogram: "R",
    login: "device",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/kiro", format: "kiro" },
    models: [{ id: "mock-kiro", label: "Mock Kiro" }],
  },
  {
    id: "devmock",
    label: "Device Login Mock",
    color: "#0ea5e9",
    logo: null,
    monogram: "V",
    login: "device",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/ok", format: "openai" },
    models: [{ id: "dev-model", label: "Dev Mock" }],
  },
  {
    id: "pastedmock",
    label: "Paste Login Mock",
    color: "#f43f5e",
    logo: null,
    monogram: "P",
    login: "paste",
    trust: "official",
    group: "Mocks",
    inference: { baseUrl: "http://127.0.0.1:8788/ok", format: "openai" },
    models: [{ id: "paste-model", label: "Paste Mock" }],
  },
];

const PROVIDERS: ProviderDef[] = process.env.LAZYPATH_MOCKS === "1" ? [...MOCK_PROVIDERS, ...REAL_PROVIDERS] : REAL_PROVIDERS;

const providerById = (id: string) => PROVIDERS.find((p) => p.id === id);

// --------------------------------------------------------------------------- login flows
// Every flow ends the same way: a TokenSet on disk. Nothing else in the app cares
// which of the two shapes a provider uses.

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function form(url: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
    body: new URLSearchParams(fields),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* providers sometimes answer form-encoded or HTML on errors */
  }
  if (res.status === 404 || (!res.ok && !body.error)) {
    // GitHub answers the device token endpoint form-encoded
    const parsed = Object.fromEntries(new URLSearchParams(text).entries());
    if (parsed.access_token) body = parsed;
  }
  return { ok: res.ok, status: res.status, body, text };
}

const TENCENT_BASE = process.env.LAZYPATH_TENCENT_BASE ?? "https://copilot.tencent.com";
const CODEBUDDY_UA = "CLI/2.108.1 CodeBuddy/2.108.1";

async function jsonPost(url: string, value: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(value),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* AWS and Tencent both answer HTML on some errors */
  }
  return { ok: res.ok, status: res.status, body, text };
}

/** Codex routes on the ChatGPT account id buried inside the id_token JWT. */
function codexAccountHeaders(idToken: string): Record<string, string> {
  const headers: Record<string, string> = { "openai-beta": "responses=experimental" };
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, Record<string, string>>;
    const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (accountId) headers["chatgpt-account-id"] = accountId;
  } catch {
    /* personal accounts may carry no auth claim */
  }
  return headers;
}

/** AWS hands back camelCase where the RFC says snake_case. */
function camelTokens(body: Record<string, unknown>): Record<string, unknown> {
  return {
    access_token: body.accessToken ?? body.access_token,
    refresh_token: body.refreshToken ?? body.refresh_token,
    expires_in: body.expiresIn ?? body.expires_in ?? body.expiration,
  };
}

function toToken(providerId: string, body: Record<string, unknown>, headers?: Record<string, string>, authMode: TokenSet["authMode"] = "oauth"): TokenSet | null {
  const access = body.access_token;
  if (typeof access !== "string") return null;
  const rawExpiry = Number(body.expires_in ?? body.expired_in ?? 0);
  // MiniMax hands back an absolute ms timestamp where others give seconds.
  const expiresAt = rawExpiry > 1e10 ? rawExpiry : rawExpiry > 0 ? Date.now() + rawExpiry * 1000 : undefined;
  const token: TokenSet = {
    provider: providerId,
    accessToken: access,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expiresAt,
    authMode,
    headers,
  };
  saveToken(token);
  return token;
}

const CLIENTS = {
  kimi: { clientId: "17e5f671-d194-4dfb-9706-5516cb48c098", base: "https://auth.kimi.com", scope: "kimi-code" },
  copilot: { clientId: "Iv1.b507a08c87ecfe98", base: "https://github.com", scope: "read:user" },
  grok: {
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    base: "https://auth.x.ai",
    scope: "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
  },
  codex: { clientId: "app_EMoamEEZ73f0CkXaXp7hrann", base: "https://auth.openai.com", scope: "openid profile email offline_access" },
  anthropic: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://console.anthropic.com/v1/oauth/token",
    redirectUri: "https://console.anthropic.com/oauth/code/callback",
    scope: "org:create_api_key user:profile user:inference",
  },
  // test-only
  pastedmock: { clientId: "mock-paste", base: "http://127.0.0.1:8788", scope: "mock" },
};

function kimiHeaders() {
  const id = loadConfig().deviceId;
  return {
    "x-msh-platform": "kimi_cli",
    "x-msh-version": "1.5.0",
    "x-msh-device-name": "lazypath",
    "x-msh-device-model": "lazypath",
    "x-msh-os-version": `${process.platform}-${process.arch}`,
    "x-msh-device-id": id,
  };
}

interface DeviceSession {
  kind: "device";
  verifyUrl: string;
  userCode: string;
  /** resolves null while the user has not approved yet */
  poll: () => Promise<TokenSet | null>;
}

interface PasteSession {
  kind: "paste";
  url: string;
  /** the provider shows a code/blob after login; user pastes it into the dashboard */
  finish: (pasted: string) => Promise<TokenSet>;
}

type LoginSession = DeviceSession | PasteSession;

async function startLogin(provider: ProviderDef): Promise<LoginSession> {
  // ---- device-code family -------------------------------------------------
  if (provider.login === "device") {
    if (provider.id.endsWith("mock")) {
      return startMockDevice(provider.id, "http://127.0.0.1:8788/oauth/device/code", "http://127.0.0.1:8788/oauth/device/token", provider.id);
    }

    // Kiro: AWS SSO OIDC. Needs a throwaway public client registered first, and
    // answers JSON with camelCase keys instead of the RFC 8628 form encoding.
    if (provider.id === "kiro") {
      const reg = await jsonPost("https://oidc.us-east-1.amazonaws.com/client/register", {
        clientName: "lazypath",
        clientType: "public",
        scopes: ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations"],
        grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      });
      const clientId = String(reg.body.clientId ?? "");
      const clientSecret = String(reg.body.clientSecret ?? "");
      if (!clientId) throw new Error(`kiro client registration failed: ${reg.text.slice(0, 160)}`);
      const dev = await jsonPost("https://oidc.us-east-1.amazonaws.com/device_authorization", {
        clientId,
        clientSecret,
        startUrl: "https://view.awsapps.com/start",
      });
      const b = dev.body as Record<string, string>;
      if (!b.deviceCode) throw new Error(`kiro device start failed ${dev.status}: ${dev.text.slice(0, 160)}`);
      return {
        kind: "device",
        verifyUrl: b.verificationUriComplete ?? b.verificationUri ?? "https://view.awsapps.com/start",
        userCode: String(b.userCode ?? ""),
        poll: async () => {
          const r = await jsonPost("https://oidc.us-east-1.amazonaws.com/token", {
            clientId,
            clientSecret,
            deviceCode: b.deviceCode,
            grantType: "urn:ietf:params:oauth:grant-type:device_code",
          });
          if (!r.ok) return null;
          const token = toToken(provider.id, camelTokens(r.body), { "x-kiro-client-id": clientId, "x-kiro-client-secret": clientSecret });
          if (token) {
            const arn = await kiroProfileArn(token.accessToken).catch(() => "");
            if (arn) saveToken({ ...token, headers: { ...token.headers, "x-kiro-profile-arn": arn } });
          }
          return token;
        },
      };
    }

    // Tencent CodeBuddy: ask the gateway for a login URL, then poll it. The user
    // just opens the link - there is no code to type, so userCode stays empty.
    if (provider.id === "grok") {
      const c = CLIENTS.grok;
      const hd = { "x-grok-client-version": "0.2.106", "x-grok-client-surface": "cli" };
      const start = await form(`${c.base}/oauth2/device/code`, { client_id: c.clientId, scope: c.scope, referrer: "grok-build" }, hd);
      if (!start.ok) throw new Error(`grok device start failed ${start.status}: ${start.text.slice(0, 160)}`);
      const b = start.body as Record<string, string>;
      return {
        kind: "device",
        verifyUrl: b.verification_uri_complete ?? b.verification_uri,
        userCode: b.user_code,
        poll: async () => {
          const r = await form(`${c.base}/oauth2/token`, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: c.clientId, device_code: b.device_code }, hd);
          if (!r.ok) return null;
          return toToken(provider.id, r.body);
        },
      };
    }

    // OpenAI's device flow is not RFC 8628: the verifier is generated server-side and
    // handed back with the authorization code, so there is no PKCE to do locally.
    if (provider.id === "codex") {
      const c = CLIENTS.codex;
      const s = await jsonPost(`${c.base}/api/accounts/deviceauth/usercode`, { client_id: c.clientId });
      const authId = String(s.body.device_auth_id ?? "");
      const userCode = String(s.body.user_code ?? s.body.usercode ?? "");
      if (!authId || !userCode) throw new Error(`codex device start failed ${s.status}: ${s.text.slice(0, 160)}`);
      return {
        kind: "device",
        verifyUrl: `${c.base}/codex/device`,
        userCode,
        poll: async () => {
          const p = await jsonPost(`${c.base}/api/accounts/deviceauth/token`, { device_auth_id: authId, user_code: userCode });
          if (!p.ok) return null; // 403/404 while the code has not been approved
          const code = String(p.body.authorization_code ?? "");
          const verifier = String(p.body.code_verifier ?? "");
          if (!code || !verifier) return null;
          const t = await form(`${c.base}/oauth/token`, {
            grant_type: "authorization_code",
            client_id: c.clientId,
            code,
            code_verifier: verifier,
            redirect_uri: `${c.base}/deviceauth/callback`,
          });
          if (!t.ok) throw new Error(`codex token exchange failed ${t.status}: ${t.text.slice(0, 160)}`);
          return toToken(provider.id, t.body, codexAccountHeaders(String(t.body.id_token ?? "")));
        },
      };
    }

    if (provider.id === "tencent") {
      const base = TENCENT_BASE;
      const s = await jsonPost(
        `${base}/v2/plugin/auth/state?platform=CLI`,
        { platform: "CLI" },
        { "x-requested-with": "XMLHttpRequest", "x-domain": "copilot.tencent.com", "user-agent": CODEBUDDY_UA },
      );
      const data = (s.body.data ?? {}) as Record<string, string>;
      if (!data.state || !data.authUrl) throw new Error(`codebuddy login start failed ${s.status}: ${s.text.slice(0, 160)}`);
      return {
        kind: "device",
        verifyUrl: data.authUrl,
        userCode: "",
        poll: async () => {
          const res = await fetch(`${base}/v2/plugin/auth/token?state=${encodeURIComponent(data.state)}`, {
            headers: { "x-requested-with": "XMLHttpRequest", "x-domain": "copilot.tencent.com", "user-agent": CODEBUDDY_UA },
          });
          const r = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          const d = (r.data ?? {}) as Record<string, unknown>;
          if (Number(r.code) !== 0 || typeof d.accessToken !== "string") return null;
          return toToken(provider.id, { access_token: d.accessToken, refresh_token: d.refreshToken, expires_in: d.expiresIn });
        },
      };
    }

    const c = CLIENTS[provider.id as "kimi" | "copilot"];
    if (!c) throw new Error(`${provider.id} has no device flow configured`);
    const headers = provider.id === "kimi" ? kimiHeaders() : {};
    const startUrl = provider.id === "copilot" ? `${c.base}/login/device/code` : `${c.base}/api/oauth/device_authorization`;
    const tokenUrl = provider.id === "copilot" ? `${c.base}/login/oauth/access_token` : `${c.base}/api/oauth/token`;

    const start = await form(startUrl, { client_id: c.clientId, scope: c.scope }, headers);
    if (!start.ok) throw new Error(`device start failed ${start.status} ${start.text.slice(0, 160)}`);
    const b = start.body as Record<string, string>;
    const userCode = b.user_code ?? b.userCode;
    const verifyUrl = b.verification_uri_complete ?? b.verification_uri ?? b.verificationUrl;
    if (!userCode || !verifyUrl) throw new Error(`device start returned no code: ${start.text.slice(0, 160)}`);

    return {
      kind: "device",
      verifyUrl,
      userCode,
      poll: async () => {
        const r = await form(
          tokenUrl,
          {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: c.clientId,
            scope: c.scope,
            device_code: b.device_code ?? b.deviceCode,
          },
          headers,
        );
        if (!r.ok) return null;
        const token = await finishCopilot(provider.id, r.body);
        return token;
      },
    };
  }

  // ---- browser-cookie family ---------------------------------------------
  // Some services have no OAuth client at all: the only credential is the session
  // cookie your browser already holds. The user pastes the Cookie header from DevTools.
  if (provider.login === "cookie") {
    return {
      kind: "paste",
      url: provider.site ?? provider.inference.baseUrl.replace(/\/chat$/, "/"),
      finish: async (pasted) => {
        const value = pasted.trim();
        if (!value) throw new Error("nothing pasted");
        if (provider.id === "zai-web") {
          const token = zaiCredential(value);
          if (!token) throw new Error("could not find a Z.ai JWT token in the pasted value");
          return toToken(provider.id, { access_token: token }, undefined, "oauth")!;
        }
        if (provider.id === "inner-ai") {
          const { token, email } = innerAiCredential(value);
          if (!token) throw new Error("could not find an Inner AI JWT token in the pasted value");
          const deviceId = innerAiDeviceId(token);
          const headers: Record<string, string> = {};
          if (deviceId) headers["DEVICE-ID"] = deviceId;
          if (email) headers["USER-EMAIL"] = email;
          const tok = toToken(provider.id, { access_token: value }, headers, "cookie");
          if (!tok) throw new Error("could not store the token");
          return tok;
        }
        const token = toToken(provider.id, { access_token: webCookie(provider.inference.format, value) }, undefined, "cookie");
        if (!token) throw new Error("could not store the cookie");
        return token;
      },
    };
  }

  // ---- browser + paste family --------------------------------------------
  if (provider.id === "pastedmock") {
    return {
      kind: "paste",
      url: "http://127.0.0.1:8788/oauth/authorize?mock=1",
      finish: async (pasted) => {
        const r = await form("http://127.0.0.1:8788/oauth/token", { grant_type: "authorization_code", code: pasted, client_id: "mock-paste" });
        if (!r.ok) throw new Error(`mock exchange failed ${r.status}`);
        return toToken(provider.id, r.body)!;
      },
    };
  }
  // GitLab has no public OAuth client, so you register one yourself (User Settings >
  // Applications, redirect http://localhost:8080/callback) and hand lazypath its id.
  // The browser then lands on a dead localhost page: copy the ?code= out of the URL bar.
  if (provider.id === "gitlab") {
    const root = process.env.LAZYPATH_GITLAB_ROOT ?? "https://gitlab.com";
    const clientId = process.env.LAZYPATH_GITLAB_CLIENT_ID ?? "";
    const clientSecret = process.env.LAZYPATH_GITLAB_CLIENT_SECRET ?? "";
    const redirect = process.env.LAZYPATH_GITLAB_REDIRECT ?? "http://localhost:8080/callback";
    if (!clientId) throw new Error("gitlab needs your own OAuth app: create one in User Settings > Applications, then start lazypath with LAZYPATH_GITLAB_CLIENT_ID set");
    const { verifier, challenge } = pkce();
    const url =
      `${root}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent("ai_features read_user")}` +
      `&code_challenge=${challenge}&code_challenge_method=S256`;
    return {
      kind: "paste",
      url,
      finish: async (pasted) => {
        const code = /code=([^&\s]+)/.exec(pasted)?.[1] ?? pasted.trim();
        const r = await form(`${root}/oauth/token`, {
          grant_type: "authorization_code",
          client_id: clientId,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
        });
        if (!r.ok || !r.body.access_token) throw new Error(`gitlab token exchange failed ${r.status}: ${r.text.slice(0, 160)}`);
        return toToken(provider.id, r.body)!;
      },
    };
  }
  // Qoder has no public OAuth client: you sign in on the site, copy the access token
  // token from Account > Integrations and paste it here. `pt-` tokens are a PAT
  // and have to be exchanged for a short-lived job token first.
  if (provider.id === "qoder") {
    return {
      kind: "paste",
      url: "https://qoder.com/account/integrations",
      finish: async (pasted) => {
        const value = pasted.trim();
        if (!value) throw new Error("nothing pasted");
        if (!value.startsWith("pt-")) return toToken(provider.id, { access_token: value, expires_in: 86_400 })!;
        const r = await jsonPost("https://openapi.qoder.sh/api/v1/jobToken/exchange", { personal_token: value });
        const d = (r.body.data ?? r.body) as Record<string, unknown>;
        const jt = String(d.jobToken ?? d.job_token ?? d.jt ?? d.token ?? "");
        if (!jt.startsWith("jt-")) throw new Error(`qoder token exchange failed ${r.status}: ${r.text.slice(0, 160)}`);
        return toToken(provider.id, { access_token: jt, expires_in: Number(d.expires_in ?? 86_400) })!;
      },
    };
  }
  // Qwen retired the OAuth device login that qwen-code used: the token endpoint now
  // answers the Aliyun WAF block page outside a browser, so the only credential left
  // is the platform API key. Checking it against /models here turns a bad paste into
  // an immediate error instead of a silent fallback on the first chat.
  if (provider.id === "qwen") {
    return {
      kind: "paste",
      url: "https://docs.qwencloud.com/developer-guides/administration/api-keys",
      finish: async (pasted) => {
        const value = pasted.trim().replace(/^Bearer\s+/i, "");
        if (!value) throw new Error("nothing pasted");
        const res = await fetch(`${provider.inference.baseUrl}/models`, { headers: { authorization: `Bearer ${value}` } });
        if (res.status === 401) throw new Error("Qwen Cloud rejected this key (401)");
        return toToken(provider.id, { access_token: value })!;
      },
    };
  }
  // MiniMax dropped the /oauth/code device authorisation the community CLI flow used, so
  // the platform key is the only credential left. /v1/models costs nothing and answers 401
  // for a bad key, which turns a wrong paste into an error here instead of a silent
  // fallback on the first chat.
  if (provider.id === "minimax") {
    return {
      kind: "paste",
      url: "https://platform.minimax.io/user-center/basic-information/interface-key",
      finish: async (pasted) => {
        const value = pasted.trim().replace(/^Bearer\s+/i, "");
        if (!value) throw new Error("nothing pasted");
        const res = await fetch("https://api.minimax.io/v1/models", { headers: { authorization: `Bearer ${value}` } });
        if (res.status === 401) throw new Error("MiniMax rejected this key (401)");
        return toToken(provider.id, { access_token: value })!;
      },
    };
  }
  const c = CLIENTS.anthropic;
  const { verifier, challenge } = pkce();
  const url = new URL(c.authorizeUrl);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", c.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", c.redirectUri);
  url.searchParams.set("scope", c.scope);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", randomBytes(8).toString("hex"));
  return {
    kind: "paste",
    url: url.toString(),
    finish: async (pasted) => {
      // Claude Code lands on a page showing "code#state#..." - take the first part.
      const code = pasted.trim().split("#")[0];
      const r = await form(c.tokenUrl, {
        grant_type: "authorization_code",
        client_id: c.clientId,
        code,
        code_verifier: verifier,
        redirect_uri: c.redirectUri,
        scope: c.scope,
      });
      if (!r.ok) throw new Error(`token exchange failed ${r.status} ${r.text.slice(0, 200)}`);
      const token = toToken(provider.id, r.body);
      if (!token) throw new Error("provider returned no access token");
      return token;
    },
  };
}

/** GitHub's device token is not the inference token: it must be exchanged for a
 *  Copilot API token via copilot_internal/user. */
async function finishCopilot(providerId: string, body: Record<string, unknown>): Promise<TokenSet | null> {
  if (providerId !== "copilot") return toToken(providerId, body);
  const gh = body.access_token;
  if (typeof gh !== "string") return null;
  const res = await fetch("https://api.github.com/copilot_internal/user", {
    headers: { authorization: `Bearer ${gh}`, "editor-version": "vscode/1.95.0", "user-agent": "lazypath", accept: "application/json" },
  });
  if (!res.ok) throw new Error(`copilot token exchange failed ${res.status} ${(await res.text()).slice(0, 160)}`);
  const info = (await res.json()) as Record<string, unknown>;
  return toToken(providerId, { access_token: info.access_token, expires_in: info.expires_in }, { "x-copilot-identity": "lazypath" });
}

const activeLogins = new Map<string, { session: LoginSession; startedAt: number; timer?: ReturnType<typeof setInterval> }>();
const pasteSessions = new Map<string, PasteSession>();

function watchDeviceLogin(providerId: string, session: DeviceSession) {
  const entry = { session, startedAt: Date.now(), timer: undefined as ReturnType<typeof setInterval> | undefined };
  activeLogins.set(providerId, entry);
  entry.timer = setInterval(async () => {
    try {
      const token = await session.poll();
      if (token) {
        clearInterval(entry.timer);
        activeLogins.delete(providerId);
        return;
      }
    } catch {
      /* transient poll errors are normal while waiting for approval */
    }
    if (Date.now() - entry.startedAt > 15 * 60_000) {
      clearInterval(entry.timer);
      activeLogins.delete(providerId);
    }
  }, 3000);
}

const refreshing = new Set<string>();

async function validToken(provider: ProviderDef): Promise<string | null> {
  const stored = tokenStore()[provider.id];
  if (!stored) return null;
  const stale = stored.expiresAt && Date.now() > stored.expiresAt - 120_000;
  if (!stale || !stored.refreshToken || refreshing.has(provider.id)) {
    return stored.expiresAt && Date.now() > stored.expiresAt ? null : stored.accessToken;
  }
  refreshing.add(provider.id);
  try {
    const c = CLIENTS[provider.id as keyof typeof CLIENTS] as { clientId: string; base?: string; tokenUrl?: string; scope?: string; redirectUri?: string } | undefined;
    if (!c) return stored.accessToken;
    const tokenUrl =
      provider.id === "kimi"
        ? `${c.base}/api/oauth/token`
        : provider.id === "copilot"
            ? `${c.base}/login/oauth/access_token`
            : c.tokenUrl!;
    const headers = provider.id === "kimi" ? kimiHeaders() : {};
    const r = await form(tokenUrl, { grant_type: "refresh_token", refresh_token: stored.refreshToken, client_id: c.clientId, scope: c.scope ?? "" }, headers);
    if (!r.ok) return Date.now() > (stored.expiresAt ?? 0) ? null : stored.accessToken;
    const next = await finishCopilot(provider.id, r.body);
    return next?.accessToken ?? stored.accessToken;
  } finally {
    refreshing.delete(provider.id);
  }
}

async function startMockDevice(providerId: string, startUrl: string, tokenUrl: string, clientId: string): Promise<DeviceSession> {
  const start = await form(startUrl, { client_id: clientId, scope: "mock" });
  const b = start.body as Record<string, string>;
  return {
    kind: "device",
    verifyUrl: b.verification_uri,
    userCode: b.user_code,
    poll: async () => {
      const r = await form(tokenUrl, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: b.device_code });
      if (!r.ok) return null;
      return toToken(providerId, r.body);
    },
  };
}

// --------------------------------------------------------------------------- kiro wire
// Kiro (AWS CodeWhisperer) speaks neither OpenAI nor Anthropic: the request is an
// AWS JSON-1.1 shape and the answer is a binary `vnd.amazon.eventstream` of frames.

const uuid = () => {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

function toKiroBody(body: Record<string, unknown>, model: string, profileArn?: string) {
  const messages = (body.messages ?? []) as { role: string; content: unknown }[];
  const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const chat = messages.filter((m) => m.role !== "system");
  const last = chat.at(-1);
  const turn = (m: { role: string; content: unknown }) =>
    m.role === "assistant"
      ? { assistantResponseMessage: { content: textOf(m.content) } }
      : { userInputMessage: { content: textOf(m.content), modelId: model, origin: "AI_EDITOR" } };
  const history = chat.slice(0, -1).map(turn);
  const content = [system ? `<system-reminder>\n${system}\n</system-reminder>\n\n` : "", last ? textOf(last.content) || "(empty)" : "..."].join("");
  const payload: Record<string, unknown> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: uuid(),
      currentMessage: { userInputMessage: { content, modelId: model, origin: "AI_EDITOR" } },
      history,
    },
    inferenceConfig: { maxTokens: Number(body.max_tokens ?? 4096) },
  };
  if (profileArn) payload.profileArn = profileArn;
  return payload;
}

/** Walk AWS eventstream frames and hand each (event type, JSON payload) pair over. */
function eventstream(buf: Buffer, onEvent: (type: string, payload: Record<string, unknown>) => void) {
  let off = 0;
  while (off + 16 <= buf.length) {
    const total = buf.readUInt32BE(off);
    const headLen = buf.readUInt32BE(off + 4);
    if (total < 16 || headLen > total - 12 || off + total > buf.length) return;
    let type = "";
    let q = off + 12;
    const headEnd = off + 12 + headLen;
    while (q + 4 <= headEnd) {
      const nameLen = buf[q];
      const name = buf.toString("utf8", q + 1, q + 1 + nameLen);
      const after = q + 1 + nameLen;
      const valueType = buf[after];
      const valueLen = buf.readUInt16BE(after + 1);
      if (valueType === 7 && name === ":event-type") type = buf.toString("utf8", after + 3, after + 3 + valueLen);
      q = after + 3 + valueLen;
    }
    const payload = buf.subarray(headEnd, off + total - 4);
    if (type) {
      try {
        onEvent(type, JSON.parse(payload.toString("utf8") || "{}") as Record<string, unknown>);
      } catch {
        /* keep-alive frames carry no JSON */
      }
    }
    off += total;
  }
}

function fromKiro(buf: Buffer, model: string) {
  let text = "";
  const usage = { input: 0, output: 0 };
  eventstream(buf, (type, payload) => {
    if (type === "assistantResponseEvent") text += String(payload.content ?? "");
    const u = (payload.usage ?? {}) as Record<string, unknown>;
    usage.input = Number(u.inputTokens ?? usage.input);
    usage.output = Number(u.outputTokens ?? usage.output);
  });
  return {
    id: "lazypath-kiro",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
  };
}

/** Kiro profiles are account-scoped and not guessable: ask the service for one. */
async function kiroProfileArn(accessToken: string): Promise<string> {
  const res = await fetch("https://codewhisperer.us-east-1.amazonaws.com/", {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "AWS-SDK-JS/3.0.0 lazypath",
    },
    body: JSON.stringify({ maxResults: 10 }),
  });
  if (!res.ok) return "";
  const json = (await res.json().catch(() => ({}) as Record<string, unknown>)) as Record<string, unknown>;
  const first = ((json.profiles ?? []) as { arn?: string }[])[0];
  return first?.arn ?? "";
}

// --------------------------------------------------------------------------- wire translation

function toAnthropicBody(body: Record<string, unknown>, model: string) {
  const messages = (body.messages ?? []) as { role: string; content: unknown }[];
  const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const chat = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: textOf(m.content) }));
  const out: Record<string, unknown> = { model, messages: chat, max_tokens: Number(body.max_tokens ?? 4096) };
  if (system) out.system = system;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.stream) out.stream = true;
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : String((part as { text?: string }).text ?? ""))).join("");
  }
  return String(content ?? "");
}

function fromAnthropic(json: Record<string, unknown>, model: string) {
  const text = ((json.content ?? []) as { type: string; text?: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  const usage = (json.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  return {
    id: String(json.id ?? "lazypath"),
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: json.stop_reason ?? "stop" }],
    usage: { prompt_tokens: usage.input_tokens ?? 0, completion_tokens: usage.output_tokens ?? 0, total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) },
  };
}

function anthropicSseToOpenai(raw: string, model: string): string {
  let out = "";
  let sentRole = false;
  for (const block of raw.split("\n\n")) {
    const data = block.split("\n").find((l) => l.startsWith("data:"));
    if (!data) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(data.slice(5).trim()) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(evt.type ?? "");
    if (type === "content_block_delta") {
      const text = (evt.delta as { text?: string } | undefined)?.text ?? "";
      if (!text) continue;
      if (!sentRole) {
        sentRole = true;
        out += chunk(model, { role: "assistant" });
      }
      out += chunk(model, { content: text });
    } else if (type === "message_delta") {
      out += chunk(model, {}, "stop");
    } else if (type === "message_stop") {
      out += "data: [DONE]\n\n";
    }
  }
  return out;
}

function chunk(model: string, delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({ object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

// --------------------------------------------------------------------------- responses wire
// ChatGPT (Codex) and Grok's CLI proxy speak OpenAI's newer Responses API rather than
// chat completions, so one translation covers both. They stream even when asked not to.

function toResponsesBody(body: Record<string, unknown>, model: string) {
  const messages = (body.messages ?? []) as { role: string; content: unknown }[];
  const instructions = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const input = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      type: "message",
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{ type: "input_text", text: textOf(m.content) }],
    }));
  const out: Record<string, unknown> = { model, input, stream: true };
  if (instructions) out.instructions = instructions;
  if (body.max_tokens !== undefined) out.max_output_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  return out;
}

function sseData(raw: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const block of raw.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        events.push(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        /* truncated frame */
      }
    }
  }
  return events;
}

function responseText(resp: Record<string, unknown>) {
  return ((resp.output ?? []) as { type?: string; content?: { type?: string; text?: string }[] }[])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}

function fromResponses(raw: string, model: string) {
  let text = "";
  const usage = { input: 0, output: 0 };
  const events = raw.includes("data:") ? sseData(raw) : [JSON.parse(raw) as Record<string, unknown>];
  for (const evt of events) {
    const type = String(evt.type ?? "");
    if (type === "response.output_text.delta") text += String(evt.delta ?? "");
    if (type === "response.completed" || !type) {
      const resp = (evt.response ?? evt) as Record<string, unknown>;
      if (!text) text = responseText(resp);
      const u = (resp.usage ?? {}) as Record<string, unknown>;
      usage.input = Number(u.input_tokens ?? usage.input);
      usage.output = Number(u.output_tokens ?? usage.output);
    }
  }
  return {
    id: "lazypath",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
  };
}

// --------------------------------------------------------------------------- huggingchat wire
// HuggingChat answers its own SSE: {type:"stream",token} chunks padded with NUL bytes,
// closed by a {type:"finalAnswer",text} frame carrying the whole reply.

function huggingchatText(raw: string): string {
  let text = "";
  for (const evt of sseData(raw)) {
    const type = String(evt.type ?? "");
    if (type === "stream") text += String(evt.token ?? "").replace(/\0/g, "");
    else if (type === "finalAnswer") text = String(evt.text ?? "").replace(/\0/g, "");
  }
  return text;
}

function fromHuggingchat(raw: string, model: string) {
  const text = huggingchatText(raw);
  return {
    id: "lazypath",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function huggingchatSseToOpenai(raw: string, model: string, state: { role: boolean; done: boolean }): string {
  let out = "";
  for (const evt of sseData(raw)) {
    const type = String(evt.type ?? "");
    if (type === "stream") {
      const text = String(evt.token ?? "").replace(/\0/g, "");
      if (!text) continue;
      if (!state.role) {
        state.role = true;
        out += chunk(model, { role: "assistant" });
      }
      out += chunk(model, { content: text });
    } else if (type === "finalAnswer" && !state.done) {
      state.done = true;
      out += chunk(model, {}, "stop") + "data: [DONE]\n\n";
    }
  }
  return out;
}

function responsesSseToOpenai(raw: string, model: string, state: { role: boolean; done: boolean }): string {
  let out = "";
  for (const evt of sseData(raw)) {
    const type = String(evt.type ?? "");
    if (type === "response.output_text.delta") {
      const text = String(evt.delta ?? "");
      if (!text) continue;
      if (!state.role) {
        state.role = true;
        out += chunk(model, { role: "assistant" });
      }
      out += chunk(model, { content: text });
    } else if (type === "response.completed" && !state.done) {
      state.done = true;
      out += chunk(model, {}, "stop") + "data: [DONE]\n\n";
    }
  }
  return out;
}

// --------------------------------------------------------------------------- kimi (web) wire
// www.kimi.ai's web client wraps each turn in a 5-byte Connect envelope (flags, then a
// big-endian length) and answers with the same framing, so the reply is decoded, not parsed.

function cookieValue(cookie: string, name: string): string {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(cookie);
  return m ? m[1].trim() : "";
}

function kimiWebCredential(raw: string): string {
  const value = raw.trim();
  if (value.includes("=") && (value.includes(";") || /cookie|authorization/i.test(value))) {
    return cookieValue(value, "access_token") || cookieValue(value, "token") || value;
  }
  return value.replace(/^Bearer\s+/i, "");
}

function kimiWebFrame(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

function kimiWebText(buf: Buffer): string {
  let text = "";
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const flags = buf[offset];
    const len = buf.readUInt32BE(offset + 1);
    if (flags & 0x02 || offset + 5 + len > buf.length) break;
    const frame = buf.subarray(offset + 5, offset + 5 + len);
    offset += 5 + len;
    if (!len) continue;
    try {
      const msg = JSON.parse(frame.toString("utf8")) as Record<string, unknown>;
      const mask = String(msg.mask ?? "");
      if ((msg.op === "append" || msg.op === "set") && mask.startsWith("block.text")) {
        const block = (msg.block ?? {}) as { text?: { content?: string } };
        text += block.text?.content ?? "";
      }
    } catch {
      /* a frame that is not JSON carries nothing we need */
    }
  }
  return text;
}

function toKimiWebBody(messages: { role: string; content: unknown }[], model: string) {
  const scenario = "SCENARIO_K2D5";
  const system = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") continue;
    const text = textOf(m.content);
    if (!text) continue;
    parts.push(m.role === "assistant" ? `Assistant: ${text}` : parts.length ? `User: ${text}` : text);
  }
  return {
    chat_id: "",
    scenario,
    tools: [],
    message: {
      id: "",
      parent_id: "",
      children_message_ids: [],
      role: "user",
      blocks: [{ id: "", message_id: "", text: { content: parts.join("\n\n").trim() } }],
      scenario,
      labels: [],
      references: [],
      is_goal: false,
    },
    // K2.6's NONE/LOW enum decides whether the thinking path is actually used
    options: { thinking: true, enable_plugin: false, reasoning_effort: "REASONING_EFFORT_NONE", ...(system ? { system_prompt: system } : {}) },
    project_id: "",
  };
}

// --------------------------------------------------------------------------- dola (doubao) wire
// dola.com takes one folded prompt plus a browser fingerprint from its own cookies and
// streams SSE events; text arrives in content blocks, sometimes as patches.

function dolaCookie(raw: string): string {
  const value = raw.trim();
  return value.includes("=") ? value : `sessionid=${value}`;
}

function dolaPrompt(messages: { role: string; content: unknown }[]): string {
  return messages
    .map((m) => {
      const text = textOf(m.content);
      return text ? `${m.role}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function dolaUrl(base: string, cookie: string): string {
  const id = Array.from(randomBytes(19), (b) => String(b % 10)).join("");
  const query = new URLSearchParams({
    aid: "495671",
    real_aid: "495671",
    device_platform: "web",
    device_id: id,
    web_id: id,
    tea_uuid: id,
    web_tab_id: randomBytes(16).toString("hex"),
    pc_version: "3.25.3",
    pkg_type: "release_version",
    version_code: "20800",
    samantha_web: "1",
    web_platform: "browser",
    "use-olympus-account": "1",
    language: "en",
    region: "US",
    sys_region: "US",
    fp: cookieValue(cookie, "s_v_web_id") || cookieValue(cookie, "fp"),
  });
  return `${base}?${query.toString()}`;
}

function dolaBody(messages: { role: string; content: unknown }[], model: string, fingerprint: string) {
  const messageId = randomBytes(16).toString("hex");
  return {
    client_meta: { local_conversation_id: `local_${randomBytes(8).toString("hex")}`, conversation_id: "", bot_id: "7339470689562525703", last_section_id: "", last_message_index: null },
    messages: [
      {
        local_message_id: messageId,
        content_block: [
          {
            block_type: 10000,
            content: { text_block: { text: dolaPrompt(messages), icon_url: "", icon_url_dark: "", summary: "" }, pc_event_block: "" },
            block_id: randomBytes(16).toString("hex"),
            parent_id: "",
            meta_info: [],
            append_fields: [],
          },
        ],
        message_status: 0,
      },
    ],
    option: {
      send_message_scene: "",
      create_time_ms: Date.now(),
      is_audio: false,
      need_deep_think: model.includes("pro") || model.includes("think") ? 3 : 0,
      start_seq: 0,
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      sse_recv_event_options: { support_chunk_delta: true },
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(Date.now() / 1000), append_sse_event_scene: 0 },
    },
    user_context: [],
    ext: {
      use_deep_think: String(model.includes("pro") || model.includes("think") ? 3 : 0),
      fp: fingerprint,
      conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
      commerce_credit_config_enable: "0",
    },
  };
}

function dolaText(raw: string, deepThink: boolean): string {
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const blocksOf = (event: Record<string, unknown>) => {
    const payload = obj(event.data);
    const root = obj(event.content);
    const inner = obj(payload.content);
    const direct = Array.isArray(root.content_block) ? root.content_block : Array.isArray(inner.content_block) ? inner.content_block : [];
    const out = [...direct];
    const ops = Array.isArray(event.patch_op) ? event.patch_op : Array.isArray(payload.patch_op) ? payload.patch_op : [];
    for (const op of ops) {
      const patch = obj(obj(op).patch_value);
      if (Array.isArray(patch.content_block)) out.push(...patch.content_block);
    }
    return out;
  };
  let text = "";
  let answering = !deepThink;
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (!data) continue;
    if (block.includes("event: STREAM_ERROR")) {
      const payload = obj(JSON.parse(data || "{}").data);
      throw new Error(String(payload.error_msg ?? payload.message ?? "dola stream error"));
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const block of blocksOf(event)) {
      const item = obj(block);
      if (deepThink && item.block_type === 10040 && item.is_finish === true) {
        answering = true;
        text = ""; // reasoning finished: the answer starts fresh
        continue;
      }
      const value = obj(obj(item.content).text_block).text;
      if (answering && typeof value === "string") text += value;
    }
  }
  return text;
}

function fromKimiWeb(buf: Buffer, model: string) {
  const text = kimiWebText(buf);
  return {
    id: "lazypath",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function fromDola(raw: string, model: string) {
  const text = dolaText(raw, model.includes("pro") || model.includes("think"));
  return {
    id: "lazypath",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// --------------------------------------------------------------------------- z.ai (web) wire
// chat.z.ai signs each completion request with an HMAC derived from the JWT token,
// a 5-minute bucket, and the base64-encoded prompt. The response is SSE carrying
// either OpenAI-shaped choices or an internal envelope with delta_content.

const ZAI_SIGNATURE_KEY = "key-@@@@)))()((9))-xxxx&&&%%%%%";

function zaiCredential(raw: string): string {
  const value = raw.trim();
  const json = (() => {
    try {
      return value.startsWith("{") ? (JSON.parse(value) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  })();
  if (json) {
    const t = json.token ?? json.accessToken ?? json.access_token;
    if (typeof t === "string") return t.trim();
  }
  const bearer = /^\s*(?:Authorization:\s*)?Bearer\s+(.+)$/i.exec(value);
  if (bearer) return bearer[1].trim();
  const cookie = /(?:^|;)\s*token=([^;]+)/i.exec(value);
  if (cookie) return cookie[1].trim();
  return value.includes("=") || value.includes(";") ? "" : value;
}

function zaiCaptcha(raw: string): string {
  const value = raw.trim();
  const json = (() => {
    try {
      return value.startsWith("{") ? (JSON.parse(value) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  })();
  if (json) {
    const direct = json.captcha_verify_param ?? json.captchaVerifyParam ?? json.zaiCaptchaVerifyParam;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
  }
  const m = /(?:^|;)\s*captcha_verify_param=([^;]+)/i.exec(value);
  return m?.[1]?.trim() ?? "";
}

function zaiUserId(token: string): string {
  const payload = token.split(".")[1];
  if (!payload) return "";
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof decoded.id === "string" ? decoded.id : "";
  } catch {
    return "";
  }
}

function zaiSignature(input: { prompt: string; requestId: string; timestamp: number | string; userId: string }): string {
  const timestamp = String(input.timestamp);
  const sortedPayload = Object.entries({ timestamp, requestId: input.requestId, user_id: input.userId })
    .sort(([a], [b]) => a.localeCompare(b))
    .join(",");
  const encodedPrompt = Buffer.from(input.prompt, "utf8").toString("base64");
  const bucket = Math.floor(Number(timestamp) / (5 * 60 * 1000));
  const derivedKey = createHmac("sha256", ZAI_SIGNATURE_KEY).update(String(bucket)).digest("hex");
  return createHmac("sha256", derivedKey).update(`${sortedPayload}|${encodedPrompt}|${timestamp}`).digest("hex");
}

function zaiPrompt(messages: { role: string; content: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return textOf(messages[i].content);
  }
  return "";
}

function zaiNewChatBody(messages: { role: string; content: unknown }[], modelId: string): Record<string, unknown> {
  const prompt = zaiPrompt(messages);
  const userMessageId = randomBytes(16).toString("hex");
  return {
    userMessageId,
    payload: {
      chat: {
        id: "",
        title: "New Chat",
        models: [modelId],
        params: {},
        history: {
          messages: {
            [userMessageId]: {
              id: userMessageId,
              parentId: null,
              childrenIds: [],
              role: "user",
              content: prompt,
              timestamp: Math.floor(Date.now() / 1000),
              models: [modelId],
            },
          },
          currentId: userMessageId,
        },
        tags: [],
        flags: [],
        features: [{ server: "tool_selector_h", status: "hidden", type: "tool_selector" }],
        mcp_servers: [],
        enable_thinking: true,
        reasoning_effort: "high",
        auto_web_search: false,
        message_version: 1,
        extra: { vlm_tools_enable: false, vlm_web_search_enable: false, vlm_website_mode: false },
        timestamp: Date.now(),
        type: "default",
      },
    },
  };
}

function zaiRequestBody(input: {
  chatId: string;
  messages: { role: string; content: unknown }[];
  modelId: string;
  prompt: string;
  userMessageId: string;
  captchaVerifyParam: string;
}): Record<string, unknown> {
  const features: Record<string, unknown> = {
    image_generation: false,
    web_search: false,
    auto_web_search: false,
    preview_mode: true,
    flags: [],
    vlm_tools_enable: false,
    vlm_web_search_enable: false,
    vlm_website_mode: false,
    enable_thinking: true,
    reasoning_effort: "high",
  };
  return {
    stream: true,
    model: input.modelId,
    messages: input.messages.map((m) => ({ role: m.role, content: textOf(m.content) })).filter((m) => m.content),
    signature_prompt: input.prompt,
    params: {},
    extra: { vlm_tools_enable: false, vlm_web_search_enable: false, vlm_website_mode: false },
    features,
    variables: {},
    chat_id: input.chatId,
    id: randomBytes(16).toString("hex"),
    current_user_message_id: input.userMessageId,
    current_user_message_parent_id: null,
    background_tasks: { title_generation: true, tags_generation: true },
    captcha_verify_param: input.captchaVerifyParam,
  };
}

function parseZaiDelta(frame: Record<string, unknown>): { content: string; reasoning: string; done: boolean; error?: string } | null {
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const data = obj(frame.data ?? frame);

  const rawError = frame.error ?? data.error;
  if (rawError) {
    let message = "";
    if (typeof rawError === "string") message = rawError;
    else {
      const rec = obj(rawError);
      message = String(rec.detail ?? rec.message ?? rec.msg ?? JSON.stringify(rawError));
    }
    return { content: "", reasoning: "", done: true, error: message };
  }

  const choices = frame.choices as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(choices) && choices.length > 0) {
    const delta = obj(choices[0]?.delta);
    const finishReason = choices[0]?.finish_reason;
    return { content: String(delta.content ?? ""), reasoning: String(delta.reasoning_content ?? ""), done: finishReason != null };
  }

  const phase = String(data.phase ?? "");
  const deltaContent = data.delta_content ?? data.edit_content ?? data.content;
  const done = data.done === true || phase === "done" || phase === "finish" || String(frame.type ?? "") === "chat:completion:finish";
  if (typeof deltaContent === "string" && deltaContent) {
    const isThinking = phase === "thinking";
    return { content: isThinking ? "" : deltaContent, reasoning: isThinking ? deltaContent : "", done };
  }
  if (done) return { content: "", reasoning: "", done: true };
  return null;
}

function zaiText(raw: string): string {
  let text = "";
  for (const evt of sseData(raw)) {
    const delta = parseZaiDelta(evt);
    if (!delta) continue;
    if (delta.error) throw new Error(delta.error);
    text += delta.content;
  }
  return text;
}

function zaiSseToOpenai(raw: string, model: string, state: { role: boolean; done: boolean }): string {
  let out = "";
  for (const evt of sseData(raw)) {
    const delta = parseZaiDelta(evt);
    if (!delta || state.done) continue;
    if (delta.error) {
      state.done = true;
      out += chunk(model, {}, "stop") + "data: [DONE]\n\n";
      break;
    }
    if (delta.content || delta.reasoning) {
      if (!state.role) {
        state.role = true;
        out += chunk(model, { role: "assistant" });
      }
      if (delta.reasoning) out += chunk(model, { reasoning_content: delta.reasoning });
      if (delta.content) out += chunk(model, { content: delta.content });
    }
    if (delta.done) {
      state.done = true;
      out += chunk(model, {}, "stop") + "data: [DONE]\n\n";
    }
  }
  return out;
}

function fromZaiWeb(raw: string, model: string) {
  const text = zaiText(raw);
  return {
    id: "lazypath",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// --------------------------------------------------------------------------- inner.ai wire
// app.innerai.com uses a JWT token cookie plus DEVICE-ID derived from the JWT.
// The chat endpoint streams SSE {type:"text",item:"..."} until {type:"end_stream"}.

function innerAiCredential(raw: string): { token: string; email: string } {
  const trimmed = raw.trim();
  const eqIdx = trimmed.indexOf("=");
  const stripped = eqIdx > 0 && !trimmed.startsWith("eyJ") ? trimmed.slice(eqIdx + 1).trim() : trimmed;
  const lastSpace = stripped.lastIndexOf(" ");
  if (lastSpace > 0) {
    const possible = stripped.slice(lastSpace + 1).trim();
    if (possible.includes("@")) return { token: stripped.slice(0, lastSpace).trim(), email: possible };
  }
  return { token: stripped, email: "" };
}

function innerAiDeviceId(token: string): string {
  const payload = token.split(".")[1];
  if (!payload) return "";
  try {
    const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (payload.length % 4)) % 4), "base64").toString("utf8")) as Record<string, unknown>;
    return String(decoded.device_id ?? decoded.deviceId ?? decoded["device-id"] ?? decoded.did ?? "").trim();
  } catch {
    return "";
  }
}

function innerAiHeaders(token: string, deviceId: string, email: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    cookie: `token=${token}`,
    "USER-TOKEN": token,
    "DEVICE-ID": deviceId,
    Origin: "https://app.innerai.com",
    Referer: "https://app.innerai.com/",
  };
  if (email) headers["USER-EMAIL"] = email;
  return headers;
}

function innerAiBody(messages: { role: string; content: unknown }[], model: string): Record<string, unknown> {
  const parts: string[] = [];
  for (const m of messages) {
    const text = textOf(m.content);
    if (!text.trim()) continue;
    if (m.role === "system") parts.push(`[Instructions]\n${text}`);
    else if (m.role === "assistant") parts.push(`[Assistant]\n${text}`);
    else parts.push(text);
  }
  return {
    message: parts.join("\n\n"),
    session_id: randomBytes(16).toString("hex"),
    context_type: "no_context",
    ai_model: { id: "", llm_model: model },
    is_extension: false,
    env: "production",
    temporary: true,
    use_web_search: false,
    knowledge_list: [],
  };
}

function innerAiText(raw: string): string {
  let text = "";
  for (const evt of sseData(raw)) {
    const type = String(evt.type ?? "");
    const item = String(evt.item ?? "");
    if (type === "text") text += item;
    else if (["missing_credits", "reached_limit", "rate_limit_reached", "rate_limit_longer_reached"].includes(type)) {
      const msg = type === "missing_credits" ? "Inner AI: not enough credits" : type === "reached_limit" ? "Inner AI: usage limit reached" : "Inner AI: rate limit reached";
      throw new Error(msg);
    }
  }
  return text;
}

function innerAiSseToOpenai(raw: string, model: string, state: { role: boolean; done: boolean }): string {
  let out = "";
  for (const evt of sseData(raw)) {
    const type = String(evt.type ?? "");
    const item = String(evt.item ?? "");
    if (["missing_credits", "reached_limit", "rate_limit_reached", "rate_limit_longer_reached"].includes(type)) {
      if (!state.done) {
        state.done = true;
        out += chunk(model, {}, "stop") + "data: [DONE]\n\n";
      }
      break;
    }
    if (type === "text" && item) {
      if (!state.role) {
        state.role = true;
        out += chunk(model, { role: "assistant" });
      }
      out += chunk(model, { content: item });
    } else if (type === "end_stream" && !state.done) {
      state.done = true;
      out += chunk(model, {}, "stop") + "data: [DONE]\n\n";
    }
  }
  return out;
}

function fromInnerAi(raw: string, model: string) {
  const text = innerAiText(raw);
  return {
    id: "lazypath",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// --------------------------------------------------------------------------- web session cookies

// A pasted credential is either a bare session-token value or the whole Cookie header from
// DevTools. Wrapping only the bare form keeps both working without a per-provider branch.
// Keyed by wire format, not provider id, so the test stubs exercise the same path.
const WEB_SESSION_COOKIES: Record<string, string> = {
  pplxweb: "__Secure-next-auth.session-token",
  claudeweb: "sessionKey",
  adapta: "__client",
};

function webCookie(format: string, raw: string): string {
  const value = raw.trim();
  if (!value || value.includes("=")) return value;
  const name = WEB_SESSION_COOKIES[format];
  return name ? `${name}=${value}` : value;
}

// --------------------------------------------------------------------------- perplexity (web) wire
// Probed live from this host: www.perplexity.ai answers a plain Node fetch with a browser
// User-Agent (HTTP 200 + text/event-stream), so no TLS-impersonation client is needed here —
// its edge gate is the UA/fingerprint mismatch, not the IP. An unauthenticated ask reaches
// the model edge too, and answers "Sign up and repeat your request.", which is how a stale
// cookie shows up to the user.
// With the full supported_block_use_cases list the answer text arrives in a workflow_block
// (plus RFC-6902 diffs against it), NOT in markdown_block — markdown_block only carries the
// answer for trimmed use-case lists, so both tracks are accumulated.

const PPLX_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const PPLX_BLOCK_USE_CASES = [
  "answer_modes",
  "media_items",
  "knowledge_cards",
  "inline_entity_cards",
  "place_widgets",
  "finance_widgets",
  "sports_widgets",
  "news_widgets",
  "shopping_widgets",
  "jobs_widgets",
  "search_result_widgets",
  "inline_images",
  "inline_assets",
  "placeholder_cards",
  "diff_blocks",
  "inline_knowledge_cards",
  "entity_group_v2",
  "refinement_filters",
  "canvas_mode",
  "maps_preview",
  "answer_tabs",
  "price_comparison_widgets",
  "preserve_latex",
  "generic_onboarding_widgets",
  "in_context_suggestions",
  "pending_followups",
  "inline_claims",
  "unified_assets",
  "workflow_steps",
  "workflow_widgets",
  "navigation_results",
  "background_agents",
];

interface PplxTrack {
  chunks: string[];
  text: string;
}

interface StreamState {
  role: boolean;
  done: boolean;
  tracks: Map<string, PplxTrack>;
  emitted: number;
}

function pplxTrack(tracks: Map<string, PplxTrack>, key: string): PplxTrack {
  let t = tracks.get(key);
  if (!t) {
    t = { chunks: [], text: "" };
    tracks.set(key, t);
  }
  return t;
}

function pplxIsAnswerUsage(usage: string): boolean {
  return usage === "ask_text" || /^ask_text_\d+_markdown$/.test(usage) || usage.includes("markdown");
}

type PplxTextPayload = { chunks?: unknown[]; text?: string; variant?: string } | undefined;

function pplxSeed(track: PplxTrack, payload: PplxTextPayload): void {
  if (!payload) return;
  if (Array.isArray(payload.chunks)) track.chunks = payload.chunks.map((c) => String(c));
  if (typeof payload.text === "string" && payload.text.length > track.text.length) track.text = payload.text;
}

function pplxApplyDiff(tracks: Map<string, PplxTrack>, diff: { field?: string; patches?: { path?: string; value?: unknown }[] }): void {
  const field = String(diff.field ?? "");
  for (const patch of diff.patches ?? []) {
    const path = String(patch.path ?? "");

    if (field === "markdown_block") {
      const track = pplxTrack(tracks, "ask_text");
      if (path === "") {
        const value = (patch.value ?? {}) as { chunks?: unknown[]; answer?: string };
        track.chunks = Array.isArray(value.chunks) ? value.chunks.map((c) => String(c)) : [];
        if (typeof value.answer === "string") track.text = value.answer;
      } else {
        const m = /^\/chunks\/(\d+)$/.exec(path);
        if (m && typeof patch.value === "string") track.chunks[Number(m[1])] = patch.value;
      }
      continue;
    }

    if (field !== "workflow_block") continue;
    const itemKey = /^\/steps\/(\d+)\/items\/(\d+)/.exec(path);
    if (!itemKey) continue;
    const track = pplxTrack(tracks, `wf:${itemKey[1]}:${itemKey[2]}`);

    const chunk = /^\/steps\/\d+\/items\/\d+\/payload\/text_payload\/chunks\/(\d+)$/.exec(path);
    if (chunk && typeof patch.value === "string") {
      track.chunks[Number(chunk[1])] = patch.value;
      continue;
    }
    if (/\/payload\/text_payload\/text$/.test(path)) {
      const text = String(patch.value ?? "");
      if (text.length >= track.text.length) track.text = text;
      continue;
    }
    // whole item or whole step materialised — only answer-variant items carry the reply
    const value = patch.value as Record<string, unknown> | undefined;
    if (!value) continue;
    const items = Array.isArray(value.items) ? (value.items as Record<string, unknown>[]) : [value];
    for (const item of items) {
      const payload = (item.payload as { text_payload?: PplxTextPayload } | undefined)?.text_payload;
      const variant = String(payload?.variant ?? item.variant ?? "");
      if (variant !== "answer") continue;
      pplxSeed(track, payload);
    }
  }
}

function pplxApplyFrame(evt: Record<string, unknown>, tracks: Map<string, PplxTrack>): void {
  for (const block of (evt.blocks ?? []) as Record<string, unknown>[]) {
    const usage = String(block.intended_usage ?? "");
    const markdown = block.markdown_block as { chunks?: unknown[]; answer?: string } | undefined;
    if (markdown && pplxIsAnswerUsage(usage)) {
      pplxSeed(pplxTrack(tracks, usage), markdown as PplxTextPayload);
      continue;
    }
    const workflow = block.workflow_block as { steps?: { items?: Record<string, unknown>[] }[] } | undefined;
    if (workflow) {
      (workflow.steps ?? []).forEach((step, si) =>
        (step.items ?? []).forEach((item, ii) => {
          const payload = (item.payload as { text_payload?: PplxTextPayload } | undefined)?.text_payload;
          if (String(payload?.variant ?? item.variant ?? "") !== "answer") return;
          pplxSeed(pplxTrack(tracks, `wf:${si}:${ii}`), payload);
        }),
      );
      continue;
    }
    const diff = block.diff_block as { field?: string; patches?: { path?: string; value?: unknown }[] } | undefined;
    if (diff) pplxApplyDiff(tracks, diff);
  }
}

// Every track converges on the same answer, so the longest one is the reply; picking the max
// rather than concatenating is what keeps ask_text and workflow_root from doubling the text.
function pplxAnswer(tracks: Map<string, PplxTrack>): string {
  let best = "";
  for (const track of tracks.values()) {
    const joined = track.chunks.filter(Boolean).join("");
    const candidate = joined.length >= track.text.length ? joined : track.text;
    if (candidate.length > best.length) best = candidate;
  }
  return best;
}

function pplxFoldMessages(messages: { role: string; content: unknown }[]) {
  const instructions: string[] = [];
  const history: { role: string; content: string }[] = [];
  let current = "";
  for (const m of messages) {
    const text = textOf(m.content);
    if (!text.trim()) continue;
    if (m.role === "system") instructions.push(text);
    else if (m.role === "user" || m.role === "assistant") history.push({ role: m.role, content: text });
  }
  if (history.length && history.at(-1)!.role === "user") current = history.pop()!.content;
  const obj: Record<string, unknown> = {};
  if (instructions.length) obj.instructions = instructions;
  if (history.length) obj.history = history;
  obj.query = current;
  return { query: JSON.stringify(obj).slice(-96000), current };
}

function pplxBody(query: string, current: string, model: string, requestId: string): Record<string, unknown> {
  return {
    query_str: query,
    params: {
      attachments: [],
      language: "en-US",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      search_focus: "internet",
      sources: ["web"],
      frontend_uuid: requestId,
      // "search" is downgraded server-side to CONCISE and drops model_preference, so every
      // catalog model has to be posted as "copilot".
      mode: "copilot",
      model_preference: model,
      is_related_query: false,
      is_sponsored: false,
      frontend_context_uuid: randomUUID(),
      prompt_source: "user",
      query_source: "home",
      is_incognito: true,
      local_search_enabled: false,
      use_schematized_api: true,
      send_back_text_in_streaming_api: false,
      supported_block_use_cases: PPLX_BLOCK_USE_CASES,
      client_coordinates: null,
      mentions: [],
      dsl_query: current.trim() ? current : query,
      skip_search_enabled: true,
      is_nav_suggestions_disabled: false,
      source: "default",
      always_search_override: false,
      override_no_search: false,
      client_search_results_cache_key: requestId,
      should_ask_for_mcp_tool_confirmation: true,
      supports_tool_approval_modal: true,
      browser_agent_allow_once_from_toggle: false,
      force_enable_browser_agent: false,
      supported_features: ["browser_agent_permission_banner_v1.1"],
      extended_context: false,
      version: "2.18",
      rum_session_id: randomUUID(),
    },
  };
}

function pplxHeaders(cookie: string, requestId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    origin: "https://www.perplexity.ai",
    referer: "https://www.perplexity.ai/",
    "user-agent": PPLX_USER_AGENT,
    cookie,
    "x-perplexity-request-endpoint": "https://www.perplexity.ai/rest/sse/perplexity_ask",
    "x-perplexity-request-reason": "ask-query-state-provider",
    "x-perplexity-request-try-number": "1",
    "x-request-id": requestId,
  };
}

function pplxFailures(frames: Record<string, unknown>[]): string {
  for (const evt of frames) {
    const upsell = (evt.upsell_information ?? {}) as { upsell_type?: string };
    if (String(upsell.upsell_type ?? "") === "LOGIN") return "Perplexity: the session cookie is not logged in";
    if (evt.error_message) return `Perplexity: ${String(evt.error_message)}`;
    if (String(evt.status ?? "") === "FAILED") return "Perplexity failed to process the query";
  }
  return "";
}

function fromPplx(raw: string, model: string) {
  const frames = sseData(raw);
  const failure = pplxFailures(frames);
  if (failure) throw new Error(failure);
  const tracks = new Map<string, PplxTrack>();
  for (const evt of frames) pplxApplyFrame(evt, tracks);
  const text = pplxAnswer(tracks);
  if (!text.trim()) throw new Error("Perplexity returned empty content");
  return {
    id: "lazypath",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function pplxSseToOpenai(raw: string, model: string, state: StreamState): string {
  let out = "";
  const frames = sseData(raw);
  const failure = pplxFailures(frames);
  if (failure) state.done = true;
  for (const evt of frames) pplxApplyFrame(evt, state.tracks);
  if (state.done) return out;
  const answer = pplxAnswer(state.tracks);
  if (answer.length > state.emitted) {
    if (!state.role) {
      state.role = true;
      out += chunk(model, { role: "assistant" });
    }
    out += chunk(model, { content: answer.slice(state.emitted) });
    state.emitted = answer.length;
  }
  if (/(^|\n)event: end_of_stream/.test(raw)) {
    state.done = true;
    out += chunk(model, {}, "stop") + "data: [DONE]\n\n";
  }
  return out;
}

// --------------------------------------------------------------------------- claude (web) wire
// claude.ai's own API returns the app's JSON auth error for an anonymous request rather than a
// Cloudflare challenge, so a pasted sessionKey cookie over plain fetch is enough from this host.
// A fresh conversation is created per turn with the whole transcript folded into `prompt`,
// which keeps this stateless: no parent_message_uuid chaining cache is needed.

const CLAUDE_WEB_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const CLAUDE_DEFAULT_STYLE = {
  type: "default",
  key: "Default",
  name: "Normal",
  nameKey: "normal_style_name",
  prompt: "Normal\n",
  summary: "Default responses from Claude",
  summaryKey: "normal_style_summary",
  isDefault: true,
};

const claudeOrgCache = new Map<string, { id: string; ts: number }>();
const CLAUDE_ORG_TTL_MS = 30 * 60 * 1000;

function claudeWebHeaders(cookie: string, referer: string): Record<string, string> {
  const sessionKey = cookieValue(cookie, "sessionKey");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    origin: "https://claude.ai",
    referer,
    pragma: "no-cache",
    "sec-ch-ua": '"Chromium";v="149", "Not-A.Brand";v="24", "Google Chrome";v="149"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": CLAUDE_WEB_UA,
    "anthropic-client-platform": "web_claude_ai",
    cookie,
  };
  // the web app authenticates twice: the cookie jar and a bearer copy of sessionKey
  if (sessionKey) headers.authorization = `Bearer ${sessionKey}`;
  return headers;
}

async function claudeOrgId(baseUrl: string, cookie: string): Promise<string> {
  const key = createHash("sha256").update(cookie).digest("hex").slice(0, 16);
  const cached = claudeOrgCache.get(key);
  if (cached && Date.now() - cached.ts < CLAUDE_ORG_TTL_MS) return cached.id;
  const res = await fetch(`${baseUrl}/api/organizations`, {
    headers: claudeWebHeaders(cookie, "https://claude.ai/new"),
  });
  if (!res.ok) return "";
  const orgs = (await res.json().catch(() => null)) as { uuid?: string; id?: string }[] | null;
  const id = String(Array.isArray(orgs) ? (orgs[0]?.uuid ?? orgs[0]?.id ?? "") : "");
  if (id) claudeOrgCache.set(key, { id, ts: Date.now() });
  return id;
}

function claudeFoldMessages(messages: { role: string; content: unknown }[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = textOf(m.content);
    if (!text.trim()) continue;
    if (m.role === "system") parts.push(`[Instructions]\n${text}`);
    else if (m.role === "assistant") parts.push(`[Assistant]\n${text}`);
    else parts.push(text);
  }
  return parts.join("\n\n");
}

function claudeWebBody(prompt: string, model: string, thinking: boolean): Record<string, unknown> {
  return {
    prompt,
    model,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: "en-US",
    personalized_styles: [CLAUDE_DEFAULT_STYLE],
    tools: [],
    turn_message_uuids: { human_message_uuid: randomUUID(), assistant_message_uuid: randomUUID() },
    attachments: [],
    effort: thinking ? "high" : "low",
    files: [],
    sync_sources: [],
    rendering_mode: "messages",
    thinking_mode: thinking ? "extended" : "off",
    create_conversation_params: {
      name: "",
      model,
      include_conversation_preferences: true,
      paprika_mode: null,
      compass_mode: null,
      is_temporary: false,
      enabled_imagine: true,
      tool_search_mode: "auto",
    },
  };
}

function claudeWebText(raw: string): string {
  let text = "";
  for (const evt of sseData(raw)) {
    if (evt.type === "error") {
      const message = (evt as { error?: { error?: { message?: string } } }).error?.error?.message;
      throw new Error(`Claude: ${message ?? "completion failed"}`);
    }
    const delta = (evt.delta ?? {}) as { text?: string };
    if (evt.type === "content_block_delta" && typeof delta.text === "string") text += delta.text;
  }
  return text;
}

function fromClaudeWeb(raw: string, model: string) {
  const text = claudeWebText(raw);
  if (!text.trim()) throw new Error("Claude web returned empty content");
  return {
    id: "lazypath",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// --------------------------------------------------------------------------- zenmux free tier
// zenmux.ai's chat page speaks Anthropic's messages shape but guards it with the ctoken
// cookie replayed as a query parameter, and it streams even when asked not to.

const ZENMUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

function zenmuxHeaders(cookie: string) {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": ZENMUX_UA,
    origin: "https://zenmux.ai",
    referer: "https://zenmux.ai/platform/chat",
    "anthropic-version": "2023-06-01",
    "chat-request-id": randomUUID().replace(/-/g, ""),
    cookie,
  };
}

function fromZenmux(raw: string, model: string) {
  let text = "";
  for (const evt of sseData(raw)) {
    if (String(evt.type ?? "") !== "content_block_delta") continue;
    // thinking deltas stay out of the answer, matching the streaming path
    text += String((evt.delta as { text?: string } | undefined)?.text ?? "");
  }
  if (!text.trim()) throw new Error("ZenMux returned empty content");
  return {
    id: "lazypath",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: Math.ceil(text.length / 4), total_tokens: 0 },
  };
}

// --------------------------------------------------------------------------- adapta web
// The agent UI authenticates through Clerk: the __client cookie only buys a client
// record, and the inference call needs a short-lived session JWT minted per request.

const ADAPTA_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const ADAPTA_CLERK_VERSION = "5.127.1";
const adaptaJwtCache = new Map<string, { jwt: string; expiresAt: number }>();

async function adaptaJwt(authUrl: string, cookie: string): Promise<string> {
  const cached = adaptaJwtCache.get(cookie);
  if (cached && cached.expiresAt > Date.now()) return cached.jwt;
  const headers = {
    accept: "application/json",
    "user-agent": ADAPTA_UA,
    origin: "https://agent.adapta.one",
    referer: "https://agent.adapta.one/agentic-chat",
    cookie,
  };
  const client = await fetch(`${authUrl}/v1/client?_clerk_js_version=${ADAPTA_CLERK_VERSION}`, { headers });
  if (!client.ok) throw new Error(`adapta: clerk session rejected (${client.status})`);
  const sessions = ((await client.json()) as { response?: { sessions?: { status: string; id: string }[] } }).response?.sessions ?? [];
  const active = sessions.find((s) => s.status === "active");
  if (!active?.id) throw new Error("adapta: no active clerk session for this cookie");
  const mint = await fetch(`${authUrl}/v1/client/sessions/${encodeURIComponent(active.id)}/tokens?_clerk_js_version=${ADAPTA_CLERK_VERSION}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: "",
  });
  if (!mint.ok) throw new Error(`adapta: could not mint a session token (${mint.status})`);
  const jwt = String(((await mint.json()) as { jwt?: string }).jwt ?? "");
  if (!jwt.startsWith("eyJ")) throw new Error("adapta: clerk returned no session token");
  // Clerk tokens live ~60s; refresh well before that.
  adaptaJwtCache.set(cookie, { jwt, expiresAt: Date.now() + 30_000 });
  return jwt;
}

function adaptaBody(messages: { role: string; content: unknown }[]) {
  const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const turns = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, parts: [{ type: "text", text: textOf(m.content) }] }));
  if (system && turns.length && turns[0].role === "user") turns[0].parts[0].text = `[Instructions]\n${system}\n\n${turns[0].parts[0].text}`;
  else if (system) turns.unshift({ role: "user", parts: [{ type: "text", text: `[Instructions]\n${system}` }] });
  return { messages: turns, aiModelId: 14 };
}

function adaptaText(raw: string): string {
  let text = "";
  for (const evt of sseData(raw)) {
    const type = String(evt.type ?? "");
    if (type === "error") throw new Error(`adapta: ${String(evt.message ?? evt.error ?? "stream error")}`);
    if (type === "text-delta" && evt.id !== "quick-response") text += String(evt.delta ?? "");
  }
  return text;
}

function fromAdapta(raw: string, model: string) {
  const text = adaptaText(raw);
  if (!text.trim()) throw new Error("Adapta returned empty content");
  return {
    id: "lazypath",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function adaptaSseToOpenai(raw: string, model: string, state: { role: boolean; done: boolean }): string {
  let out = "";
  for (const evt of sseData(raw)) {
    const type = String(evt.type ?? "");
    if ((type === "error" || type === "done" || type === "end") && !state.done) {
      state.done = true;
      out += chunk(model, {}, "stop") + "data: [DONE]\n\n";
      break;
    }
    if (type === "text-delta" && evt.id !== "quick-response") {
      if (!state.role) {
        state.role = true;
        out += chunk(model, { role: "assistant" });
      }
      out += chunk(model, { content: String(evt.delta ?? "") });
    }
  }
  return out;
}

// --------------------------------------------------------------------------- hyperagent web
// Every turn runs inside a server-side thread, so the session first has to be opened,
// then told which model to latch, and only then handed the prompt.

const HYPER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

function hyperHeaders(baseUrl: string, cookie: string, referer: string) {
  return {
    accept: "text/event-stream, application/json",
    "content-type": "application/json",
    "user-agent": HYPER_UA,
    origin: baseUrl,
    referer,
    "x-request-id": randomUUID(),
    cookie,
  };
}

async function hyperThread(baseUrl: string, cookie: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/threads`, {
    method: "POST",
    headers: hyperHeaders(baseUrl, cookie, `${baseUrl}/`),
    body: "{}",
    redirect: "manual",
  });
  if (res.status >= 400) throw new Error(`hyperagent: could not open a thread (${res.status})`);
  const fromLocation = /\/thread\/([A-Za-z0-9_-]{6,})/.exec(res.headers.get("location") ?? "");
  if (fromLocation) return fromLocation[1];
  const text = await res.text();
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const id = j.id ?? j.threadId ?? j.thread_id ?? (j.thread as Record<string, unknown> | undefined)?.id;
    if (typeof id === "string" && id) return id;
  } catch {
    /* fall through to the body regex */
  }
  const fromBody = /(cm[a-z0-9]{16,})/i.exec(text);
  if (fromBody) return fromBody[1];
  throw new Error("hyperagent: thread id not found in the response");
}

function hyperBody(prompt: string) {
  return {
    sessionId: null,
    unifiedStream: true,
    searchMode: "exa",
    enableExecuteScript: false,
    enablePersistentSandbox: true,
    enableWebpage: true,
    enableSlides: true,
    tablesEnabled: true,
    enableWebSearch: true,
    enableBrowser: true,
    enableImageGeneration: true,
    enableVideoGeneration: true,
    enableAudioGeneration: true,
    enableTranscription: true,
    enableAvatarVideo: true,
    enableExaFindSimilar: true,
    enableExaAnswer: true,
    enableExaResearch: true,
    enableExaWebsets: true,
    enableGeoTools: true,
    hyperAppsEnabled: false,
    documentsEnabled: true,
    enableThreadSearch: true,
    residentialProxyEnabled: false,
    solveCaptchasEnabled: true,
    content: prompt,
    debug: false,
    enabledIntegrations: [],
    integrationMode: "open",
    globalTablesEnabled: true,
  };
}

function hyperText(raw: string): string {
  let text = "";
  for (const evt of sseData(raw)) {
    const type = String(evt.type ?? "");
    if (type === "error" || type === "stream_error") {
      throw new Error(`hyperagent: ${String(evt.content ?? evt.message ?? evt.error ?? "stream error")}`);
    }
    if (type === "text") text += String(evt.content ?? "");
  }
  return text;
}

function fromHyperAgent(raw: string, model: string) {
  const text = hyperText(raw);
  if (!text.trim()) throw new Error("Hyperagent returned empty content");
  return {
    id: "lazypath",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function hyperSseToOpenai(raw: string, model: string, state: { role: boolean; done: boolean }): string {
  let out = "";
  for (const line of raw.split("\n")) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data) continue;
    if (data === "[DONE]") {
      if (!state.done) {
        state.done = true;
        out += chunk(model, {}, "stop") + "data: [DONE]\n\n";
      }
      continue;
    }
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(evt.type ?? "");
    if (type === "error" || type === "stream_error") {
      if (!state.done) {
        state.done = true;
        out += chunk(model, {}, "stop") + "data: [DONE]\n\n";
      }
      break;
    }
    if (type === "text") {
      if (!state.role) {
        state.role = true;
        out += chunk(model, { role: "assistant" });
      }
      out += chunk(model, { content: String(evt.content ?? "") });
    }
  }
  return out;
}

// --------------------------------------------------------------------------- routing

interface Candidate {
  provider: ProviderDef;
  model: string;
}

function usable(): ProviderDef[] {
  const { disabled } = loadConfig();
  return PROVIDERS.filter((p) => !disabled.includes(p.id));
}

function presetChain(name: keyof Presets): Candidate[] {
  const allowed = new Set(usable().map((p) => p.id));
  const preferred = (loadConfig().presets[name] ?? [])
    .map(providerById)
    .filter((p): p is ProviderDef => !!p && allowed.has(p.id));
  // a preset can name providers this machine has not connected yet; rather than
  // failing, fall back to whatever is actually connected
  const seen = new Set(preferred.map((p) => p.id));
  const extra = usable().filter((p) => !seen.has(p.id) && tokenStore()[p.id]);
  return [...preferred, ...extra].map((p) => ({ provider: p, model: p.models[0]?.id ?? "default" }));
}

function explicitChain(model: string): Candidate[] {
  const [pid, ...rest] = model.split("/");
  const provider = usable().find((p) => p.id === pid);
  if (!provider) return [];
  return [{ provider, model: rest.join("/") || provider.models[0]?.id || "default" }];
}

function bareModelChain(model: string): Candidate[] {
  const connected = usable().filter((p) => tokenStore()[p.id]);
  const known = connected.filter((p) => p.models.some((m) => m.id === model));
  return (known.length ? known : connected).map((p) => ({ provider: p, model }));
}

function candidatesFor(model: string): Candidate[] {
  if (model === "smart" || model === "fast" || model === "cheap") return presetChain(model);
  if (model.includes("/")) return explicitChain(model);
  return bareModelChain(model);
}

async function prepare(candidates: Candidate[]) {
  const ready = [];
  for (const c of candidates) {
    const token = await validToken(c.provider);
    if (token) ready.push({ ...c, token });
  }
  return ready;
}

const retryable = (status: number) => status === 401 || status === 402 || status === 429 || status >= 500;

async function dispatch(a: { provider: ProviderDef; model: string; token: string }, body: Record<string, unknown>) {
  const { provider, model, token } = a;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    ...(provider.inference.headers ?? {}),
    ...(loadTokens()[provider.id]?.headers ?? {}),
  };
  // Cookie-logins carry the browser session in the Cookie header, not a bearer token.
  if (tokenStore()[provider.id]?.authMode === "cookie") {
    delete headers.authorization;
    headers.cookie = token;
  }
  // Keyless logins are anonymous by design, so the placeholder token never goes on the wire.
  if (provider.login === "none") delete headers.authorization;
  if (provider.inference.format === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    return fetch(`${provider.inference.baseUrl}/v1/messages`, { method: "POST", headers, body: JSON.stringify(toAnthropicBody(body, model)) });
  }
  if (provider.inference.format === "kiro") {
    Object.assign(headers, {
      accept: "application/vnd.amazon.eventstream",
      "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
      "user-agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0",
    });
    const arn = loadTokens()[provider.id]?.headers?.["x-kiro-profile-arn"];
    return fetch(`${provider.inference.baseUrl}/generateAssistantResponse`, {
      method: "POST",
      headers,
      body: JSON.stringify(toKiroBody(body, model, arn)),
    });
  }
  if (provider.inference.format === "responses") {
    headers.accept = "text/event-stream";
    if (provider.id === "grok") headers["x-grok-model-override"] = model;
    return fetch(`${provider.inference.baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify(toResponsesBody(body, model)) });
  }
  if (provider.inference.format === "huggingchat") {
    // HuggingChat is stateful: open a conversation, then post the turn into it.
    const messages = (body.messages ?? []) as { role: string; content: unknown }[];
    const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
    const chat = messages.filter((m) => m.role !== "system");
    const created = await fetch(`${provider.inference.baseUrl}/conversation`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, ...(system ? { preprompt: system } : {}) }),
    });
    if (!created.ok) return created;
    const conv = (await created.json().catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;
    const id = String(conv.conversationId ?? conv.id ?? "");
    if (!id) return new Response(JSON.stringify({ error: { message: "huggingchat: conversation not created" } }), { status: 502 });
    const data = {
      id: String(conv.messageId ?? ""),
      inputs: chat.at(-1) ? textOf(chat.at(-1)!.content) : "",
      is_retry: false,
      is_continue: false,
      response_id: null,
      files: [],
      selected_tools: [],
      selected_mcp_server_names: [],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    const fd = new FormData();
    fd.append("data", JSON.stringify(data));
    const sendHeaders = { ...headers };
    delete sendHeaders["content-type"];
    return fetch(`${provider.inference.baseUrl}/conversation/${id}`, { method: "POST", headers: sendHeaders, body: fd });
  }
  if (provider.inference.format === "kimiweb") {
    // the pasted value is a bearer token, not a Cookie header
    const raw = loadTokens()[provider.id]?.accessToken ?? "";
    const framed = new Uint8Array(kimiWebFrame(JSON.stringify(toKimiWebBody((body.messages ?? []) as { role: string; content: unknown }[], model))));
    const kimiHeaders = { ...headers };
    delete kimiHeaders.cookie;
    return fetch(`${provider.inference.baseUrl}${provider.inference.path ?? ""}`, {
      method: "POST",
      headers: {
        ...kimiHeaders,
        "content-type": "application/connect+json",
        accept: "*/*",
        "connect-protocol-version": "1",
        authorization: `Bearer ${kimiWebCredential(raw)}`,
        origin: "https://www.kimi.ai",
        referer: "https://www.kimi.ai/",
      },
      body: framed,
    });
  }
  if (provider.inference.format === "dola") {
    const cookie = dolaCookie(loadTokens()[provider.id]?.accessToken ?? "");
    const fingerprint = cookieValue(cookie, "s_v_web_id") || cookieValue(cookie, "fp");
    return fetch(dolaUrl(`${provider.inference.baseUrl}${provider.inference.path ?? ""}`, cookie), {
      method: "POST",
      headers: { ...headers, accept: "text/event-stream", "agw-js-conv": "str", origin: "https://www.dola.com", referer: "https://www.dola.com/chat/" },
      body: JSON.stringify(dolaBody((body.messages ?? []) as { role: string; content: unknown }[], model, fingerprint)),
    });
  }
  if (provider.inference.format === "zaiweb") {
    const raw = loadTokens()[provider.id]?.accessToken ?? "";
    const token = zaiCredential(raw);
    const userId = zaiUserId(token);
    if (!token || !userId) return new Response(JSON.stringify({ error: { message: "zai-web: invalid token" } }), { status: 401 });
    const messages = (body.messages ?? []) as { role: string; content: unknown }[];
    const prompt = zaiPrompt(messages);
    const requestId = randomBytes(16).toString("hex");
    const timestamp = Date.now();
    const signature = zaiSignature({ prompt, requestId, timestamp, userId });
    const zaiHeaders: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      "accept-language": "en-US",
      authorization: `Bearer ${token}`,
      origin: "https://chat.z.ai",
      referer: "https://chat.z.ai/",
      "x-fe-version": "prod-fe-1.1.92",
      "x-signature": signature,
    };
    const newChat = await fetch(`${provider.inference.baseUrl}/api/v1/chats/new`, {
      method: "POST",
      headers: zaiHeaders,
      body: JSON.stringify(zaiNewChatBody(messages, model)),
    });
    if (!newChat.ok) return newChat;
    const newChatJson = (await newChat.json().catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;
    const payload = (newChatJson.payload ?? {}) as Record<string, unknown>;
    const chatData = (payload.chat ?? {}) as Record<string, unknown>;
    const history = (chatData.history ?? {}) as Record<string, unknown>;
    const messagesMap = (history.messages ?? {}) as Record<string, Record<string, unknown>>;
    const chatId = String(chatData.id ?? "");
    const userMessageId = String(history.currentId ?? "");
    if (!chatId || !userMessageId) return new Response(JSON.stringify({ error: { message: "zai-web: could not create chat" } }), { status: 502 });
    const query = new URLSearchParams({
      timestamp: String(timestamp), requestId, user_id: userId, version: "0.0.1", platform: "web", token,
      user_agent: "Mozilla/5.0", language: "en-US", languages: "en-US,en", timezone: "UTC", cookie_enabled: "true",
      screen_width: "1280", screen_height: "800", screen_resolution: "1280x800", viewport_height: "800", viewport_width: "1280",
      viewport_size: "1280x800", color_depth: "24", pixel_ratio: "1", current_url: "https://chat.z.ai/", pathname: "/", search: "", hash: "",
      host: "chat.z.ai", hostname: "chat.z.ai", protocol: "https:", referrer: "", title: "Z.ai", timezone_offset: "0",
      local_time: new Date(timestamp).toISOString(), utc_time: new Date(timestamp).toUTCString(), is_mobile: "false", is_touch: "false",
      max_touch_points: "0", browser_name: "Chrome", os_name: "Mac OS", signature_timestamp: String(timestamp),
    });
    return fetch(`${provider.inference.baseUrl}/api/v2/chat/completions?${query.toString()}`, {
      method: "POST",
      headers: zaiHeaders,
      body: JSON.stringify(zaiRequestBody({ chatId, messages, modelId: model, prompt, userMessageId, captchaVerifyParam: zaiCaptcha(raw) })),
    });
  }
  if (provider.inference.format === "innerai") {
    const raw = loadTokens()[provider.id]?.accessToken ?? "";
    const { token, email } = innerAiCredential(raw);
    const deviceId = innerAiDeviceId(token);
    if (!token) return new Response(JSON.stringify({ error: { message: "inner-ai: invalid token" } }), { status: 401 });
    const innerHeaders = innerAiHeaders(token, deviceId, email);
    return fetch(`${provider.inference.baseUrl}${provider.inference.path ?? "/chat"}`, {
      method: "POST",
      headers: innerHeaders,
      body: JSON.stringify(innerAiBody((body.messages ?? []) as { role: string; content: unknown }[], model)),
    });
  }
  if (provider.inference.format === "pplxweb") {
    const cookie = webCookie(provider.inference.format, loadTokens()[provider.id]?.accessToken ?? "");
    if (!cookie) return new Response(JSON.stringify({ error: { message: "perplexity-web: no session cookie" } }), { status: 401 });
    const messages = (body.messages ?? []) as { role: string; content: unknown }[];
    const { query, current } = pplxFoldMessages(messages);
    const requestId = randomUUID();
    return fetch(`${provider.inference.baseUrl}${provider.inference.path ?? "/rest/sse/perplexity_ask"}`, {
      method: "POST",
      headers: pplxHeaders(cookie, requestId),
      body: JSON.stringify(pplxBody(query, current, model, requestId)),
    });
  }
  if (provider.inference.format === "claudeweb") {
    const cookie = webCookie(provider.inference.format, loadTokens()[provider.id]?.accessToken ?? "");
    if (!cookie) return new Response(JSON.stringify({ error: { message: "claude-web: no sessionKey cookie" } }), { status: 401 });
    const orgId = await claudeOrgId(provider.inference.baseUrl, cookie);
    if (!orgId) return new Response(JSON.stringify({ error: { message: "claude-web: session rejected by /api/organizations" } }), { status: 401 });
    const messages = (body.messages ?? []) as { role: string; content: unknown }[];
    const prompt = claudeFoldMessages(messages);
    if (!prompt.trim()) return new Response(JSON.stringify({ error: { message: "claude-web: empty prompt" } }), { status: 400 });
    const thinking = body.thinking === true || (body.reasoning_effort != null && body.reasoning_effort !== "none");
    const conversationId = randomUUID();
    return fetch(
      `${provider.inference.baseUrl}/api/organizations/${encodeURIComponent(orgId)}/chat_conversations/${conversationId}/completion`,
      {
        method: "POST",
        headers: claudeWebHeaders(cookie, "https://claude.ai/new"),
        body: JSON.stringify(claudeWebBody(prompt, model, thinking)),
      },
    );
  }
  if (provider.inference.format === "zenmux") {
    const cookie = token;
    const ctoken = cookieValue(cookie, "ctoken");
    if (!ctoken) return new Response(JSON.stringify({ error: { message: "zenmux-free: paste the full Cookie header, it must contain ctoken" } }), { status: 401 });
    return fetch(`${provider.inference.baseUrl}${provider.inference.path ?? "/api/anthropic/v1/messages"}?ctoken=${encodeURIComponent(ctoken)}`, {
      method: "POST",
      headers: zenmuxHeaders(cookie),
      body: JSON.stringify({ ...toAnthropicBody(body, model), stream: true }),
    });
  }
  if (provider.inference.format === "adapta") {
    const cookie = webCookie("adapta", token);
    if (!cookie) return new Response(JSON.stringify({ error: { message: "adapta-web: no __client cookie" } }), { status: 401 });
    const messages = (body.messages ?? []) as { role: string; content: unknown }[];
    let jwt: string;
    try {
      jwt = await adaptaJwt(provider.inference.authUrl ?? provider.inference.baseUrl, cookie);
    } catch (err) {
      return new Response(JSON.stringify({ error: { message: String(err) } }), { status: 401 });
    }
    return fetch(`${provider.inference.baseUrl}${provider.inference.path ?? "/api/chat/stream/v1"}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        "user-agent": ADAPTA_UA,
        origin: provider.inference.baseUrl,
        referer: `${provider.inference.baseUrl}/agentic-chat`,
      },
      body: JSON.stringify(adaptaBody(messages)),
    });
  }
  if (provider.inference.format === "hyperagent") {
    const cookie = token;
    if (!cookie) return new Response(JSON.stringify({ error: { message: "hyperagent-web: no session cookie" } }), { status: 401 });
    const base = provider.inference.baseUrl;
    const messages = (body.messages ?? []) as { role: string; content: unknown }[];
    const prompt = messages.map((m) => textOf(m.content)).filter(Boolean).join("\n");
    let threadId: string;
    try {
      threadId = await hyperThread(base, cookie);
    } catch (err) {
      return new Response(JSON.stringify({ error: { message: String(err) } }), { status: 401 });
    }
    const referer = `${base}/thread/${threadId}`;
    // The thread has to be told which model to latch before it will accept a prompt.
    await fetch(`${base}/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      headers: hyperHeaders(base, cookie, referer),
      body: JSON.stringify({
        modelId: model,
        defaultSubagentModel: /fable|opus|sonnet|haiku/.exec(model)?.[0] ?? "sonnet",
        runtimeId: "claude-agents-sdk",
        executionMode: "auto",
      }),
    }).catch(() => undefined);
    return fetch(`${base}/api/threads/${encodeURIComponent(threadId)}/chat`, {
      method: "POST",
      headers: hyperHeaders(base, cookie, referer),
      body: JSON.stringify(hyperBody(prompt)),
    });
  }
  return fetch(`${provider.inference.baseUrl}${provider.inference.path ?? "/chat/completions"}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, model }),
  });
}

interface Attempt {
  provider: string;
  status?: number;
  detail: string;
}

async function routeChat(model: string, body: Record<string, unknown>) {
  const attempts = await prepare(candidatesFor(model));
  const tried: Attempt[] = [];
  const fail = (status: number) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify({ error: { message: `lazypath: no provider could serve "${model}"`, attempts: tried } }),
    providerUsed: "none",
    modelUsed: model,
  });
  if (attempts.length === 0) return fail(502);

  for (const a of attempts) {
    let res: Response;
    try {
      res = await dispatch(a, body);
    } catch (err) {
      recordUsage(a.provider.id, false, 0, 0);
      tried.push({ provider: a.provider.id, detail: String(err) });
      continue;
    }
    const kiro = a.provider.inference.format === "kiro";
    const binary = kiro || a.provider.inference.format === "kimiweb";
    const bytes = binary ? Buffer.from(await res.arrayBuffer()) : Buffer.from(await res.text(), "utf8");
    const raw = bytes.toString("utf8");
    if (!res.ok) {
      recordUsage(a.provider.id, false, 0, 0);
      tried.push({ provider: a.provider.id, status: res.status, detail: raw.slice(0, 300) });
      if (!retryable(res.status)) break;
      continue;
    }
    let text = raw;
    try {
      if (kiro) {
        text = JSON.stringify(fromKiro(bytes, a.model));
      } else if (a.provider.inference.format === "kimiweb") {
        text = JSON.stringify(fromKimiWeb(bytes, a.model));
      } else if (a.provider.inference.format === "dola") {
        text = JSON.stringify(fromDola(raw, a.model));
      } else if (a.provider.inference.format === "zaiweb") {
        text = JSON.stringify(fromZaiWeb(raw, a.model));
      } else if (a.provider.inference.format === "innerai") {
        text = JSON.stringify(fromInnerAi(raw, a.model));
      } else if (a.provider.inference.format === "pplxweb") {
        text = JSON.stringify(fromPplx(raw, a.model));
      } else if (a.provider.inference.format === "claudeweb") {
        text = JSON.stringify(fromClaudeWeb(raw, a.model));
      } else if (a.provider.inference.format === "zenmux") {
        text = JSON.stringify(fromZenmux(raw, a.model));
      } else if (a.provider.inference.format === "adapta") {
        text = JSON.stringify(fromAdapta(raw, a.model));
      } else if (a.provider.inference.format === "hyperagent") {
        text = JSON.stringify(fromHyperAgent(raw, a.model));
      } else if (a.provider.inference.format === "responses") {
        text = JSON.stringify(fromResponses(raw, a.model));
      } else if (a.provider.inference.format === "huggingchat") {
        text = JSON.stringify(fromHuggingchat(raw, a.model));
      } else if (a.provider.inference.format === "anthropic") {
        try {
          text = JSON.stringify(fromAnthropic(JSON.parse(raw) as Record<string, unknown>, a.model));
        } catch {
          /* pass through */
        }
      }
    } catch (err) {
      // a wire-level rejection (dola answers 200 with a STREAM_ERROR frame) is a failed attempt
      recordUsage(a.provider.id, false, 0, 0);
      tried.push({ provider: a.provider.id, detail: String(err) });
      continue;
    }
    let inTok = 0;
    let outTok = 0;
    try {
      const u = (JSON.parse(text) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
      inTok = u?.prompt_tokens ?? 0;
      outTok = u?.completion_tokens ?? 0;
    } catch {
      /* non-JSON response: count the request only */
    }
    recordUsage(a.provider.id, true, inTok, outTok);
    return { status: res.status, contentType: "application/json", body: text, providerUsed: a.provider.id, modelUsed: a.model };
  }
  return fail(tried.at(-1)?.status ?? 502);
}

async function routeChatStream(model: string, body: Record<string, unknown>) {
  const attempts = await prepare(candidatesFor(model));
  const tried: Attempt[] = [];
  for (const a of attempts) {
    let res: Response;
    try {
      res = await dispatch(a, body);
    } catch (err) {
      recordUsage(a.provider.id, false, 0, 0);
      tried.push({ provider: a.provider.id, detail: String(err) });
      continue;
    }
    if (res.ok) {
      recordUsage(a.provider.id, true, 0, 0);
      return { response: res, providerUsed: a.provider.id, modelUsed: a.model, format: a.provider.inference.format, errors: tried };
    }
    recordUsage(a.provider.id, false, 0, 0);
    tried.push({ provider: a.provider.id, status: res.status, detail: (await res.text()).slice(0, 300) });
    if (!retryable(res.status)) break;
  }
  return { response: null, errors: tried };
}

function listAllModels() {
  const tokens = tokenStore();
  const out = [];
  for (const p of PROVIDERS) for (const m of p.models) out.push({ id: `${p.id}/${m.id}`, owned_by: p.id, connected: !!tokens[p.id] });
  for (const n of ["smart", "fast", "cheap"]) out.push({ id: n, owned_by: "lazypath-preset", connected: true });
  return out;
}

// --------------------------------------------------------------------------- dashboard

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lazypath</title>
<style>
  :root{--bg:#000;--card:#0b0e14;--card2:#161b24;--line:#242c39;--txt:#eef2f8;--dim:#8b96ab;--acc:#5eead4;--ok:#22c55e;--warn:#f59e0b;--bad:#ef4444}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--txt)}
  main{max-width:1080px;margin:0 auto;padding:26px 18px 70px}
  h1{font-size:19px;margin:0;letter-spacing:-.01em}
  h1 b{color:var(--acc);font-weight:600}
  .sub{color:var(--dim);font-size:13px;margin:2px 0 20px}
  h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:26px 0 10px;font-weight:500;display:flex;align-items:center;gap:8px}
  h2 em{font-style:normal;text-transform:none;letter-spacing:0;font-weight:400;font-size:11px;color:var(--acc);background:rgba(94,234,212,.1);border-radius:99px;padding:1px 8px}
  h2 span{font-size:11px;text-transform:none;letter-spacing:0;font-weight:400}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .row{display:flex;align-items:center;gap:12px}
  .grow{flex:1;min-width:0}
  button{font:inherit;border:0;border-radius:8px;padding:7px 14px;background:var(--acc);color:#06231f;font-weight:500;cursor:pointer}
  button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line);font-weight:400}
  a.btn{display:inline-block;text-decoration:none;border-radius:8px;padding:7px 14px;background:var(--acc);color:#06231f;font-weight:500}
  a.btn.ghost{background:transparent;color:var(--dim);border:1px solid var(--line);font-weight:400}
  .url{font:11px ui-monospace,Consolas,monospace;color:var(--dim);word-break:break-all;user-select:all;margin:4px 0 0}
  input{font:inherit;background:#05070b;border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:8px 11px;min-width:0;width:100%}
  textarea{font:12.5px ui-monospace,Consolas,monospace;background:#05070b;border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:9px 11px;width:100%;resize:vertical;min-height:64px}
  a{color:var(--acc)}
  code,pre{font:12.5px ui-monospace,Consolas,monospace}
  pre{background:#05070b;border:1px solid var(--line);border-radius:8px;padding:11px;overflow-x:auto;margin:0}
  .topbar{display:flex;gap:12px;align-items:center;margin-bottom:14px;flex-wrap:wrap}
  .search{flex:1;min-width:180px;position:relative}
  .search input{padding-left:32px}
  .search:before{content:"⌕";position:absolute;left:11px;top:6px;color:var(--dim);font-size:16px}
  .chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px}
  .chip{font-size:12px;border:1px solid var(--line);background:var(--card);border-radius:99px;padding:3px 11px;color:var(--dim);cursor:pointer}
  .chip.sel{background:var(--acc);color:#06231f;border-color:var(--acc);font-weight:500}
  .chip i{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:6px;vertical-align:1px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(238px,1fr));gap:10px}
  .pcard{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 13px;cursor:pointer;transition:border-color .12s}
  .pcard:hover{border-color:#3a4763}
  .pcard.on{border-color:#2f6f63}
  .pcard.off{opacity:.55}
  .phead{display:flex;align-items:center;gap:10px}
  .av{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;font-weight:600;font-size:15px;color:#fff;flex:none;overflow:hidden;background:#000;border:1px solid var(--line)}
  .av svg,.av img{width:22px;height:22px;display:block}
  .av.mono{background-color:var(--pc);border-color:transparent;background-image:linear-gradient(180deg,rgba(255,255,255,.18),rgba(255,255,255,0) 55%)}
  .av-big{width:46px;height:46px;border-radius:13px;font-size:19px}
  .av-big svg,.av-big img{width:28px;height:28px}
  .pname{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pstat{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dim);margin-top:9px}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--line);flex:none}
  .dot.on{background:var(--ok)}
  .tag{font-size:10.5px;border:1px solid var(--line);border-radius:5px;padding:1px 6px;color:var(--dim);margin-left:auto;white-space:nowrap}
  .tag.risk{border-color:#5c4517;color:var(--warn)}
  .sw{margin-left:auto;flex:none;width:34px;height:19px;border-radius:99px;background:var(--card2);border:1px solid var(--line);position:relative;cursor:pointer}
  .sw:after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--dim);transition:transform .14s}
  .sw.on{background:rgba(94,234,212,.22);border-color:var(--acc)}
  .sw.on:after{transform:translateX(15px);background:var(--acc)}
  .pbar{height:4px;border-radius:99px;background:var(--card2);overflow:hidden;margin-top:10px}
  .pbar i{display:block;height:100%;border-radius:99px}
  .ubar{height:16px;border-radius:6px;overflow:hidden;display:flex;background:var(--card2);margin:4px 0 10px}
  .ubar span{height:100%}
  .lg{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--dim)}
  .lg i{width:9px;height:9px;border-radius:3px;display:inline-block;margin-right:5px}
  .stat{display:flex;gap:26px;flex-wrap:wrap;margin-bottom:6px}
  .stat div{font-size:12px;color:var(--dim)}
  .stat b{display:block;font-size:17px;color:var(--txt);font-weight:600}
  .pill{border:1px solid var(--line);border-radius:7px;padding:3px 9px;font-size:12px;cursor:pointer;margin:2px 3px 2px 0;display:inline-block}
  .pill.sel{border-color:var(--acc);color:var(--acc)}
  .kbd{background:#05070b;border:1px solid var(--line);border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px}
  .code{font:24px ui-monospace,Consolas,monospace;letter-spacing:.16em;color:var(--acc);background:#05070b;border:1px dashed var(--line);border-radius:9px;padding:11px 16px;display:inline-block;margin:6px 0}
  .wait{font-size:13px;color:var(--dim)}
  .spin{display:inline-block;width:10px;height:10px;border:2px solid var(--line);border-top-color:var(--acc);border-radius:50%;animation:s 1s linear infinite;margin-right:7px;vertical-align:-1px}
  @keyframes s{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.spin{animation:none}}
  .scrim{position:fixed;inset:0;background:rgba(4,6,10,.72);display:none;align-items:flex-start;justify-content:center;padding:40px 16px;z-index:9;overflow:auto}
  .scrim.show{display:flex}
  .modal{background:var(--card);border:1px solid var(--line);border-radius:14px;max-width:460px;width:100%;padding:18px}
  .mhead{display:flex;align-items:center;gap:11px;margin-bottom:14px}
  .close{margin-left:auto;background:transparent;border:0;color:var(--dim);font-size:20px;cursor:pointer;padding:0 6px}
  .mrow{display:flex;gap:8px;align-items:center;margin:12px 0}
  .msec{border-top:1px solid var(--line);margin-top:14px;padding-top:12px;font-size:12px;color:var(--dim)}
</style>
</head>
<body>
<main>
  <h1>lazy<b>path</b></h1>
  <div class="sub">One endpoint for every model. Logged in by account - no API keys to paste.</div>

  <div class="card row" style="margin-bottom:6px">
    <div class="grow"><div class="wait">Gateway key</div><code id="k"></code></div>
    <span class="kbd" onclick="copyKey()">copy</span>
    <button class="ghost" onclick="act('rotate',{}).then(load)">rotate</button>
  </div>

  <h2>Usage</h2>
  <div class="card">
    <div class="stat" id="stat"></div>
    <div class="ubar" id="ubar"></div>
    <div class="lg" id="lg"></div>
  </div>

  <h2>Providers <span class="meta">- click a card to connect, use the switch to include or skip it</span></h2>
  <div class="topbar">
    <div class="search"><input id="q" placeholder="Search providers" oninput="FILTER.q=this.value;render()"></div>
  </div>
  <div class="chips" id="chips"></div>
  <div id="groups"></div>

  <h2>Easy mode <span class="meta">- model names you can just use</span></h2>
  <div class="card" id="presets"></div>

  <h2>Try it</h2>
  <div class="card"><pre id="curl"></pre></div>
</main>

<div class="scrim" id="scrim" onclick="if(event.target.id==='scrim')closeModal()">
  <div class="modal" id="modal"></div>
</div>

<script>
var S, FILTER={q:"",chip:"all"}, MODAL=null;
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")}
function av(p,cls){return '<span class="'+(cls||'av')+(p.logo?'':' mono')+'" style="--pc:'+p.color+'">'+(p.logo||esc(p.monogram))+'</span>'}
async function act(path,body){
  var r=await fetch("/api/"+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body||{})});
  var j=await r.json().catch(function(){return{}});
  if(!r.ok){alert((j.error&&j.error.message)||j.error||("HTTP "+r.status));return null}
  return j
}
function totals(){var u=S.usage||{},req=0,ok=0,tok=0;for(var k in u){req+=u[k].requests;ok+=u[k].ok;tok+=u[k].inputTokens+u[k].outputTokens}return{req:req,ok:ok,tok:tok}}
function visible(p){
  if(FILTER.q && (p.label+" "+p.id).toLowerCase().indexOf(FILTER.q.toLowerCase())<0)return false;
  if(FILTER.chip==="connected")return p.connected;
  if(FILTER.chip==="ready")return p.connected&&!p.disabled;
  if(FILTER.chip==="risk")return p.trust==="tosrisk";
  if(FILTER.chip==="paste")return p.group==="Browser login";
  return true;
}
function renderUsage(){
  var t=totals();
  document.getElementById("stat").innerHTML='<div><b>'+t.req+'</b>requests</div><div><b>'+t.ok+'</b>ok</div><div><b>'+t.tok.toLocaleString()+'</b>tokens</div>';
  var rows=S.providers.filter(function(p){return p.usage.requests>0}).sort(function(a,b){return b.usage.requests-a.usage.requests});
  document.getElementById("ubar").innerHTML=rows.length
    ? rows.map(function(p){return '<span title="'+esc(p.label)+" ("+p.usage.requests+' requests)" style="width:'+(p.usage.requests/Math.max(1,t.req)*100)+'%;background:'+p.color+'"></span>'}).join("")
    : '<span style="width:100%"></span>';
  document.getElementById("lg").innerHTML=rows.length
    ? rows.map(function(p){return '<span><i style="background:'+p.color+'"></i>'+esc(p.label)+' '+p.usage.requests+'</span>'}).join("")
    : '<span class="wait">no traffic yet - connect a provider, then send a request</span>';
}
function renderChips(){
  var n=S.providers,conn=n.filter(function(p){return p.connected}).length;
  var defs=[["all","Total "+n.length,null],["connected","Connected "+conn,"var(--ok)"],["ready","Active "+n.filter(function(p){return p.connected&&!p.disabled}).length,"var(--acc)"],["paste","Browser login "+n.filter(function(p){return p.group==="Browser login"}).length,"#60a5fa"],["risk","ToS risk "+n.filter(function(p){return p.trust==="tosrisk"}).length,"var(--warn)"]];
  document.getElementById("chips").innerHTML=defs.map(function(d){
    return '<span class="chip'+(FILTER.chip===d[0]?" sel":"")+'" onclick="FILTER.chip=\''+d[0]+'\';render()">'+(d[2]?'<i style="background:'+d[2]+'"></i>':'')+d[1]+'</span>'
  }).join("")
}
function card(p){
  var d=document.createElement("div");
  d.className="pcard"+(p.connected?" on":"")+(p.disabled?" off":"");
  var stat=p.pending?'<span class="spin"></span>waiting for approval'
    :p.connected?'<span class="dot on"></span>connected'
    :'<span class="dot"></span>no connection';
  var tag=p.trust==="tosrisk"?'<span class="tag risk">ToS risk</span>':({cookie:'<span class="tag">browser</span>',none:'<span class="tag">keyless</span>',paste:'<span class="tag">pasted key</span>',device:'<span class="tag">device</span>'}[p.login]||'');
  d.innerHTML='<div class="phead">'+av(p)+'<div class="grow"><div class="pname">'+esc(p.label)+'</div></div>'+
    '<span class="sw'+(p.disabled?"":" on")+'" onclick="event.stopPropagation();toggle(\''+p.id+'\')"></span></div>'+
    '<div class="pstat">'+stat+tag+'</div>'+
    '<div class="pbar"><i style="width:'+Math.min(100,p.usage.requests/Math.max(1,S._max)*100)+'%;background:'+p.color+'"></i></div>';
  d.onclick=function(){openCard(p.id)};
  return d;
}
function render(){
  renderChips();
  document.getElementById("k").textContent=S.gatewayKey;
  S._max=Math.max(1,S.providers.reduce(function(a,p){return Math.max(a,p.usage.requests)},0));
  document.getElementById("curl").textContent='curl '+S.baseUrl+'/v1/chat/completions \\\n  -H "Authorization: Bearer '+S.gatewayKey+'" \\\n  -H "content-type: application/json" \\\n  -d \'{"model":"smart","messages":[{"role":"user","content":"hi"}],"stream":true}\'';
  var groups={};
  S.providers.filter(visible).forEach(function(p){(groups[p.group]=groups[p.group]||[]).push(p)});
  var host=document.getElementById("groups");host.innerHTML="";
  var names=Object.keys(groups);
  if(!names.length){host.innerHTML='<div class="card wait">no providers match that filter</div>'}
  names.forEach(function(g){
    var h=document.createElement("h2");h.innerHTML=esc(g)+' <em>'+groups[g].length+'</em>';host.appendChild(h);
    var grid=document.createElement("div");grid.className="grid";grid.style.marginBottom="18px";
    groups[g].forEach(function(p){grid.appendChild(card(p))});
    host.appendChild(grid);
  });
  renderUsage();
  var pr=document.getElementById("presets");pr.innerHTML="";
  ["smart","fast","cheap"].forEach(function(name){
    var chain=S.presets[name]||[];
    var div=document.createElement("div");div.style.marginBottom="10px";
    div.innerHTML='<b>'+name+'</b> <span class="wait">→</span> '+(chain.length?chain.map(esc).join(" → "):'<span class="wait">nothing chosen yet</span>')+"<br>";
    S.providers.forEach(function(p){
      var pill=document.createElement("span");pill.className="pill"+(chain.indexOf(p.id)>=0?" sel":"");pill.textContent=p.id;
      pill.onclick=function(){
        var next=chain.indexOf(p.id)>=0?chain.filter(function(x){return x!==p.id}):chain.concat([p.id]);
        act("preset",{preset:name,chain:next}).then(function(){load(true)});
      };
      div.appendChild(pill);
    });
    pr.appendChild(div);
  });
  if(MODAL)paintModal();
}
async function toggle(id){await act("toggle",{provider:id});load(true)}
function openCard(id){MODAL=id;document.getElementById("scrim").classList.add("show");paintModal()}
// not close/open: inline handlers resolve names against document first, and
// document.close/document.open silently swallow both clicks
function closeModal(){MODAL=null;document.getElementById("scrim").classList.remove("show")}
function paintModal(){
  var p=S.providers.filter(function(x){return x.id===MODAL})[0];
  if(!p){return closeModal()}
  var m=document.getElementById("modal");
  var head='<div class="mhead">'+av(p,"av av-big")+'<div class="grow"><b>'+esc(p.label)+'</b><div class="wait">'+(p.trust==="tosrisk"?"provider restricts this login to its own tools":p.trust==="community"?"community-documented flow":"official login flow")+'</div></div><button class="close" onclick="closeModal()">×</button></div>';
  var body="";
  if(p.pending){
    var code=p.pending.userCode||"";
    // providers that hand back a complete device URL already carry the code, so there is
    // nothing left to type; the rest (GitHub, OpenAI) only give the bare page
    var prefilled=code!==""&&p.pending.verifyUrl.indexOf(code)>=0;
    body='<div class="wait">'+(code
        ?prefilled?'the link below already contains the code - open it and approve.'
        :'open the link, paste the code, then approve the access.'
        :'open the link below and approve - nothing to type.')+'</div>'+
      (code&&!prefilled?'<div class="mrow"><button class="ghost" onclick="copyCode(\''+esc(code)+'\',this)">copy code</button><span class="code">'+esc(code)+'</span></div>':'')+
      '<div class="mrow"><a class="btn" href="'+esc(p.pending.verifyUrl)+'" target="_blank" rel="noopener">open login page</a><button class="ghost" onclick="copyCode(\''+esc(p.pending.verifyUrl)+'\',this)">copy link</button><span class="wait"><span class="spin"></span>waiting…</span></div>'+
      '<div class="url">'+esc(p.pending.verifyUrl)+'</div>';
  } else if(p.connected){
    body='<div class="wait">Connected'+(p.expiresAt?' · token refreshes automatically':"")+'.</div>'+
      '<div class="mrow"><button class="ghost" onclick="act(\'disconnect\',{provider:\''+p.id+'\'}).then(function(){load(true)})">Disconnect</button></div>';
  } else if(p.login==="device"){
    body='<div class="mrow"><button onclick="connect(\''+p.id+'\')">Connect account</button></div><div class="wait">Opens the provider login page and waits for you to approve. Nothing to copy back.</div>';
  } else if(p.login==="cookie"){
    body=(p.site?'<div class="mrow"><a class="btn" href="'+esc(p.site)+'" target="_blank" rel="noopener">open the site</a><button class="ghost" onclick="copyCode(\''+esc(p.site)+'\',this)">copy link</button></div>':'')+
      '<div class="wait">'+(p.hint?esc(p.hint):'This service has no OAuth login. Sign in on the site, open DevTools &gt; Network, copy the <b>Cookie</b> header of any request and paste it here:')+'</div>'+
      '<div class="mrow"><textarea id="paste" placeholder="cookie: session=…"></textarea></div>'+
      '<div class="mrow"><button onclick="finish(\''+p.id+'\')">Save cookie</button></div>';
  } else {
    body=(p.loginUrl
        ?'<div class="mrow"><a class="btn" href="'+esc(p.loginUrl)+'" target="_blank" rel="noopener">open login page</a><button class="ghost" onclick="copyCode(\''+esc(p.loginUrl)+'\',this)">copy link</button></div><div class="url">'+esc(p.loginUrl)+'</div>'
        :'<div class="mrow"><button onclick="connect(\''+p.id+'\')">Open login page</button></div>')+
      '<div class="wait">'+(p.hint?esc(p.hint):'After approving, the provider shows a long code. Paste it here:')+'</div>'+
      '<div class="mrow"><textarea id="paste" placeholder="'+(p.hint?'paste key':'paste code')+'"></textarea></div>'+
      '<div class="mrow"><button onclick="finish(\''+p.id+'\')">Finish</button></div>';
  }
  var u=p.usage;
  m.innerHTML=head+body+'<div class="msec">'+esc(p.models.map(function(x){return x.id}).join(", "))+'</div>'+
    '<div class="msec">'+u.requests+' requests · '+u.ok+' ok · '+u.failed+' failed · '+(u.inputTokens+u.outputTokens).toLocaleString()+' tokens</div>';
}
function connect(id){
  // open the tab before awaiting, otherwise popup blockers eat it; when even that is
  // blocked (embedded webviews) the modal renders a real <a> instead
  var tab=window.open("about:blank","_blank");
  act("connect",{provider:id}).then(function(r){
    if(!r){if(tab)tab.close();return}
    if(r.alreadyConnected){if(tab)tab.close();return load(true)}
    var url=r.kind==="device"?r.verifyUrl:r.url;
    if(tab&&url){try{tab.location.href=url}catch(e){}}else if(tab){tab.close()}
    S.providers.forEach(function(p){
      if(p.id!==id)return;
      if(r.kind==="device")p.pending={userCode:r.userCode||"",verifyUrl:r.verifyUrl};
      else if(r.url)p.loginUrl=r.url;
    });
    load(true);
  });
}
function copyCode(c,el){navigator.clipboard.writeText(c);if(el)el.textContent="copied"}
async function finish(id){
  var v=document.getElementById("paste").value;
  await act("finish",{provider:id,code:v});
  load(true);
}
async function copyKey(){navigator.clipboard.writeText(S.gatewayKey)}
async function load(force){
  var s=await(await fetch("/api/summary")).json();
  var sig=JSON.stringify(s);
  S=s;
  if(!force&&sig===load.last)return;   // unchanged: skip rebuild so modals stay put
  load.last=sig;render();
}
load();
setInterval(function(){load()},3000);
</script>
</body>
</html>`;

// --------------------------------------------------------------------------- dashboard API

function summary(base: string) {
  const tokens = tokenStore();
  const usage = readJson<Record<string, UsageRow>>(USAGE_FILE, {});
  const cfg = loadConfig();
  return {
    gatewayKey: cfg.gatewayKey,
    presets: cfg.presets,
    baseUrl: base,
    usage,
    providers: PROVIDERS.map((p) => {
      const t = tokens[p.id];
      const login = activeLogins.get(p.id);
      return {
        id: p.id,
        label: p.label,
        monogram: p.monogram,
        logo: p.logo,
        color: p.color,
        group: p.group,
        models: p.models,
        login: p.login,
        site: p.site,
        hint: p.hint,
        trust: p.trust,
        connected: !!t,
        disabled: cfg.disabled.includes(p.id),
        expiresAt: t?.expiresAt,
        usage: usage[p.id] ?? emptyRow(),
        pending: login && login.session.kind === "device" ? { userCode: login.session.userCode, verifyUrl: login.session.verifyUrl } : null,
      };
    }),
  };
}

// --------------------------------------------------------------------------- command line
// Typing `lazypath` in a terminal should feel like the other local gateways: a banner,
// the dashboard opening by itself, and a clean exit when one is already running.

const VERSION = (() => {
  try {
    return String((JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8")) as { version?: string }).version ?? "dev");
  } catch {
    return "dev";
  }
})();

const ARGS = process.argv.slice(2);
const argValue = (name: string) => {
  const i = ARGS.findIndex((a) => a === `--${name}` || a === `-${name[0]}`);
  return i >= 0 ? ARGS[i + 1] : undefined;
};

const HELP = `lazypath ${VERSION} - one OpenAI endpoint for every LLM you can log into

  lazypath                start the gateway and open the dashboard
  lazypath --port <n>     listen on another port
  lazypath --host <addr>  bind elsewhere: the token store is then reachable without TLS
  lazypath --no-open      do not touch the browser
  lazypath --version      print the version
  lazypath help           this text

  data lives in ${DATA_DIR}`;

if (ARGS[0] === "help" || ARGS.includes("--help") || ARGS.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
if (ARGS.includes("--version") || ARGS.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}
const unknown = ARGS.find((a) => a.startsWith("-") && a !== "--no-open" && !["--port", "--host", "-p"].includes(a));
const command = ARGS[0]?.startsWith("-") ? undefined : ARGS[0];
if (unknown || command) {
  console.error(`lazypath: ${unknown ?? `unknown command "${command}"`}\n\n${HELP}`);
  process.exit(2);
}

/** `open` on a mac, xdg-open on linux, and on Windows the cmd start shim. */
function openBrowser(url: string) {
  const spec =
    process.platform === "win32"
      ? { cmd: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { cmd: "open", args: [url] }
        : { cmd: "xdg-open", args: [url] };
  spawn(spec.cmd, spec.args, { detached: true, stdio: "ignore" }).unref();
}

// --------------------------------------------------------------------------- http

const PORT = Number(argValue("port") ?? process.env.PORT ?? loadConfig().port);
// loopback by default: the token store is worth stealing and there is no TLS here
const HOST = argValue("host") ?? process.env.HOST ?? "127.0.0.1";
const OPEN = !ARGS.includes("--no-open") && process.env.LAZYPATH_NO_OPEN !== "1";


function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// localhost-only server with a bearer key: any page may call it, nothing is cookie-authed
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-expose-headers": "x-lazypath-provider, x-lazypath-model",
  "access-control-max-age": "600",
};

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const base = `http://${req.headers.host ?? `localhost:${PORT}`}`;
  for (const k in CORS) res.setHeader(k, CORS[k]);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(HTML);
    }
    if (url.pathname === "/api/summary") return json(res, 200, summary(base));

    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
      const provider = providerById(String(body.provider ?? ""));

      if (url.pathname === "/api/connect") {
        if (!provider) return json(res, 404, { error: { message: "unknown provider" } });
        if (tokenStore()[provider.id]) return json(res, 200, { alreadyConnected: true });
        try {
          const session = await startLogin(provider);
          if (session.kind === "device") {
            watchDeviceLogin(provider.id, session);
            return json(res, 200, { kind: "device", verifyUrl: session.verifyUrl, userCode: session.userCode });
          }
          pasteSessions.set(provider.id, session);
          return json(res, 200, { kind: "paste", url: session.url });
        } catch (e) {
          return json(res, 502, { error: { message: String(e) } });
        }
      }
      if (url.pathname === "/api/finish") {
        let session = provider && pasteSessions.get(provider.id);
        // Cookie logins have nothing to start: build the session on demand.
        if (!session && provider?.login === "cookie") {
          session = (await startLogin(provider)) as PasteSession;
          pasteSessions.set(provider.id, session);
        }
        if (!session) return json(res, 400, { error: { message: "start the login first" } });
        try {
          await session.finish(String(body.code ?? ""));
          pasteSessions.delete(provider!.id);
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, 502, { error: { message: String(e) } });
        }
      }
      if (url.pathname === "/api/disconnect") {
        const id = String(body.provider ?? "");
        clearToken(id);
        pasteSessions.delete(id);
        const login = activeLogins.get(id);
        if (login) {
          clearInterval(login.timer);
          activeLogins.delete(id);
        }
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/toggle") {
        const cfg = loadConfig();
        const id = String(body.provider ?? "");
        if (!providerById(id)) return json(res, 404, { error: { message: "unknown provider" } });
        cfg.disabled = cfg.disabled.includes(id) ? cfg.disabled.filter((x) => x !== id) : [...cfg.disabled, id];
        saveConfig(cfg);
        return json(res, 200, { disabled: cfg.disabled.includes(id) });
      }
      if (url.pathname === "/api/preset") {
        const cfg = loadConfig();
        const name = String(body.preset ?? "") as keyof Presets;
        if (!(name in cfg.presets)) return json(res, 400, { error: { message: "unknown preset" } });
        cfg.presets[name] = ((body.chain as string[]) ?? []).filter((id) => providerById(id));
        saveConfig(cfg);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/rotate") {
        const cfg = loadConfig();
        cfg.gatewayKey = `lp-${randomBytes(16).toString("hex")}`;
        saveConfig(cfg);
        return json(res, 200, { gatewayKey: cfg.gatewayKey });
      }
      if (url.pathname === "/api/usage/reset") {
        writeJson(USAGE_FILE, {});
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: { message: "not found" } });
    }

    if (url.pathname === "/v1/models") {
      return json(res, 200, { object: "list", data: listAllModels().map((m) => ({ id: m.id, object: "model", owned_by: m.owned_by })) });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if ((req.headers.authorization ?? "") !== `Bearer ${loadConfig().gatewayKey}`) {
        return json(res, 401, { error: { message: "bad lazypath key" } });
      }
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const model = String(body.model ?? "smart");

      if (body.stream) {
        const out = await routeChatStream(model, body);
        if (!out.response) {
          return json(res, 502, { error: { message: `lazypath: no provider could serve "${model}"`, attempts: out.errors } });
        }
        if (out.format === "kiro" || out.format === "kimiweb" || out.format === "dola") {
          // binary/buffered wires: decode the whole reply, then re-emit it as OpenAI chunks
          let done;
          try {
            const buffer = Buffer.from(await out.response.arrayBuffer());
            done =
              out.format === "kiro"
                ? fromKiro(buffer, out.modelUsed ?? model)
                : out.format === "kimiweb"
                  ? fromKimiWeb(buffer, out.modelUsed ?? model)
                  : fromDola(buffer.toString("utf8"), out.modelUsed ?? model);
          } catch (err) {
            return json(res, 502, { error: { message: `lazypath: ${out.providerUsed} failed`, detail: String(err) } });
          }
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-lazypath-provider": out.providerUsed ?? "" });
          res.write(chunk(out.modelUsed ?? model, { role: "assistant" }));
          res.write(chunk(out.modelUsed ?? model, { content: ((done.choices as { message: { content: string } }[])[0]?.message ?? {}).content ?? "" }));
          res.write(chunk(out.modelUsed ?? model, {}, "stop"));
          return res.end("data: [DONE]\n\n");
        }
        if (
          out.format === "anthropic" ||
          out.format === "responses" ||
          out.format === "huggingchat" ||
          out.format === "zaiweb" ||
          out.format === "innerai" ||
          out.format === "pplxweb" ||
          out.format === "claudeweb" ||
          out.format === "zenmux" ||
          out.format === "adapta" ||
          out.format === "hyperagent"
        ) {
          const responsesState: StreamState = { role: false, done: false, tracks: new Map(), emitted: 0 };
          const translate =
            out.format === "anthropic" || out.format === "claudeweb" || out.format === "zenmux"
              ? (raw: string, model: string) => anthropicSseToOpenai(raw, model)
              : out.format === "responses"
                ? (raw: string, model: string) => responsesSseToOpenai(raw, model, responsesState)
                : out.format === "innerai"
                  ? (raw: string, model: string) => innerAiSseToOpenai(raw, model, responsesState)
                  : out.format === "pplxweb"
                    ? (raw: string, model: string) => pplxSseToOpenai(raw, model, responsesState)
                    : out.format === "adapta"
                      ? (raw: string, model: string) => adaptaSseToOpenai(raw, model, responsesState)
                      : out.format === "hyperagent"
                        ? (raw: string, model: string) => hyperSseToOpenai(raw, model, responsesState)
                        : out.format === "zaiweb"
                          ? (raw: string, model: string) => zaiSseToOpenai(raw, model, responsesState)
                          : (raw: string, model: string) => huggingchatSseToOpenai(raw, model, responsesState);
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-lazypath-provider": out.providerUsed ?? "" });
          const decoder = new TextDecoder();
          let buf = "";
          const reader = out.response.body!.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const cut = buf.lastIndexOf("\n\n") + 2;
            const head = buf.slice(0, cut);
            buf = buf.slice(cut);
            if (head) res.write(translate(head, out.modelUsed ?? model));
          }
          if (buf.trim()) res.write(translate(buf, out.modelUsed ?? model));
          return res.end();
        }
        res.writeHead(200, {
          "content-type": out.response.headers.get("content-type") ?? "text/event-stream",
          "cache-control": "no-cache",
          "x-lazypath-provider": out.providerUsed ?? "",
        });
        Readable.fromWeb(out.response.body as import("node:stream/web").ReadableStream).pipe(res);
        return;
      }

      const r = await routeChat(model, body);
      res.writeHead(r.status, { "content-type": r.contentType, "x-lazypath-provider": r.providerUsed, "x-lazypath-model": r.modelUsed });
      return res.end(r.body);
    }

    json(res, 404, { error: { message: "not found" } });
  } catch (e) {
    json(res, 500, { error: { message: String(e) } });
  }
};

const server = createServer(handle);

/** a second `lazypath` on the same port should not die with a stack trace */
async function alreadyUp(): Promise<boolean> {
  const probeHost = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
  try {
    return (await fetch(`http://${probeHost}:${PORT}/api/summary`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

const dashboard = `http://localhost:${PORT}/`;
if (await alreadyUp()) {
  console.log(`\n  lazypath is already running: ${dashboard}\n`);
  if (OPEN) openBrowser(dashboard);
  process.exit(0);
}

// Chrome resolves `localhost` to ::1 first on Windows, so both loopbacks have to answer
if (HOST === "127.0.0.1") createServer(handle).on("error", () => {}).listen(PORT, "::1");
server.on("error", (e) => {
  console.error(`lazypath: cannot listen on ${HOST}:${PORT} - ${(e as Error).message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`\n  lazypath v${VERSION} up on http://${HOST}:${PORT}`);
  console.log(`  dashboard  ${dashboard}`);
  console.log(`  openai api http://localhost:${PORT}/v1   (model: smart | fast | cheap)`);
  console.log(`  key        ${loadConfig().gatewayKey}`);
  console.log(`  data       ${DATA_DIR}\n`);
  console.log(`  ctrl-c to stop\n`);
  if (OPEN) openBrowser(dashboard);
});
