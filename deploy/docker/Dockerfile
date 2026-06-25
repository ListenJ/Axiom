FROM oven/bun:1 AS base
WORKDIR /app

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖文件
COPY package.json bun.lockb* ./
RUN bun install --production

# 复制源码
COPY . .

# 创建数据目录
RUN mkdir -p data/logs data/vault .codegraph

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["bun", "run", "src/main.ts"]
