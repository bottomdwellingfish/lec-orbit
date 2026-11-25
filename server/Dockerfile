# 多阶段构建：NestJS 12 (@nestjs/platform-node) + TypeORM + Bun（Baseline 兼容校园无 AVX2 CPU）+ Node 24 双兼容
ARG NODE_IMAGE=node:24.14.1-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmmirror.com

FROM ${NODE_IMAGE} AS builder
ARG NPM_REGISTRY
WORKDIR /src

# 安装 Bun（强制同时拉取 linux-x64-baseline 以兼容无 AVX2 的 Xeon E5 校园物理机）
RUN npm install -g bun@1.4.5 @oven/bun-linux-x64-baseline@1.4.5 --registry=${NPM_REGISTRY} --force \
    && BASELINE_BIN="$(npm root -g)/@oven/bun-linux-x64-baseline/bin/bun" \
    && if [ -x "$BASELINE_BIN" ]; then ln -sf "$BASELINE_BIN" /usr/local/bin/bun; fi \
    && bun --version

COPY package.json bun.lock* ./
RUN bun install --registry=${NPM_REGISTRY}

COPY . .
RUN bun run typecheck && bun run test && bun run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOME=/tmp

COPY --from=builder /usr/local/lib/node_modules/@oven/bun-linux-x64-baseline/bin/bun /usr/local/bin/bun
COPY --from=builder /src/package.json ./
COPY --from=builder /src/node_modules ./node_modules
COPY --from=builder /src/dist ./dist
RUN chmod 755 /usr/local/bin/bun && chmod -R a+rX /app

USER 65532
EXPOSE 8080
CMD ["bun", "run", "dist/main.js"]
