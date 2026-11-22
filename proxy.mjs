#!/usr/bin/env node
// Composio -> OpenRouter bridge, OpenAI-compatible, WITH tool-calling.
// Opencode -> this proxy -> Composio session execute(OPENROUTER_CREATE_CHAT_COMPLETION) -> OpenRouter
//
// Instant does not surface native tool_calls, so tools are emulated:
// tool schemas are injected into the system prompt and the model is asked to emit
// a JSON tool-call object, which the proxy converts back to OpenAI `tool_calls`.
//
// Zero dependencies. Requires Node 18+.  Run: node proxy.mjs
// Auth: Authorization: Bearer <composio_api_key>  (or x-api-key)
//
// Env:
//   PORT              default 8787
//   COMPOSIO_API_KEY  optional; if set, any/absent Bearer uses this key
//   PROXY_USER_ID     default "opencode-proxy"
//   TOOL_MODE         "emulate" (default) | "off"
//   SHOW_REASONING    "0" to disable reasoning_content streaming

import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const COMPOSIO_BASE = "https://backend.composio.dev/api/v3.1";
const DEFAULT_API_KEY = process.env.COMPOSIO_API_KEY || "";
const PROXY_USER_ID = process.env.PROXY_USER_ID || "opencode-proxy";
const SHOW_REASONING = process.env.SHOW_REASONING !== "0";
const TOOL_MODE = (process.env.TOOL_MODE || "emulate").toLowerCase();
// Composio managed (Instant) OpenRouter caps output at 1024 tokens; anything
// larger is rejected, so we clamp client requests before forwarding.
const MAX_OUTPUT_TOKENS = Math.max(1, Number(process.env.MAX_OUTPUT_TOKENS || 1024));
const TOOL_SLUG = "OPENROUTER_CREATE_CHAT_COMPLETION";

const MODELS = [
  "anthropic/claude-opus-5.5",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-haiku-5.5",
  "anthropic/claude-fable-5.1",
  "anthropic/claude-fable-5",
  "openai/gpt-6.1-sol",
  "openai/gpt-6.1-terra",
  "openai/gpt-6-astra",
  "openai/gpt-6-sol",
  "openai/gpt-6-luna",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.5",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
  "openai/gpt-5.2",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.1",
  "openai/gpt-5",
  "openai/gpt-5-mini",
  "openai/gpt-5-nano",
  "openai/gpt-4.1",
  "openai/gpt-4.1-mini",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "google/gemini-4-argon",
  "google/gemini-3.8-flash",
  "google/gemini-3.7-flash",
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash",
  "google/gemini-3.1-pro-preview",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "x-ai/grok-4.7",
  "x-ai/grok-4.6",
  "x-ai/grok-4.5",
  "x-ai/grok-4.3",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v3.2",
  "deepseek/deepseek-r1-0528",
  "meta-llama/llama-4-maverick",
  "meta-llama/llama-3.3-70b-instruct",
  "meta-llama/llama-3.1-8b-instruct",
  "qwen/qwen3.8-max-0902",
  "qwen/qwen3.7-max",
  "qwen/qwen3.6-plus",
  "qwen/qwen3.6-flash",
  "qwen/qwen3-coder",
  "moonshotai/kimi-k3.1-pro",
  "moonshotai/kimi-k3",
  "moonshotai/kimi-k2.7-code",
  "moonshotai/kimi-k2.6",
  "z-ai/glm-5.3",
  "z-ai/glm-5.3-flash",
  "z-ai/glm-5.2",
  "z-ai/glm-5.1",
  "z-ai/glm-5",
  "z-ai/glm-4.6",
  "minimax/minimax-m3.1-flash",
  "minimax/minimax-m3",
  "mistralai/mistral-large-4-0",
  "mistralai/mistral-medium-3-5",
  "mistralai/codestral-2508",
  "mistralai/devstral-2512",
  "cohere/command-a-plus",
  "cohere/command-a",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "amazon/nova-pro-v1",
  "amazon/nova-2-lite-v1",
  "openai/gpt-oss-120b",
  "microsoft/phi-4",
];

// ---------------------------------------------------------------------------
const sessions = new Map();
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

class UpstreamError extends Error {
  constructor(status, message, slug) {
    super(message);
    this.status = status;
    this.slug = slug;
  }
}
class BadRequest extends Error {}

