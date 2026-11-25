# 多阶段轻量构建：NestJS 12 (@nestjs/platform-node) + TypeORM + Bun（同时兼容 Node 22+）
ARG BUN_IMAGE=oven/bun:1.3-alpine

FROM ${BUN_IMAGE} AS builder
WORKDIR /src

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .
RUN bun run typecheck && bun run test && bun run build

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /src/package.json ./
COPY --from=builder /src/node_modules ./node_modules
COPY --from=builder /src/dist ./dist

USER bun
EXPOSE 8080
CMD ["bun", "run", "dist/main.js"]
