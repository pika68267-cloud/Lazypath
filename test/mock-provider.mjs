import { createServer } from "node:http";

// Mock provider for lazypath e2e tests: OAuth endpoints + two inference wire formats.
//   /oauth/device/code + /oauth/device/token  -> RFC 8628 device flow
//   /oauth/approve                            -> simulates the user approving in a browser
//   /oauth/token                              -> authorization-code exchange (paste flow)
//   /fail/*  503      /ok/*  OpenAI JSON      /anth/*  Anthropic Messages JSON
//   /kiro/*  AWS vnd.amazon.eventstream binary frames
// Providers whose id ends in "mock" auto-approve; "devmock" waits for /oauth/approve.

const approved = new Set();

/** One AWS eventstream frame: only the header block matters, CRCs are ignored by the decoder. */
function eventFrame(type, payload) {
  const name = Buffer.from(":event-type");
  const value = Buffer.from(type);
  const json = Buffer.from(JSON.stringify(payload));
  const len = Buffer.alloc(2);
  len.writeUInt16BE(value.length);
  const headers = Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7]), len, value]);
  const head = Buffer.alloc(12);
  head.writeUInt32BE(16 + headers.length + json.length, 0);
  head.writeUInt32BE(headers.length, 4);
  return Buffer.concat([head, headers, json, Buffer.alloc(4)]);
}

