# Axiom AI Agent — Docker 镜像 (多阶段构建)
# 构建: docker build -t axiom-agent .
# 运行: docker-compose up -d

# ========== Stage 1: Dependencies ==========
FROM oven/bun:1.3-alpine AS deps

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ========== Stage 2: Build (optional bundling) ==========
FROM oven/bun:1.3-alpine AS builder

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ ./src/

# Bundle to single file (faster cold start, smaller runtime)
RUN bun build src/main.ts --outdir ./dist --target bun --minify

# ========== Frontend stage: build SPA into dist/ ==========
FROM oven/bun:1.3-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile
COPY frontend/ ./
RUN bun run build

# ========== Stage 3: Production ==========
FROM oven/bun:1.3-alpine AS runner

WORKDIR /app

# 基础工具
RUN apk add --no-cache curl ca-certificates && \
    addgroup -S appgroup && adduser -S appuser -G appgroup

# 复制依赖
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# 复制配置和静态资源
COPY package.json ./
COPY config/ ./config/
COPY public/ ./public/
COPY --from=frontend-builder /app/frontend/dist/ ./public/
COPY scripts/ ./scripts/
COPY src/db/pg-schema.sql ./src/db/pg-schema.sql

# 创建数据目录（axiom-memory 由 compose volume 挂载，构建期不存在也允许）
RUN mkdir -p data axiom-memory && chown -R appuser:appgroup /app

USER appuser

# 暴露端口
EXPOSE 18789 3001

# 健康检查
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:18789/health || exit 1

# 启动命令 (使用 bundled 版本，更快启动)
CMD ["bun", "run", "dist/main.js"]