async function composio(path, { method = "GET", apiKey, body } = {}) {
  const res = await fetch(`${COMPOSIO_BASE}${path}`, {
    method,
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, json };
}

async function createSession(apiKey) {
  const { status, ok, json } = await composio("/tool_router/session", {
    method: "POST",
    apiKey,
    body: {
      user_id: PROXY_USER_ID,
      toolkits: { enable: ["openrouter"] },
      instant: { return_instant_charge: true },
    },
  });
  if (!ok || !json.session_id) {
    throw new UpstreamError(
      status,
      json?.error?.message || "Failed to create Composio session",
      json?.error?.slug,
    );
  }
  sessions.set(apiKey, { sessionId: json.session_id, createdAt: Date.now() });
  log(`session created: ${json.session_id}`);
  return json.session_id;
}

async function getSession(apiKey, forceNew = false) {
  if (!forceNew) {
    const c = sessions.get(apiKey);
    if (c) return c.sessionId;
  }
  return createSession(apiKey);
}

async function executeCompletion(apiKey, args) {
  let sessionId = await getSession(apiKey);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { status, ok, json } = await composio(
      `/tool_router/session/${sessionId}/execute`,
      { method: "POST", apiKey, body: { tool_slug: TOOL_SLUG, arguments: args } },
    );

    const noConn =
      json?.error?.code === 4302 ||
      json?.error?.slug === "ToolRouterV2_NoActiveConnection";
    if (noConn && attempt === 0) {
      log(`session ${sessionId} invalid, recreating...`);
      sessions.delete(apiKey);
      sessionId = await getSession(apiKey, true);
      continue;
    }

    if (!ok || json?.result_type !== "completed" || !json?.data) {
      const msg =
        (typeof json?.error === "string" ? json.error : json?.error?.message) ||
        json?.data?.message ||
        "Composio execution failed";
      throw new UpstreamError(status >= 400 ? status : 502, msg, json?.error?.slug);
    }
    return json;
  }
  throw new UpstreamError(502, "Composio execution failed after retry");
}

// ---------------------------------------------------------------------------
// Tool calling (emulated on Instant)
// ---------------------------------------------------------------------------
function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") {
        if (p) parts.push(p);
        continue;
      }
      if (typeof p?.text === "string" && p.text) {
        parts.push(p.text);
        continue;
      }
      if (p?.type === "image_url" || p?.type === "image" || p?.type === "input_image") {
        parts.push("[image omitted: vision is not supported by this provider]");
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

function toolProtocol(tools) {
  const defs = tools
    .map((t) => {
      const fn = t.function || t;
      const schema = fn.parameters || fn.input_schema || { type: "object", properties: {} };
      return `- ${fn.name}: ${fn.description || "(no description)"}\n  parameters: ${JSON.stringify(schema)}`;
    })
    .join("\n");

  return [
    "You can call the following tools when needed:",
    defs,
    "",
    "TOOL CALL PROTOCOL (strict):",
    "- If you need to call one or more tools, reply with ONLY a single JSON object, no prose, no markdown fences:",
    '  {"tool_calls":[{"name":"<tool_name>","arguments":{ ... }}]}',
    "- You may include multiple entries in the tool_calls array.",
    "- If no tool is needed, reply normally in plain text (do NOT output JSON).",
    "- Never invent tool names; use only those listed above.",
  ].join("\n");
}

function buildEmulatedMessages(body) {
  const tools = body.tools || [];
  const sysParts = [toolProtocol(tools)];
  const out = [];

  for (const m of body.messages || []) {
    const role = m.role;
    if (role === "system" || role === "developer") {
      const t = textOf(m.content);
      if (t) sysParts.push(t);
      continue;
    }
    if (role === "user") {
      out.push({ role: "user", content: textOf(m.content) || "(empty)" });
      continue;
    }
    if (role === "assistant") {
      let text = textOf(m.content);
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const calls = m.tool_calls
          .map((tc) => {
            const name = tc.function?.name || tc.name || "?";
            const args = tc.function?.arguments ?? tc.arguments ?? "{}";
            return `[tool_call ${tc.id || ""} => ${name}(${typeof args === "string" ? args : JSON.stringify(args)})]`;
          })
          .join("\n");
        text = (text ? text + "\n" : "") + calls;
      }
      out.push({ role: "assistant", content: text || "(no content)" });
      continue;
    }
    if (role === "tool") {
      const name = m.name ? ` ${m.name}` : "";
      out.push({
        role: "user",
        content: `[tool_result${name} (${m.tool_call_id || ""})]: ${textOf(m.content) || "(empty)"}`,
      });
      continue;
    }
    // unknown role -> user
    out.push({ role: "user", content: textOf(m.content) || "(empty)" });
  }

  return [{ role: "system", content: sysParts.join("\n\n") }, ...out];
}

function stripProviderPrefix(model) {
  return model.startsWith("openrouter/") ? model.slice("openrouter/".length) : model;
}

