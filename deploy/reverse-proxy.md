# 反向代理配置 — TLS 终结 + 反代到 axiom-agent

axiom-agent 默认监听 `127.0.0.1:18789`（HTTP API / WebSocket `/ws` / SSE `/chat/stream`）。
生产环境建议仅在本机暴露该端口，由 nginx 或 Caddy 做 TLS 终结与反向代理。

## 远程 WebSocket 订阅鉴权（approval.requested / 审批弹窗）

浏览器 WebSocket API **无法自定义请求头**，因此远程（非回环）部署下前端审批订阅
无法像 REST 一样带 `x-api-key`。后端 `/ws` 升级鉴权现支持三种凭证通道（`src/utils/ws-auth.ts`）：

1. **Header**：`x-api-key` 或 `Authorization: Bearer <token>`（CLI/脚本/非浏览器客户端）；
2. **Sec-WebSocket-Protocol 子协议**（浏览器推荐）：前端以 `['axiom', 'axiom.auth.<token>']`
   发起握手，后端校验后回显 `axiom` 完成连接 —— token 不进 URL，不落访问日志/Referrer；
3. **URL query**：`/ws?token=<token>`（无法设置 header/子协议的非浏览器客户端）。

安全要点：

- 回环（127.0.0.1/::1）按对端 socket 地址豁免（开发便利，与 REST 一致）；
- 未配置 `AXIOM_AUTH_TOKEN` 时远程一律拒绝（fail-closed）；
- query token 会出现在 URL 中：仅建议在无法使用子协议的场景使用，且必须经本页 TLS 反代；
- 所有通道均用常量时间比较（`safeStringEqual`），防时序侧信道。

```bash
# 非浏览器客户端经 query token 订阅示例
bun -e '
const ws = new WebSocket("wss://axiom.example.com/ws?token=$AXIOM_AUTH_TOKEN");
ws.onopen = () => ws.send(JSON.stringify({ action: "subscribe", types: ["approval.requested"] }));
ws.onmessage = (e) => console.log(e.data);
'
```

## 通用注意事项

- **WebSocket**：`/ws` 路径需要传递 `Upgrade` / `Connection` 头，否则握手失败。
- **SSE**：`/chat/stream` 是 Server-Sent Events 长连接，必须关闭代理缓冲
  （nginx: `proxy_buffering off`；Caddy 默认不缓冲，无需额外配置），否则事件会整段延迟到达。
- **超时**：SSE / WebSocket 均为长连接，读取超时要放宽（建议 ≥ 300s），避免空闲连接被代理切断。
- **Host 头**：传递原始 `Host`，后端部分路由依赖它生成回调地址。

## nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name axiom.example.com;

    ssl_certificate     /etc/letsencrypt/live/axiom.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/axiom.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket：必须带升级头
    location /ws {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }

    # SSE：关闭缓冲，事件即时下发
    location /chat/stream {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}

# HTTP → HTTPS 跳转
server {
    listen 80;
    server_name axiom.example.com;
    return 301 https://$host$request_uri;
}
```

## Caddy

Caddy 自动申请 / 续期 TLS 证书，且默认不做响应缓冲、自动处理 WebSocket 升级头，
单条 `reverse_proxy` 即可覆盖普通 HTTP、`/ws` 和 `/chat/stream`：

```caddyfile
axiom.example.com {
    reverse_proxy 127.0.0.1:18789
}
```

如需显式控制（例如自定义超时），等价展开形式：

```caddyfile
axiom.example.com {
    reverse_proxy 127.0.0.1:18789 {
        # 长连接（SSE / WebSocket）放宽读取超时
        transport http {
            read_timeout 3600s
        }
    }
}
```

注意：Caddy 的 `reverse_proxy` 默认透传 `Upgrade`/`Connection` 头且不缓冲响应体，
**不要**在 `/chat/stream` 前叠加 `encode`（压缩）或缓存类中间件，否则会破坏 SSE 的流式下发。

## 验证

```bash
# TLS + HTTP
curl -I https://axiom.example.com/health

# WebSocket（应返回 101 Switching Protocols）
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" \
     https://axiom.example.com/ws

# SSE（应持续输出 event 流而非一次性返回）
curl -N https://axiom.example.com/chat/stream
```
