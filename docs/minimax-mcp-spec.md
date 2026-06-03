# MiniMax MCP Specification

## Overview

MiniMax MCP 集成将 MiniMax Token Plan 作为工具类模型接入 OpenClaw。同一 API Key 可用于模型调用和 MCP 工具调用，简化了配置管理。

**支持的 MCP 工具**:
- `minimax_web_search` - 网络搜索
- `minimax_image_understand` - 图像识别
- `minimax_health` - 健康检查

**API 端点**: `https://api.minimax.io`

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    MiniMax MCP Integration                   │
├─────────────────────────────────────────────────────────────┤
│  MCP Server (ToolRegistry)                                   │
│  ├─ minimax_web_search                                      │
│  ├─ minimax_image_understand                                │
│  └─ minimax_health                                          │
├─────────────────────────────────────────────────────────────┤
│  MiniMax API Client                                          │
│  ├─ callMiniMaxAPI() - Generic API wrapper                  │
│  ├─ withRetry() - Retry with exponential backoff            │
│  └─ withTimeout() - Timeout handling                        │
├─────────────────────────────────────────────────────────────┤
│  MiniMax API (api.minimax.io)                                │
│  ├─ POST /v1/coding_plan/search - Web Search                │
│  └─ POST /v1/coding_plan/vlm - Image Understanding          │
└─────────────────────────────────────────────────────────────┘
```

---

## API Reference

### Authentication

All requests require an API Key in the Authorization header:

```
Authorization: Bearer {MINIMAX_API_KEY}
MM-API-Source: Minimax-MCP
```

### Web Search

**Endpoint**: `POST /v1/coding_plan/search`

**Request**:
```json
{
  "q": "OpenClaw AI Agent",
  "num": 5
}
```

**Response**:
```json
{
  "status": 200,
  "data": {
    "results": [
      {
        "title": "OpenClaw - AI Agent Platform",
        "url": "https://github.com/ListenJ/openclaw-fusion",
        "snippet": "OpenClaw is an AI Agent platform..."
      }
    ]
  }
}
```

**Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| q | string | Yes | Search query |
| num | number | No | Number of results (default: 5) |

**MCP Tool Definition**:
```typescript
{
  name: "minimax_web_search",
  description: "Search the web using MiniMax",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      num: { type: "number", description: "Number of results (default: 5)" }
    },
    required: ["query"]
  }
}
```

### Image Understanding

**Endpoint**: `POST /v1/coding_plan/vlm`

**Request**:
```json
{
  "image_url": "https://example.com/image.png"
}
```

**Response**:
```json
{
  "status": 200,
  "data": {
    "description": "A screenshot of a code editor showing..."
  }
}
```

**Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| image_url | string | Yes | URL of the image to analyze |

**MCP Tool Definition**:
```typescript
{
  name: "minimax_image_understand",
  description: "Analyze an image using MiniMax VLM",
  inputSchema: {
    type: "object",
    properties: {
      image_url: { type: "string", description: "URL of the image" }
    },
    required: ["image_url"]
  }
}
```

### Health Check

**Endpoint**: `GET /v1/health` (or any lightweight endpoint)

**Response**:
```json
{
  "status": 200,
  "data": {
    "ok": true
  }
}
```

**MCP Tool Definition**:
```typescript
{
  name: "minimax_health",
  description: "Check MiniMax API health",
  inputSchema: {
    type: "object",
    properties: {}
  }
}
```

---

## Implementation

### File: `src/mcp/tools/minimax.ts`

```typescript
/**
 * MiniMax MCP 工具封装
 * 
 * API 文档: https://platform.minimax.io/docs/guides/token-plan-mcp-guide
 * Token Plan: https://api.minimax.io
 * 标准版: https://api.minimax.chat
 */

import { logger } from "../../utils/logger.js";
import { TIMEOUTS } from "../../constants/timeouts.js";
import { withRetry, withTimeout } from "../../utils/resilience.js";

interface MiniMaxConfig {
  apiKey: string;
  baseUrl: string;
}

function getMiniMaxConfig(): MiniMaxConfig {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    throw new Error("MiniMax API key not configured. Set MINIMAX_API_KEY.");
  }
  const baseUrl = process.env.MINIMAX_BASE_URL || "https://api.minimax.io";
  return { apiKey, baseUrl };
}

