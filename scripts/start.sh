#!/bin/bash
# Axiom AI Agent 启动脚本
# 支持开发模式、生产模式、后台守护进程模式

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.axiom.pid"
LOG_FILE="$PROJECT_DIR/data/logs/axiom.log"
MODE="${1:-prod}"

cd "$PROJECT_DIR"

# 确保日志目录存在
mkdir -p "$PROJECT_DIR/data/logs"

# 检查依赖
if ! command -v bun &> /dev/null; then
    echo "错误: 未找到 bun。请先安装 Bun: https://bun.sh"
    exit 1
fi

# 加载环境变量
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

case "$MODE" in
    dev)
        echo "🚀 启动 Axiom 开发模式..."
        bun --watch run src/main.ts
        ;;
    
    prod|production)
        echo "🚀 启动 Axiom 生产模式..."
        bun run src/main.ts
        ;;
    
    daemon|background)
        if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
            echo "⚠️  Axiom 已经在运行 (PID: $(cat "$PID_FILE"))"
            exit 0
        fi
        
        echo "🚀 后台启动 Axiom..."
        nohup bun run src/main.ts > "$LOG_FILE" 2>&1 &
        echo $! > "$PID_FILE"
        echo "✅ Axiom 已后台启动 (PID: $(cat "$PID_FILE"))"
        echo "📋 日志文件: $LOG_FILE"
        ;;
    
    stop)
        if [ -f "$PID_FILE" ]; then
            PID=$(cat "$PID_FILE")
            if kill -0 "$PID" 2>/dev/null; then
                echo "🛑 停止 Axiom (PID: $PID)..."
                kill "$PID"
                rm -f "$PID_FILE"
                echo "✅ Axiom 已停止"
            else
                echo "⚠️  进程不存在，清理 PID 文件"
                rm -f "$PID_FILE"
            fi
        else
            echo "⚠️  Axiom 未运行"
        fi
        ;;
    
    restart)
        $0 stop
        sleep 2
        $0 daemon
        ;;
    
    status)
        if [ -f "$PID_FILE" ]; then
            PID=$(cat "$PID_FILE")
            if kill -0 "$PID" 2>/dev/null; then
                echo "✅ Axiom 运行中 (PID: $PID)"
                echo "📋 日志: $LOG_FILE"
                echo "🌐 端口: ${PORT:-3000}"
            else
                echo "❌ Axiom 未运行 (PID 文件存在但进程不存在)"
            fi
        else
            echo "❌ Axiom 未运行"
        fi
        ;;
    
    logs)
        if [ -f "$LOG_FILE" ]; then
            tail -f "$LOG_FILE"
        else
            echo "日志文件不存在"
        fi
        ;;
    
    setup)
        echo "🔧 运行 Axiom 设置向导..."
        bun run src/cli.ts setup
        ;;
    
    health)
        bun run scripts/health-check.ts
        ;;
    
    *)
        echo "用法: $0 {dev|prod|daemon|stop|restart|status|logs|setup|health}"
        echo ""
        echo "模式说明:"
        echo "  dev      - 开发模式 (热重载)"
        echo "  prod     - 生产模式 (前台运行)"
        echo "  daemon   - 后台守护进程模式"
        echo "  stop     - 停止后台进程"
        echo "  restart  - 重启后台进程"
        echo "  status   - 查看运行状态"
        echo "  logs     - 查看实时日志"
        echo "  setup    - 运行配置向导"
        echo "  health   - 运行健康检查"
        exit 1
        ;;
esac
