# Axiom AI Agent — Docker 镜像 (多阶段构建)
# 构建: docker build -t axiom-agent .
# 运行: docker-compose up -d

# ========== Stage 1: Dependencies ==========
FROM oven/bun:1.4.3-alpine AS deps

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts  # postinstall(ensure-env.ts) 仅生成本地 .env，镜像构建不需要

# ========== Stage 2: Build (optional bundling) ==========
FROM oven/bun:1.4.3-alpine AS builder

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts  # postinstall(ensure-env.ts) 仅生成本地 .env，镜像构建不需要
COPY tsconfig.json ./
COPY src/ ./src/

# Bundle to single file (faster cold start, smaller runtime)
RUN bun build src/main.ts --outdir ./dist --target bun --minify

# ========== Frontend stage: build SPA into dist/ ==========
FROM oven/bun:1.4.3-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts  # postinstall(ensure-env.ts) 仅生成本地 .env，镜像构建不需要
COPY frontend/ ./
RUN bun run build

# ========== Stage 3: Production ==========
FROM oven/bun:1.4.3-alpine AS runner

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
# 注（2026-10-19）：不再 COPY src/db/pg-schema.sql。
# PostgreSQL 已随 H-M1-03 移除，该 schema 在仓库中仅作历史参考、**无运行时消费者**；
# 打进镜像只是死载荷（每次构建多一层、镜像多 16KB），且与 `db:init` 的"已归档"表述矛盾。
# 如需恢复 PG 能力，按规则 4 先裁决该文件存废，再重建客户端与索引迁移。

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
