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
  key        lp-...
```

`node lazypath.ts` works exactly the same if you would rather not install it. Flags:
`--port <n>`, `--host <addr>`, `--no-open`, `--version`, `help`. Running a second copy just
prints the dashboard of the one that is already up.

Single file, zero runtime dependencies, Node >= 24 (it runs the TypeScript directly).
Config, tokens and usage live in `~/.lazypath/` — delete that folder to reset.

## Use it

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer lp-yourkey" -H "content-type: application/json" \
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
22 providers ship in four flavours:

| how you link | providers |
| --- | --- |
| **device code** | Kimi, GitHub Copilot, Kiro (AWS), Tencent CodeBuddy, ChatGPT (Codex), Grok |
| **browser cookie** | Z.ai, Inner AI, Perplexity, Claude, Kimi web, Doubao, HuggingChat, ZenMux Free, Adapta, Hyperagent |
| **pasted key** | Qoder, GitLab, Anthropic, Qwen Cloud, MiniMax |
| **nothing** | Pollinations (anonymous models, always connected) |

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
  Google's free tier rides its own embedded client id and is being closed off.

## Wire formats

Clients speak OpenAI. Providers that speak something else get translated both ways, including
streaming: `anthropic` (Messages), `kiro` (AWS eventstream), `responses` (ChatGPT/Grok), plus the
bespoke shapes of HuggingChat, Kimi web, Doubao, Z.ai web, Inner AI, Perplexity web, Claude web,
ZenMux, Adapta (Clerk-minted session token) and Hyperagent (thread bootstrap).
Tool calls and multimodal content are not translated yet — text-only today.

## Tests

```
npm test          # 60 checks: every wire format, fallback, streaming, presets, usage, auth
npm run typecheck
```

`test/mock-provider.mjs` is a local stub; mock providers only load with `LAZYPATH_MOCKS=1`.

## Honest caveats

- **ToS**: consumer-account automation is generally restricted to first-party tools. The device
  flows are the providers' own public login flows, meant for their CLIs — use them on your own
  accounts, personally. Everything marked *ToS risk* in the dashboard rides a browser session.
- OAuth endpoints drift without notice; a provider can start rejecting non-official clients
  (Google already does with opaque 403s, Qwen with a WAF block page).
- Model lists are static per provider. Real discovery needs a connected account.
- Usage stats are best-effort: streaming responses count the request but not the tokens.
- Brand marks are the providers' own: simple-icons (CC0) where that set has them, otherwise the
  site's favicon/logo SVG recoloured for the black tile, or the PNG for Pollinations.
