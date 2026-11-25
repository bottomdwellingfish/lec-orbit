# 多阶段轻量构建：NestJS 12 (@nestjs/platform-node) + TypeORM + Bun 1.4.4（兼容校园无 AVX2 CPU 与 Node 22+）
ARG BUN_IMAGE=oven/bun:1.4.4-slim

FROM ${BUN_IMAGE} AS builder
WORKDIR /src

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .
RUN bun run typecheck && bun run test && bun run build

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOME=/tmp

COPY --from=builder /src/package.json ./
COPY --from=builder /src/node_modules ./node_modules
COPY --from=builder /src/dist ./dist
# 确保支持任意非 root UID（如 K3s securityContext runAsUser: 65532 + readOnlyRootFilesystem）
RUN chmod -R a+rX /app

USER 65532
EXPOSE 8080
CMD ["bun", "run", "dist/main.js"]