async function read(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  req.rawBody = Buffer.from(raw, "utf8");
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw).entries());
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const body = await read(req);
  const send = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };

  if (url.pathname === "/oauth/device/code") {
    const clientId = String(body.client_id ?? "");
    return send(200, {
      device_code: clientId,
      user_code: "MOCK-9241",
      verification_uri: `http://127.0.0.1:8788/verify?client=${clientId}`,
      expires_in: 600,
      interval: 1,
    });
  }

  if (url.pathname === "/oauth/approve") {
    approved.add(String(body.device_code ?? ""));
    return send(200, { ok: true });
  }

  if (url.pathname === "/oauth/device/token") {
    const code = String(body.device_code ?? "");
    if (!code) return send(400, { error: "invalid_request" });
    if (code === "devmock" && !approved.has(code)) return send(400, { error: "authorization_pending" });
    return send(200, { access_token: `token-for-${code}`, refresh_token: `refresh-for-${code}`, expires_in: 3600 });
  }

  if (url.pathname === "/oauth/token") {
    if (body.code !== "good-code") return send(400, { error: "invalid_grant" });
    return send(200, { access_token: "pasted-access-token", refresh_token: "pasted-refresh", expires_in: 3600 });
  }

  if (url.pathname.startsWith("/cookie")) {
    // Cookie-login wire: session cookie in, HuggingChat-style SSE out.
    if (!(req.headers.cookie ?? "").includes("hf-chat=")) return send(401, { error: "no session cookie" });
    if (url.pathname === "/cookie/conversation") return send(200, { conversationId: "conv-1", messageId: "msg-0" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "stream", token: "hello from cookie mock" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "finalAnswer", text: "hello from cookie mock" })}\n\n`);
    return res.end();
  }

  if (url.pathname.startsWith("/kimiweb")) {
    // Kimi web wire: 5-byte Connect envelope in, same framing out.
    const raw = req.rawBody ?? Buffer.alloc(0);
    const framed = raw.length > 5 && raw.readUInt32BE(1) === raw.length - 5;
    if (!framed || !(req.headers.authorization ?? "").startsWith("Bearer mock-kimi-token")) return send(401, { error: "no token" });
    const frame = (obj) => {
      const payload = Buffer.from(JSON.stringify(obj));
      const head = Buffer.alloc(5);
      head.writeUInt32BE(payload.length, 1);
      return Buffer.concat([head, payload]);
    };
    res.writeHead(200, { "content-type": "application/connect+json" });
    res.write(frame({ op: "append", mask: "block.text.content", block: { text: { content: "hello from kimi web mock" } } }));
    res.write(Buffer.from([0x02, 0, 0, 0, 0]));
    return res.end();
  }

  if (url.pathname.startsWith("/dola")) {
    // Dola wire: folded prompt + fingerprint in, content-block SSE out.
    if (!(req.headers.cookie ?? "").includes("sessionid=")) return send(401, { error: "no session cookie" });
    if (!url.searchParams.get("fp")) return send(401, { error: "no fingerprint" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: message\ndata: ${JSON.stringify({ content: { content_block: [{ block_type: 10000, content: { text_block: { text: "hello from dola mock" } } }] } })}\n\n`);
    res.write("event: SSE_REPLY_END\ndata: {}\n\n");
    return res.end();
  }

  if (url.pathname.startsWith("/zai")) {
    // Z.ai wire: signed JWT bearer, new chat then streaming completions.
    if (!/^Bearer\s+[\w-]+\.[\w-]+\.[\w-]+$/.test(req.headers.authorization ?? "")) return send(401, { error: "no token" });
    if (url.pathname === "/zai/api/v1/chats/new") {
      return send(200, { payload: { chat: { id: "chat-1", history: { currentId: "msg-1", messages: { "msg-1": { id: "msg-1" } } } } } });
    }
    if (url.pathname === "/zai/api/v2/chat/completions") {
      if (!url.searchParams.get("signature_timestamp") || !req.headers["x-signature"]) return send(400, { error: "no signature" });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ data: { phase: "thinking", delta_content: "reasoning " } })}\n\n`);
      res.write(`data: ${JSON.stringify({ data: { phase: "answer", delta_content: "hello from z.ai mock" } })}\n\n`);
      res.write(`data: ${JSON.stringify({ data: { done: true } })}\n\n`);
      return res.end();
    }
    return send(404, { error: "unknown zai path" });
  }

  if (url.pathname.startsWith("/innerai")) {
    // Inner AI wire: cookie + USER-TOKEN + DEVICE-ID, SSE text/end_stream out.
    if (!/(?:^|;\s*)token=[\w-]+\.[\w-]+\.[\w-]+/.test(req.headers.cookie ?? "")) return send(401, { error: "no token" });
    if (!req.headers["user-token"]) return send(401, { error: "no user token" });
    if (!req.headers["device-id"]) return send(401, { error: "no device id" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "status", item: "searching" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "text", item: "hello from inner.ai mock" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "end_stream", item: "end" })}\n\n`);
    return res.end();
  }

  if (url.pathname.startsWith("/pplx")) {
    // Perplexity web wire: schematized ask, answer text spread over a materialized
    // workflow_block plus JSON-patch diffs, terminated by `event: end_of_stream`.
    if (!/__Secure-next-auth\.session-token=/.test(req.headers.cookie ?? "")) return send(401, { error: "no session" });
    if (body.params?.mode !== "copilot" || !body.params?.use_schematized_api) return send(400, { error: "bad ask params" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const answerItem = { type: "WORKFLOW_ITEM_TEXT", variant: "answer", payload: { text_payload: { text: "", chunks: ["hello from "], is_streaming: true } } };
    const frame = (status, blocks, final) => `event: message\ndata: ${JSON.stringify({ status, final: !!final, blocks })}\n\n`;
    res.write(frame("PENDING", [{ intended_usage: "workflow_root", workflow_block: { status: "WORKFLOW_IN_PROGRESS", steps: [{ items: [answerItem] }] } }]));
    res.write(
      frame("PENDING", [
        {
          intended_usage: "workflow_root",
          diff_block: {
            field: "workflow_block",
            patches: [{ op: "add", path: "/steps/0/items/0/payload/text_payload/chunks/1", value: "perplexity mock" }],
          },
        },
      ]),
    );
    res.write(
      frame("PENDING", [
        {
          intended_usage: "workflow_root",
          diff_block: {
            field: "workflow_block",
            patches: [
              { op: "replace", path: "/steps/0/items/0/payload/text_payload/text", value: "hello from perplexity mock" },
              { op: "replace", path: "/steps/0/items/0/payload/text_payload/is_streaming", value: false },
              { op: "replace", path: "/steps/0/status", value: "WORKFLOW_COMPLETED" },
            ],
          },
        },
      ]),
    );
    res.write(frame("COMPLETED", [], true));
    res.write("event: end_of_stream\ndata: {}\n\n");
    return res.end();
  }

  if (url.pathname.startsWith("/claude")) {
    // Claude web: org discovery then a completion stream in Anthropic event shape.
    if (!/sessionKey=/.test(req.headers.cookie ?? "")) return send(403, { type: "error", error: { type: "permission_error", message: "Invalid authorization" } });
    if (url.pathname === "/claude/api/organizations") return send(200, [{ uuid: "org-1" }]);
    if (!/^Bearer [\w.-]+$/.test(req.headers.authorization ?? "")) return send(403, { type: "error" });
    if (!/\/chat_conversations\/[\w-]+\/completion$/.test(url.pathname)) return send(404, { error: "unknown claude path" });
    if (!Array.isArray(body.personalized_styles) || !body.turn_message_uuids?.assistant_message_uuid) return send(400, { error: "bad completion payload" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "conversation_ready", status: "ok" })}\n\n`);
    // `completion` is a metadata event on this wire, not the answer carrier
    res.write(`data: ${JSON.stringify({ type: "completion", completion: "ignored metadata" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello from " } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "claude web mock" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    return res.end();
  }

  if (url.pathname.startsWith("/keyless")) {
    // Pollinations-style anonymous route: a placeholder bearer must never reach the wire.
    if (req.headers.authorization) return send(401, { error: "keyless call carried a bearer token" });
    return send(200, {
      id: "key1",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "hello from keyless mock" }, index: 0 }],
      usage: { prompt_tokens: 4, completion_tokens: 4 },
    });
  }

  if (url.pathname.startsWith("/zenmux")) {
    // ZenMux free tier: ctoken replayed as a query parameter, Anthropic SSE back.
    if (!/ctoken=[\w-]+/.test(req.headers.cookie ?? "")) return send(403, { error: { message: "access_denied" } });
    if (url.searchParams.get("ctoken") !== (/(?:^|;\s*)ctoken=([\w-]+)/.exec(req.headers.cookie ?? ""))?.[1]) {
      return send(401, { error: { message: "ctoken mismatch" } });
    }
    if (!body.stream || !Array.isArray(body.messages)) return send(400, { error: { message: "want an anthropic-shaped stream" } });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "message_start", message: { id: "z1" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thinking aloud" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello from zenmux mock" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    return res.end();
  }

  if (url.pathname.startsWith("/adaptak")) {
    // Clerk front end: the __client cookie only buys a client record, then a short-lived JWT.
    if (!/__client=eyJ[\w.-]+/.test(req.headers.cookie ?? "")) return send(403, { errors: [{ message: "Subdomain not allowed" }] });
    if (url.pathname === "/adaptak/v1/client") return send(200, { response: { sessions: [{ status: "revoked", id: "sess-old" }, { status: "active", id: "sess-1" }] } });
    if (/^\/adaptak\/v1\/client\/sessions\/sess-1\/tokens$/.test(url.pathname) && req.method === "POST") {
      return send(200, { jwt: "eyJhbGciOi.mock-session-token" });
    }
    return send(404, { error: "unknown clerk path" });
  }

  if (url.pathname.startsWith("/adapta")) {
    if (!/^Bearer eyJ[\w.-]+$/.test(req.headers.authorization ?? "")) return send(401, { success: false, details: { message: "Missing or invalid authorization header" } });
    if (!Array.isArray(body.messages) || !Array.isArray(body.messages[0]?.parts) || typeof body.aiModelId !== "number") {
      return send(400, { error: "want parts[] messages and an aiModelId" });
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "text-delta", id: "quick-response", delta: "IGNORED" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "text-delta", id: "t1", delta: "hello from " })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "text-delta", id: "t1", delta: "adapta mock" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "text-end", id: "t1" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    return res.end();
  }

  if (url.pathname.startsWith("/hyper")) {
    // Hyperagent: open a thread, latch the model on it, then chat inside it.
    if (!/__session=|session=/.test(req.headers.cookie ?? "")) return send(401, { error: "Not authenticated" });
    if (req.method === "POST" && url.pathname === "/hyper/api/threads") return send(201, { id: "cm9a8b7c6d5e4f3a2b1c0d9e" });
    const latched = /^\/hyper\/api\/threads\/([\w-]+)$/.exec(url.pathname);
    if (req.method === "PATCH" && latched) {
      if (!body.modelId || !["fable", "opus", "sonnet", "haiku"].includes(body.defaultSubagentModel)) return send(400, { error: "model_not_latched" });
      return send(200, { ok: true });
    }
    const chat = /^\/hyper\/api\/threads\/([\w-]+)\/chat$/.exec(url.pathname);
    if (req.method === "POST" && chat) {
      // the chat body must not name a model; the thread already latched one
      if (body.modelId || body.model) return send(400, { error: "model_unknown" });
      if (typeof body.content !== "string" || !body.content.trim()) return send(400, { error: "empty content" });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "session_start", sessionId: "s-1" })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "thinking", content: "planning" })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "text", content: "hello from hyperagent mock" })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    return send(404, { error: "unknown hyper path" });
  }

  if (url.pathname.startsWith("/resp")) {
    // Codex/Grok speak the Responses API and stream even when asked not to.
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "response.created" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello from responses mock" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 13, output_tokens: 6 } } })}\n\n`);
    return res.end();
  }

  if (url.pathname.startsWith("/kiro")) {
    res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
    res.write(eventFrame("assistantResponseEvent", { messageId: "m1", content: "hello from kiro mock" }));
    res.write(eventFrame("usageEvent", { usage: { inputTokens: 9, outputTokens: 4 } }));
    return res.end();
  }

  if (url.pathname.startsWith("/fail")) return send(503, { error: "mock overloaded" });

  if (url.pathname.startsWith("/anth")) {
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text: "hello from anthropic mock" } })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      return res.end();
    }
    return send(200, {
      id: "msg_mock",
      content: [{ type: "text", text: "hello from anthropic mock" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 7 },
    });
  }

  if (url.pathname === "/verify") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<html><body style="background:#111;color:#eee;font:15px system-ui;padding:40px">
      <h3>Mock provider login</h3><p>Code: <code>MOCK-9241</code></p>
      <p><a id="a" href="#" style="color:#5eead4">Approve device</a></p>
      <script>
        var client = new URLSearchParams(location.search).get("client");
        document.getElementById("a").onclick = function(){ fetch("/oauth/approve",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:"device_code="+client}); return false };
      </script></body></html>`);
  }

  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello from mock" } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  return send(200, {
    id: "mock1",
    object: "chat.completion",
    choices: [{ message: { role: "assistant", content: "hello from mock" }, index: 0 }],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  });
}).listen(8788, () => console.log("mock up on 8788"));