function toComposioArgs(body, { emulateTools = false } = {}) {
  const model = stripProviderPrefix(String(body.model || ""));
  if (!model) throw new BadRequest("Missing 'model'");

  const messages = emulateTools ? buildEmulatedMessages(body) : body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BadRequest("Missing 'messages'");
  }
  if (!emulateTools) {
    for (const m of messages) {
      if (m && typeof m === "object" && Array.isArray(m.content)) {
        m.content = textOf(m.content);
      }
    }
  }

  const args = { model, messages };
  const passthrough = [
    "temperature",
    "top_p",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "logit_bias",
    "n",
    "user",
    "reasoning_effort",
  ];
  for (const k of passthrough) {
    if (body[k] !== undefined && body[k] !== null) args[k] = body[k];
  }

  // Clamp output tokens (managed Instant hard-caps at 1024).
  let mt = body.max_tokens ?? body.max_completion_tokens;
  if (mt !== undefined && mt !== null) {
    mt = Number(mt);
    if (Number.isFinite(mt) && mt >= 1) args.max_tokens = Math.min(mt, MAX_OUTPUT_TOKENS);
  }

  // When emulating, add a small stop hint so models don't ramble after JSON.
  if (emulateTools && !args.stop) args.stop = ["\n\nObservation:", "\nObservation:"];
  return args;
}

function parseEmulatedToolCalls(content) {
  if (!content) return null;
  let t = String(content).trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };

  let obj = tryParse(t);
  if (obj === undefined) {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end > start) obj = tryParse(t.slice(start, end + 1));
  }
  if (!obj || typeof obj !== "object") return null;

  let calls =
    obj.tool_calls ||
    obj.toolCalls ||
    obj.calls ||
    (obj.function ? [{ name: obj.function.name, arguments: obj.function.arguments }] : null) ||
    (obj.name ? [{ name: obj.name, arguments: obj.arguments ?? obj.input }] : null);

  if (!Array.isArray(calls) || calls.length === 0) return null;

  const normalized = calls
    .map((c) => {
      const name = c.name || c.function?.name || c.tool;
      let args = c.arguments ?? c.function?.arguments ?? c.input ?? c.parameters ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = { _raw: args };
        }
      }
      return name ? { name, arguments: args ?? {} } : null;
    })
    .filter(Boolean);

  return normalized.length ? normalized : null;
}

const randId = () =>
  "call_" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------
function extractMessage(data) {
  const choice = (data?.choices || [])[0] || {};
  const msg = choice.message || {};
  return {
    content: msg.content ?? "",
    reasoning: msg.reasoning ?? msg.reasoning_content ?? null,
    finishReason: choice.finish_reason ?? "stop",
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : null,
  };
}

function chunkText(text, size = 18) {
  if (!text) return [];
  const out = [];
  const words = text.split(/(\s+)/);
  let buf = "";
  for (const w of words) {
    buf += w;
    if (buf.length >= size) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}
function sendError(res, status, message, { type = "api_error", code = null } = {}) {
  sendJson(res, status, { error: { message, type, param: null, code } });
}

function mapUpstreamError(err) {
  const msg = String(err.message || "upstream error");
  if (err.status === 402 || /balance/i.test(msg))
    return { status: 402, message: `Composio wallet/billing: ${msg}`, type: "insufficient_quota" };
  if (err.status === 401)
    return { status: 401, message: `Invalid Composio API key: ${msg}`, type: "invalid_request_error" };
  if (err.status === 403)
    return { status: 403, message: `Forbidden: ${msg}`, type: "invalid_request_error" };
  if (err.status === 4302 || err.slug === "ToolRouterV2_NoActiveConnection")
    return {
      status: 502,
      message:
        "No Instant connection for openrouter. Enable Instant Toolkits in the Composio project and check billing.",
      type: "api_error",
    };
  if (/support only|not support|unsupported|is not available|not available on the instant/i.test(msg))
    return { status: 400, message: msg, type: "invalid_request_error" };
  if (err.status === 400) return { status: 400, message: msg, type: "invalid_request_error" };
  return { status: 502, message: msg, type: "api_error" };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 20 * 1024 * 1024) throw new BadRequest("Request body too large");
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequest("Invalid JSON body");
  }
}

function authKey(req) {
  const auth = req.headers["authorization"] || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const header = (req.headers["x-api-key"] || "").toString().trim();
  const key = bearer || header || DEFAULT_API_KEY;
  if (!key) throw Object.assign(new Error("Missing API key"), { status: 401 });
  if (!key.startsWith("ak_"))
    throw Object.assign(new Error("API key must look like ak_... (Composio key)"), { status: 401 });
  return key;
}

