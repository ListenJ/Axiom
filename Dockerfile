# OpenClaw AI Agent — Docker 镜像
# 构建: docker build -t openclaw-agent .
# 运行: docker-compose up -d

FROM oven/bun:1.3-alpine AS base

WORKDIR /app

# 安装基础依赖
RUN apk add --no-cache curl ca-certificates

# 复制依赖文件
COPY package.json bun.lock ./
RUN bun install --production

# 复制源码
COPY tsconfig.json ./
COPY config/ ./config/
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY openclaw-memory/ ./openclaw-memory/

# 创建数据目录（read_only 根文件系统需要 tmpfs）
RUN mkdir -p data

# 暴露端口
EXPOSE 18789 3001

# 健康检查
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:18789/health || exit 1

# 启动命令
CMD ["bun", "run", "src/main.ts"]