async function callMiniMaxAPI<T>(
  endpoint: string,
  body: Record<string, unknown>
): Promise<T> {
  const config = getMiniMaxConfig();
  const url = `${config.baseUrl}${endpoint}`;

  const response = await withTimeout(
    withRetry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            "MM-API-Source": "Minimax-MCP",
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`MiniMax API error ${res.status}: ${errorText}`);
        }
        return res;
      },
      { maxAttempts: 2, baseDelay: 500 }
    ),
    TIMEOUTS.API_DEFAULT
  );

  return response.json() as Promise<T>;
}

// Web Search
export async function minimaxWebSearch(args: { query: string; num?: number }) {
  const result = await callMiniMaxAPI<{ data?: { results?: Array<{ title: string; url: string; snippet: string }> } }>(
    "/v1/coding_plan/search",
    { q: args.query, num: args.num || 5 }
  );
  return result.data?.results || [];
}

// Image Understanding
export async function minimaxImageUnderstand(args: { image_url: string }) {
  const result = await callMiniMaxAPI<{ data?: { description?: string } }>(
    "/v1/coding_plan/vlm",
    { image_url: args.image_url }
  );
  return result.data?.description || "";
}

// Health Check
export async function checkMiniMaxHealth() {
  try {
    await callMiniMaxAPI("/v1/health", {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

### Registration in MCP Server

```typescript
// src/mcp/server.ts
import {
  minimaxWebSearch,
  minimaxImageUnderstand,
  checkMiniMaxHealth,
} from "./tools/minimax.js";

// In server initialization:
registry
  .add({
    name: "minimax_web_search",
    description: "Search the web using MiniMax",
    inputSchema: z.object({
      query: z.string(),
      num: z.number().optional(),
    }),
    handler: async (args) => minimaxWebSearch(args as { query: string; num?: number }),
  })
  .add({
    name: "minimax_image_understand",
    description: "Analyze an image using MiniMax VLM",
    inputSchema: z.object({
      image_url: z.string(),
    }),
    handler: async (args) => minimaxImageUnderstand(args as { image_url: string }),
  })
  .add({
    name: "minimax_health",
    description: "Check MiniMax API health",
    inputSchema: z.object({}),
    handler: async () => checkMiniMaxHealth(),
  });
```

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| MINIMAX_API_KEY | Yes | - | MiniMax API Key (Token Plan or Standard) |
| MINIMAX_BASE_URL | No | `https://api.minimax.io` | API Base URL |

### Token Plan vs Standard

| Feature | Token Plan | Standard |
|---------|-----------|----------|
| Base URL | `api.minimax.io` | `api.minimax.chat` |
| Web Search | ✅ | ❌ |
| Image Understand | ✅ | ❌ |
| Model Calls | ✅ | ✅ |
| Billing | Unified | Separate |

**Recommendation**: Use Token Plan for unified billing and access to MCP tools.

---

## Testing

**Test File**: `tests/minimax.test.ts`

**Test Cases**:
1. Web search with query
2. Web search with Chinese query
3. Image understand with URL
4. Health check
5. Error handling (invalid API key)
6. Error handling (invalid image URL)

**Run Tests**:
```bash
bun test tests/minimax.test.ts
```

**Results**: 6 pass, 0 fail (requires valid MINIMAX_API_KEY)

---

## Usage Examples

### Web Search
```bash
curl -X POST http://localhost:18789/mcp/tools/minimax_web_search \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{"query": "OpenClaw AI Agent", "num": 5}'
```

### Image Understand
```bash
curl -X POST http://localhost:18789/mcp/tools/minimax_image_understand \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{"image_url": "https://example.com/screenshot.png"}'
```

### Health Check
```bash
curl -X POST http://localhost:18789/mcp/tools/minimax_health \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key"
```

---

## Troubleshooting

### 401 Unauthorized
- Check `MINIMAX_API_KEY` is set correctly
- Verify API key has Token Plan subscription

### 404 Not Found
- Check `MINIMAX_BASE_URL` is correct
- Token Plan uses `api.minimax.io`, Standard uses `api.minimax.chat`

### Timeout
- Check network connectivity
- Increase timeout in `TIMEOUTS.API_DEFAULT`

---

## Future Enhancements

1. **Streaming Support**: Real-time search results
2. **Multi-modal**: Support for video and audio
3. **Caching**: Cache search results to reduce API calls
4. **Rate Limiting**: Smart rate limit handling

---

*Last Updated: 2026-06-03*
*Version: v2.3.0*