// ---------------------------------------------------------------------------
// SSE streaming (text + tool_calls)
// ---------------------------------------------------------------------------
async function streamCompletion(res, result, requestedModel, includeUsage, emulated) {
  const data = result.data;
  const model = data.model || requestedModel;
  const id = data.id || `chatcmpl-${Date.now()}`;
  const created = data.created || Math.floor(Date.now() / 1000);
  const msg = extractMessage(data);

  let content = msg.content;
  let toolCalls = msg.toolCalls;
  let finishReason = msg.finishReason;

  if (emulated && TOOL_MODE === "emulate") {
    const parsed = parseEmulatedToolCalls(content);
    if (parsed) {
      toolCalls = parsed.map((c) => ({
        id: randId(),
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      }));
      content = "";
      finishReason = "tool_calls";
    }
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const emit = (delta, finish = null) =>
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  emit({ role: "assistant", content: "" });

  if (SHOW_REASONING && msg.reasoning) {
    for (const p of chunkText(msg.reasoning, 24)) {
      emit({ reasoning_content: p });
      await delay(2);
    }
  }

  if (content) {
    for (const p of chunkText(content, 18)) {
      emit({ content: p });
      await delay(8);
    }
  }

  if (toolCalls && toolCalls.length) {
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      emit({
        tool_calls: [
          {
            index: i,
            id: tc.id || randId(),
            type: "function",
            function: { name: tc.function.name, arguments: "" },
          },
        ],
      });
      emit({ tool_calls: [{ index: i, function: { arguments: tc.function.arguments || "{}" } }] });
    }
  }

  emit({}, finishReason || "stop");

  if (includeUsage) {
    const u = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: {
          prompt_tokens: u.prompt_tokens,
          completion_tokens: u.completion_tokens,
          total_tokens: u.total_tokens,
        },
      })}\n\n`,
    );
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

function toOpenAIResponse(data, model, emulated) {
  const msg = extractMessage(data);
  let content = msg.content;
  let toolCalls = msg.toolCalls;
  let finishReason = msg.finishReason;

  if (emulated && TOOL_MODE === "emulate") {
    const parsed = parseEmulatedToolCalls(content);
    if (parsed) {
      toolCalls = parsed.map((c) => ({
        id: randId(),
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      }));
      content = "";
      finishReason = "tool_calls";
    }
  }

  const message = { role: "assistant", content: toolCalls ? null : content };
  if (msg.reasoning) message.reasoning_content = msg.reasoning;
  if (toolCalls) message.tool_calls = toolCalls;

  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: data.created || Math.floor(Date.now() / 1000),
    model: data.model || model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, x-api-key",
    });
    return res.end();
  }

  if (req.method === "GET" && path === "/health") {
    return sendJson(res, 200, {
      ok: true,
      sessions_cached: sessions.size,
      tool: TOOL_SLUG,
      tool_mode: TOOL_MODE,
    });
  }

  if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
    return sendJson(res, 200, {
      object: "list",
      data: MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "composio-openrouter" })),
    });
  }

  const isChat =
    path === "/v1/chat/completions" ||
    path === "/chat/completions" ||
    path === "/v1/v1/chat/completions";
  if (req.method === "POST" && isChat) {
    let apiKey;
    try {
      apiKey = authKey(req);
    } catch (e) {
      return sendError(res, e.status || 401, e.message, { type: "invalid_request_error" });
    }

    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendError(res, 400, e.message, { type: "invalid_request_error" });
    }

    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const emulateTools = hasTools && TOOL_MODE === "emulate";

    let args;
    try {
      args = toComposioArgs(body, { emulateTools });
    } catch (e) {
      return sendError(res, 400, e.message, { type: "invalid_request_error" });
    }

    try {
      const result = await executeCompletion(apiKey, args);
      const usage = result.data?.usage;
      const charge = result.instant_charge?.amount;
      log(
        `model=${args.model} tools=${hasTools ? (emulateTools ? "emul" : "pass") : "no"} tokens=${usage?.total_tokens ?? "?"} charge=${charge ?? "-"} log=${result.log_id ?? "-"}`,
      );

      if (body.stream) {
        const includeUsage = body.stream_options?.include_usage === true;
        return await streamCompletion(res, result, args.model, includeUsage, emulateTools);
      }
      return sendJson(res, 200, toOpenAIResponse(result.data, args.model, emulateTools));
    } catch (e) {
      const mapped = mapUpstreamError(e);
      log(`ERROR model=${args.model} -> ${mapped.status} ${e.message}`);
      return sendError(res, mapped.status, mapped.message, { type: mapped.type, code: e.slug || null });
    }
  }

  sendError(res, 404, `Unknown route: ${req.method} ${path}`, { type: "invalid_request_error" });
});

server.listen(PORT, () => {
  console.log(`Composio-OpenRouter proxy on http://localhost:${PORT}/v1`);
  console.log(`  POST /v1/chat/completions   -> ${TOOL_SLUG} (Instant)`);
  console.log(`  GET  /v1/models`);
  console.log(`  GET  /health`);
  console.log(`  tool_mode=${TOOL_MODE}  user_id=${PROXY_USER_ID}  default_key=${DEFAULT_API_KEY ? "set" : "from Bearer"}`);
});
