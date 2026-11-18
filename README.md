## CREDIT:IMPORTANT
  this is a standoff for fun prototype of [OMNIROUTE](https://github.com/cheaper-inference/OmniRoute/). I am not the author of the real project. All belongs to this great author [Diego Rodrigues de Sa e Souza](https://github.com/diegosouzapw) and the Teams behind it


# lazypath

One OpenAI-compatible endpoint in front of every LLM. **Log in with an account where the
provider actually supports it, paste one key where it doesn't** — and easy-mode model names
fail over automatically. OmniRoute's idea, minus the ceremony.

```
npm link            # once, puts the `lazypath` command on your PATH
lazypath            # starts the gateway and opens the dashboard
```

```
  lazypath v0.1.0 up on http://127.0.0.1:8787
  dashboard  http://localhost:8787/
  openai api http://localhost:8787/v1   (model: smart | fast | cheap)
  login      admin / 3f9c2ab1...
```

`node lazypath.ts` works exactly the same if you would rather not install it. Flags:
`--port <n>`, `--host <addr>`, `--no-open`, `--version`, `help`, and `export` (prints the token
store as JSON — see [Deploy to Vercel](#deploy-to-vercel)). Running a second copy just prints
the dashboard of the one that is already up.

Single file, zero runtime dependencies, Node >= 24 (it runs the TypeScript directly).
Config, tokens and usage live in `~/.lazypath/` — delete that folder to reset. With a Cloudflare
D1 database configured, the tokens live there instead, so resetting means clearing the `store`
table.

The dashboard is open on loopback because nothing else can reach it. Bind anywhere else
(`--host 0.0.0.0`, or a Vercel deployment) and `/` becomes a **home page** with **Sign in** and
**Sign up** buttons. Sign-up creates the gateway's *single owner account* and then closes for
good — the first person to claim it owns it, and everyone after that sees "Already claimed".
Signing in sets an `HttpOnly` session cookie the dashboard then rides; the cookie holds a
signature, not the password.

Where the account and the connections live depends on the deployment:

- **Local (loopback):** sign-up writes the username and password you chose into
  `~/.lazypath/config.json`, replacing the generated ones. No database needed.
- **Cloudflare D1:** set the three `CLOUDFLARE_*` variables and both the account **and** every
  linked provider live in a D1 database, so they survive serverless cold starts and a local
  device-code login becomes usable by the deployment. The password is stored as a salted scrypt
  hash, never in plaintext, and is never served back by the API. See
  [Accounts and tokens in the cloud](#accounts-and-tokens-in-the-cloud).
- **Env-managed:** set `LAZYPATH_PASSWORD` and sign-up is disabled — the credentials are whatever
  the environment says, which is the simplest path for a personal deployment.

The API takes the same credentials two ways: `Authorization: Bearer <password>` — so an OpenAI
SDK works with `apiKey` set to the password — or `Authorization: Basic base64(user:password)`,
which is what `curl -u user:password` sends.

## Use it

The dashboard's left rail has three modes, and the one you left it on comes back after a reload:

- **Connect** — the provider grid, usage bars, presets and password rotation.
- **Chat** — a ChatGPT-shaped conversation over your own providers: pick a preset or any
  `provider/model`, attach images, watch the answer stream, stop it mid-reply, switch models
  between turns. The transcript lives in that browser tab's `localStorage`, never on disk.
- **API** — the base URL, your password as the key (masked until you reveal it) and snippets for
  curl, the OpenAI SDK and plain `fetch`, with a **Test connection** button.

Attachments only reach providers whose wire can carry them — an OpenAI `image_url` part, an
Anthropic `source` block, or a Responses `input_image`. A text-only web login is skipped when your
message has an image, and the picker marks which connected providers take images at all, so a
preset never quietly drops your picture and hands you an answer about nothing.

From any other app it is one endpoint and one credential:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer yourpassword" -H "content-type: application/json" \
  -d '{"model":"smart","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

Model names you can pass:

| model | meaning |
| --- | --- |
| `smart` / `fast` / `cheap` | easy-mode presets — walks your connected providers until one answers |
| `kimi/kimi-for-coding` | explicit provider + model |
| `deepseek-chat` | bare id, routed to any connected provider that serves it |

429 / 401 / 402 / 5xx and network errors fall through to the next provider in the preset.
The response carries `x-lazypath-provider` and `x-lazypath-model` so you can see who answered.

## Login: what actually works

This is the part worth knowing before you trust any gateway (including OmniRoute) on this claim.
Provider definitions come from each service's own CLI source or its web app, not guesses.
34 providers ship in five flavours:

| how you link | providers |
| --- | --- |
| **device code** | Kimi, GitHub Copilot, Kiro (AWS), Tencent CodeBuddy, ChatGPT (Codex), Grok |
| **browser cookie** | Z.ai, Inner AI, Perplexity, Claude, Kimi web, Doubao, HuggingChat, ZenMux Free, Adapta, Hyperagent |
| **pasted key** | Qoder, GitLab, Anthropic, Qwen Cloud, MiniMax |
| **platform key** | OpenRouter, Groq, Cerebras, Mistral, Google AI Studio, SambaNova, NVIDIA NIM, DeepInfra, ModelScope, Novita, Together AI, DeepSeek |
| **nothing** | Pollinations (anonymous models, always connected) |

The platform-key group is the one purchase most of these free tiers anyway: OpenRouter's
`:free` ids, Groq, Cerebras, SambaNova, NVIDIA NIM, ModelScope and Google AI Studio all give
you a key without a card. Every one of them speaks the OpenAI wire, so they need no
translation — paste the key and the gateway checks it against that provider's `/models`
before storing it, which turns a bad paste into an error now instead of a silent fallback on
your first chat.

Click **Connect** and the dashboard does the right one of those: a code to approve, a page to
sign in on plus a paste box, or nothing at all. Device logins refresh themselves, serialised so
two in-flight requests cannot race a single-use refresh token.

Providers that only have a browser session do not publish an OAuth client for anyone else, so
those logins are marked **ToS risk** in the dashboard — the cookie is your web session and the
service restricts it to first-party clients. Cookie values are pasted into the dashboard on
localhost, never into a chat, and the gateway binds to loopback by default because it holds
those tokens with no TLS.

Three things that used to work and no longer do:

- **Qwen**: `qwen-code`'s device login is dead upstream. `POST /api/v1/oauth2/device/code` still
  answers, but the poll endpoint `/api/v1/oauth2/token` returns the Aliyun WAF block page (405)
  for every non-browser client, and qwen-code 0.26 itself marks qwen-oauth *discontinued*.
  So lazypath links Qwen through Qwen Cloud's OpenAI-compatible endpoint with a pasted key.
- **MiniMax**: the community user-code flow is gone — `api.minimax.io/oauth/code` and
  `/api/oauth/device_authorization` now 404, though `/oauth/token` still answers. The browser
  product is not a fallback either: `agent.minimax.io` is an *agent*, where
  `/matrix/api/v1/chat/send_msg` only starts a run whose events come back over a separate
  transport, so there is no completion to translate. lazypath links MiniMax with a platform key
  against the Anthropic-compatible endpoint, checked against `/v1/models` when you paste it.
- **OpenAI / Google** consumer logins stay out: ChatGPT-account tokens are Codex-CLI-only and
  Google's free tier rides its own embedded client id and is being closed off. Google ships
  here as **AI Studio with a platform key** instead, which is a supported first-party path.

Three candidates were probed and left out rather than shipped on a guess: Fireworks and
SiliconFlow publish their model ids only inside a JavaScript app, so there was no honest list
to embed, and `models.github.ai/inference` answers `200 OK` to every path — a catch-all, not an
OpenAI route.

## Wire formats

Clients speak OpenAI. Providers that speak something else get translated both ways, including
streaming: `anthropic` (Messages), `kiro` (AWS eventstream), `responses` (ChatGPT/Grok), plus the
bespoke shapes of HuggingChat, Kimi web, Doubao, Z.ai web, Inner AI, Perplexity web, Claude web,
ZenMux, Adapta (Clerk-minted session token) and Hyperagent (thread bootstrap).
Tool calls are not translated yet. Images are: `image_url` parts pass through to OpenAI-wire
providers and are converted into Anthropic `source` blocks or Responses `input_image` items. A
provider that ignores `stream:true` and answers with a plain JSON object gets re-emitted as an SSE
stream, so a streaming client never has to parse a bare body.

## Deploy to Vercel

The same single file runs as a serverless function. `api/index.ts` re-exports its request
handler and `vercel.json` routes every path to it, so the dashboard, the API and the OpenAI
endpoint all live at your deployment URL.

Vercel compiles each `api/` file on its own, never bundles, and only compiles TypeScript that
lives *inside* `api/` — so the entry cannot import `../lazypath.ts` and expect it to load. The
`vercel-build` script (`build-vercel.mjs`) uses Node's own `stripTypeScriptTypes` to emit
`lazypath.js` next to the source, and the entry imports that. No bundler, no runtime dependency,
still one source file. Vercel picks the script up by itself.

1. Push this repo to GitHub.
2. In Vercel, **Add New > Project** and import it. Framework preset **Other**, no output
   directory. `engines.node` is `>=24`, which overrides the version dropdown and maps to
   Vercel's newest LTS — anything from 24.x up runs the gateway unchanged.
3. Set the environment variables below, then deploy.

| variable | what it is |
| --- | --- |
| `LAZYPATH_USER` | the sign-in username for env-managed mode. Defaults to `admin`. Ignored when D1 accounts are on. |
| `LAZYPATH_PASSWORD` | the sign-in password and bearer token for env-managed mode. Set it **or** set the `CLOUDFLARE_*` variables below — with neither, a public deployment has no way to sign in and the sign-in page says so. |
| `LAZYPATH_TOKENS` | the token store as JSON. Without D1 this **is** the store — get it from `lazypath export` on your machine. With D1 it only seeds the database the first time it runs. |
| `LAZYPATH_CONFIG` | optional: presets and the disabled list as JSON, same shape as `~/.lazypath/config.json`. |
| `CLOUDFLARE_ACCOUNT_ID` | enables D1 (the account **and** the token store): your Cloudflare account id. |
| `CLOUDFLARE_D1_DATABASE_ID` | the D1 database that holds the owner account and every connected provider (`CLOUDFLARE_DATABASE_ID` also works). |
| `CLOUDFLARE_API_TOKEN` | a Cloudflare API token with D1 write access to that database. |

Pick a password you would be happy to see in an `Authorization` header, because that is where
it ends up: `Bearer <password>` for OpenAI SDKs, or `curl -u "$LAZYPATH_USER:$LAZYPATH_PASSWORD"`.

### Accounts and tokens in the cloud

Serverless has no durable disk, so an account created on one cold start would vanish on the next —
and so would every provider you linked. Cloudflare D1 fixes both: the owner account and the token
store live in one database the function reaches over Cloudflare's REST API (plain `fetch`, still
zero dependencies). To turn it on:

1. In the Cloudflare dashboard, **Workers & Pages > D1** and create a database (the free tier is
   plenty — it holds two small tables).
2. Create an API token with **Account > D1 > Edit** permission.
3. Set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID` and `CLOUDFLARE_API_TOKEN` in Vercel
   and redeploy. For local runs, put the same three `KEY=value` lines in a `.cloudflare.env`
   file inside the gateway home (`~/.lazypath`, or `LAZYPATH_HOME` when set); real environment
   variables always win over the file.

**The account.** The gateway creates the `accounts` table itself on first use. Open `/signup`,
choose a username and password, and that single account is claimed atomically — a concurrent
second sign-up loses the race and gets "Already claimed". The password is stored as a salted
**scrypt** hash; the API never returns it, and the dashboard shows "the password you chose at
sign-up" instead of a value to copy. Sign-in checks the password against the hash, and the same
password works as the bearer token. Because the hash is in D1, every cold start verifies the same
account and the same session cookies. Rotating the password from the dashboard is refused in this
mode — it was chosen at sign-up; to change it, update the row in D1.

**The token store.** A second table, `store`, keeps one JSON row per connected provider
(`token:kimi`, `token:copilot`, …) plus a `meta:tokens` marker, and every API or chat request
refreshes its view of it before anything reads a token. So:

- a link completed on the deployed dashboard is written to D1 and simply survives the next cold
  start — no export, no env var to paste;
- a **device-code** login done in the local gateway, where a poller can stay alive, shows up on
  the deployment as soon as it next reads the database. That is the whole reason for the table:
  Copilot, Kimi, Kiro, Codex, Grok, Tencent and the two PKCE paste flows are refused on
  serverless, so you link them once locally and both ends share the result;
- disconnecting deletes the row, and the first hydration marked the database as in charge, so
  `LAZYPATH_TOKENS` cannot resurrect a provider you just unlinked. Until that marker exists,
  whatever this machine already has — the file, or the env seed — is copied in once.

**Reads degrade, writes do not.** If Cloudflare is briefly unreachable, a request still answers
from this instance's own copy instead of failing, and the database is retried at most every 15
seconds (the dashboard polls every 3). A login that cannot be *saved* is reported as an error
rather than silently dropped.

**The tradeoff.** Those rows are your provider access and refresh tokens, now stored at a third
party and read with a Cloudflare API token that grants write access to the whole database. Keep
that token out of the repo, and if putting your tokens in Cloudflare is not acceptable to you,
deploy without the `CLOUDFLARE_*` variables and carry connections in `LAZYPATH_TOKENS` instead.

If a public deployment has neither D1 nor `LAZYPATH_PASSWORD`, sign-up shows a "needs a database"
notice rather than a form, because there is nowhere durable to put the account.

```bash
curl https://your-app.vercel.app/v1/chat/completions \
  -u "admin:yourpassword" -H "content-type: application/json" \
  -d '{"model":"smart","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

Open `https://your-app.vercel.app/` and you get the home page; **Sign up** claims the owner
account (with D1) or **Sign in** takes the env credentials. Signing in sets an `HttpOnly` session
cookie, so the dashboard works normally afterwards. The forms POST — the password never appears
in a URL, a request log or your history.

**What serverless changes.** There is no durable disk and no process that stays alive between
requests, so:

- With D1 configured, connections made on the deployed dashboard are written to the database and
  survive. Without it they last only until the next cold start — put them in `LAZYPATH_TOKENS` to
  keep them. Usage bars reset either way; they are not in the database.
- Device-code logins (Kimi, Copilot, Kiro, Codex, Grok, Tencent) and the two PKCE paste flows
  (GitLab, Anthropic) are still **refused on the deployment** — they need a poller or a verifier
  that outlives one request, which no amount of storage gives you. Link them in the local gateway
  and, with D1, the deployment reads the same row:

  ```
  lazypath            # connect the providers in the local dashboard (same CLOUDFLARE_* values)
  ```

  Without D1, carry them over by hand instead:

  ```
  lazypath export     # prints the token store JSON — paste it into LAZYPATH_TOKENS
  ```

  `export` prints live credentials. Treat its output like a password.
- Platform keys and browser cookies paste fine on the deployed dashboard either way.
- Rotating the password from the dashboard is refused. In env-managed mode, change
  `LAZYPATH_PASSWORD` and redeploy; every existing session cookie stops working, because the
  password signs them. In D1 mode the password was chosen at sign-up and lives hashed in the
  database — update the row there to change it.
- `vercel.json` sets `maxDuration: 60` so a streamed answer is not cut off. Raise it if your
  plan allows and your generations run longer.

## Tests

```
npm test          # 195 checks: every wire format, fallback, streaming, presets, usage, auth,
                  # serverless mode, D1 accounts and D1 tokens, then the artifact Vercel runs
npm run typecheck
```

`test/mock-provider.mjs` is a local stub; mock providers only load with `LAZYPATH_MOCKS=1`.
`test/e2e.mjs` drives a real gateway on a port; `test/serverless.mjs` imports the handler with
`VERCEL=1` and drives it with mock req/res, because in that mode there is no port to bind.
`test/accounts.mjs` stands up a mock Cloudflare D1 REST endpoint and proves the one-owner claim,
scrypt-hashed storage, stateless sessions across a cold instance, the token table (env seed,
a login saved from the deployed dashboard, a disconnect that sticks, a cold instance that reads
the row straight out of D1, and a local gateway that finds the database only through
`.cloudflare.env`), the local no-database fallback, and graceful 502s when the database
is unreachable.
`test/vercel-build.mjs` runs the build and drives `api/index.ts` → `lazypath.js`, so a `.ts`
specifier or a config that throws at import time cannot reach the platform unnoticed.

## Honest caveats

- **ToS**: consumer-account automation is generally restricted to first-party tools. The device
  flows are the providers' own public login flows, meant for their CLIs — use them on your own
  accounts, personally. Everything marked *ToS risk* in the dashboard rides a browser session.
- OAuth endpoints drift without notice; a provider can start rejecting non-official clients
  (Google already does with opaque 403s, Qwen with a WAF block page).
- Model lists are static per provider. Real discovery needs a connected account. The
  platform-key ids were read from each provider's public catalog or its own docs, and every
  chat route was probed live before shipping — but a provider can rename a model tomorrow.
- Usage stats are best-effort: streaming responses count the request but not the tokens.
- Brand marks are the providers' own: simple-icons (CC0) and `@lobehub/icons-static-svg` where
  those sets have them, otherwise the site's favicon/logo SVG recoloured for the black tile, or
  the PNG for Pollinations. No provider falls back to a letter placeholder.
