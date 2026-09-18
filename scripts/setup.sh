#!/bin/bash
# Axiom AI Agent — 一键安装脚本

set -e

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║     Axiom AI Agent — 安装脚本                            ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# 检查 Bun
if ! command -v bun &> /dev/null; then
    echo "❌ Bun 未安装，正在安装..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi

echo "✅ Bun $(bun --version)"

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js 未安装，请先安装 Node.js 22+"
    exit 1
fi

echo "✅ Node.js $(node --version)"

# 安装依赖
echo ""
echo "📦 安装依赖..."
bun install

# 创建数据目录
mkdir -p data raw

# 检查 .env
if [ ! -f .env ]; then
    echo ""
    echo "📝 创建 .env 文件..."
    cp .env.example .env 2>/dev/null || echo "# 请手动创建 .env 文件" > .env
    echo "⚠️  请编辑 .env 填入你的 API 密钥"
fi

# 运行免费模型发现
echo ""
echo "🔍 发现免费模型..."
bun run scripts/discover-free-models.ts

# 健康检查
echo ""
echo "🏥 运行健康检查..."
bun run scripts/health-check.ts || true

echo ""
echo "✅ 安装完成！"
echo ""
echo "启动服务:"
echo "  bun run start"
echo ""
echo "开发模式:"
echo "  bun run dev"
