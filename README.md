# Composio → OpenRouter Proxy

A tiny, zero-dependency Node.js proxy that exposes an **OpenAI-compatible**
`/v1/chat/completions` API and forwards requests to OpenRouter through
**Composio's Instant tool** `OPENROUTER_CREATE_CHAT_COMPLETION`.

```
Client (opencode, SDKs, curl)
      │  OpenAI API
      ▼
  proxy.mjs  ──►  Composio session execute(OPENROUTER_CREATE_CHAT_COMPLETION)  ──►  OpenRouter
```

## What it's for

- Use OpenRouter models (Claude, GPT, Gemini, Grok, DeepSeek, Qwen, Kimi, GLM, …)
  through **Composio managed credits** without an OpenRouter API key of your own.
- Plug it into any tool that speaks the OpenAI Chat Completions API.
- Keeps a cached Composio session per key and recreates it automatically when it expires.

## Requirements

- Node.js **18+** (no npm install needed).
- A Composio account with **Instant Toolkits** enabled for `openrouter` and billing available.
- A Composio API key (`ak_...`).

## Usage

```bash
# Option A: key passed by the client (Bearer / x-api-key)
node proxy.mjs

# Option B: key supplied by the environment
COMPOSIO_API_KEY=ak_xxx node proxy.mjs

# Custom port
PORT=9000 node proxy.mjs
```

Call it like any OpenAI endpoint:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer ak_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-opus-5.5",
    "messages": [{ "role": "user", "content": "Hello!" }],
    "max_tokens": 1024
  }'
```

### Using it from opencode

```jsonc
{
  "provider": {
    "composio": {
      "options": {
        "baseURL": "http://localhost:8787/v1",
        "timeout": false
      },
      "models": {
        "anthropic/claude-opus-5.5": { "name": "Claude Opus 5.5" }
      }
    }
  }
}
```

Start the proxy, then in opencode run `/connect` → **Composio** and paste your
Composio key (or set `options.apiKey` directly).

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | Chat completions (streaming supported) |
| `GET`  | `/v1/models` | Curated model list |
| `GET`  | `/health` | Health / session cache info |

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `COMPOSIO_API_KEY` | _(empty)_ | Fallback key when the request sends none |
| `PROXY_USER_ID` | `opencode-proxy` | Composio `user_id` used for sessions |
| `TOOL_MODE` | `emulate` | `emulate` (tool calling on) or `off` |
| `SHOW_REASONING` | `1` | Set to `0` to disable `reasoning_content` streaming |
| `MAX_OUTPUT_TOKENS` | `1024` | Upper bound for `max_tokens` before forwarding |

Auth: `Authorization: Bearer ak_...` or `x-api-key: ak_...`.

## Notes

- **Instant output cap:** Composio's managed OpenRouter allows at most **1024
  output tokens per call**. Larger `max_tokens` values are clamped automatically.
- **Tool calling is emulated.** Instant does not expose native `tool_calls`, so
  tool schemas are injected into the system prompt and the model is asked to reply
  with a JSON tool-call object, which the proxy converts back into OpenAI
  `tool_calls`. This works but is less reliable than native tool calling. Set
  `TOOL_MODE=off` to disable.
- **No vision.** The Instant tool only accepts string message content, so image
  parts are dropped and replaced with
  `[image omitted: vision is not supported by this provider]`. For real image
  support you need your own OpenRouter key (BYOK) and the
  `OPENROUTER_CREATE_MESSAGE` tool, which supports multimodal content.
- **Single tool only.** Instant permits only `OPENROUTER_CREATE_CHAT_COMPLETION`
  for the `openrouter` toolkit; other tools are rejected by Composio.
- **Sessions** are cached per API key and recreated automatically on expiry or
  connection errors.
- **Security:** never commit a real `ak_...` key. Prefer passing it per request or
  via the environment, and keep this proxy bound to localhost.
