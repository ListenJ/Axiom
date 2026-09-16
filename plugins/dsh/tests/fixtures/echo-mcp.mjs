/**
 * 最小 MCP stdio 服务器（测试夹具）：注册一个 echo 工具，--exit-after-ms 后主动退出，
 * 用来验证 axiom-dsh 桥的断连感知（onclose → 摘工具 → 状态翻转）。
 * 不依赖 Axiom 主服务器，可独立跑在任何平台。
 */
import { writeFileSync } from 'node:fs'
const exitAfter = Number(process.argv[2] ?? '1200')
// --notify-after-ms 后发送 tools/list_changed 通知（随后多注册一个工具），
// 用来验证桥的动态重同步
const notifyAfter = Number(process.argv[3] ?? '0')

function notify(method) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
}

let extraTool = false
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    let req
    try {
      req = JSON.parse(line)
    } catch {
      continue
    }
    if (req.id === undefined) continue // 通知
    const method = req.method
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'echo-mcp', version: '0.0.0' },
        },
      })
    } else if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: '回声',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            },
            ...(extraTool
              ? [
                  {
                    name: 'echo2',
                    description: '回声2',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ]
              : []),
          ],
        },
      })
    } else if (method === 'tools/call') {
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: { content: [{ type: 'text', text: String(req.params?.arguments?.text ?? '') }] },
      })
    } else {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'not found' } })
    }
  }
})

// 客户端关闭 transport（dispose/测试退出）时随之退出，避免孤儿进程
const exit = (code) => {
  if (process.env.DSH_TEST_MARKER) {
    try { writeFileSync(process.env.DSH_TEST_MARKER, String(code)) } catch { /* 测试可选标记 */ }
  }
  process.exit(code)
}
process.stdin.on('end', () => exit(0))
process.stdin.on('close', () => exit(0))

if (notifyAfter > 0) {
  setTimeout(() => {
    extraTool = true
    notify('notifications/tools/list_changed')
  }, notifyAfter)
}

setTimeout(() => exit(0), exitAfter)
