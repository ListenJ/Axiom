#!/bin/bash
# OpenClaw Agent 安装辅助脚本
# 一键检测并安装 OpenCode 和 Hermes Agent
# 用法: bash scripts/setup-agents.sh

set -e

echo "🦅 OpenClaw Agent 安装辅助脚本"
echo "================================"
echo ""

# 检测操作系统
OS=""
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  OS="linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
  OS="macos"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
  OS="windows"
else
  OS="unknown"
fi

echo "📋 系统: $OS"
echo ""

# ===== OpenCode =====
echo "🔧 检查 OpenCode..."
if command -v opencode &> /dev/null; then
  echo "  ✅ OpenCode 已安装: $(opencode --version)"
  echo "  🆓 免费模型:"
  echo "     • opencode/deepseek-v4-flash-free"
  echo "     • opencode/big-pickle"
  echo "     • opencode/nemotron-3-super-free"
else
  echo "  ❌ OpenCode 未安装"
  echo "  📥 安装方式（选择一种）:"
  echo "     1. 官方脚本: curl -fsSL https://opencode.ai/install.sh | bash"
  echo "     2. npm:      npm install -g opencode"
  echo "     3. 手动:     https://github.com/opencode-ai/opencode/releases"
  echo ""
  read -p "是否自动安装 OpenCode? (y/n) " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "⬇️  正在安装 OpenCode..."
    if command -v npm &> /dev/null; then
      npm install -g opencode
    else
      curl -fsSL https://opencode.ai/install.sh | bash
    fi
    echo "✅ OpenCode 安装完成"
  fi
fi

echo ""

# ===== Hermes =====
echo "🔧 检查 Hermes Agent..."
if command -v hermes &> /dev/null; then
  echo "  ✅ Hermes 已安装"
  echo "  📝 配置 MCP 连接 OpenClaw:"
  echo "     编辑 ~/.hermes/config.yaml，添加 mcp_servers.openclaw"
else
  echo "  ❌ Hermes 未安装"
  echo "  📥 安装方式:"
  echo "     1. 一键脚本: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"
  echo "     2. pip:      pip install hermes-agent"
  echo "     3. Docker:   docker run -d --name hermes nousresearch/hermes-agent"
  echo ""
  read -p "是否自动安装 Hermes? (y/n) " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "⬇️  正在安装 Hermes..."
    curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
    echo "✅ Hermes 安装完成"
    echo ""
    echo "⚠️  请配置 Hermes 的 API Key:"
    echo "   hermes config set provider.api_key \$YOUR_KEY"
  fi
fi

echo ""
echo "================================"
echo "🎉 检查完成!"
echo ""
echo "快速开始:"
echo "  1. 复制 .env.example 为 .env 并填入 API Key"
echo "  2. 启动 OpenClaw:     bun run start"
echo "  3. 编码:              bun run src/cli.ts code:open"
echo "  4. 项目管理:          bun run src/cli.ts project:plan '你的项目描述'"
echo "  5. 检查状态:          bun run src/cli.ts agent:status"
echo ""
