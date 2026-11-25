# 多阶段精简构建：NestJS 12 (@nestjs/platform-node) + TypeORM + Bun 1.4.5 baseline（兼容校园无 AVX2 CPU）+ Node 24 双兼容
ARG NODE_IMAGE=node:24.14.1-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmmirror.com

FROM ${NODE_IMAGE} AS builder
ARG NPM_REGISTRY
WORKDIR /src

# 安装 Bun（强制拉取 linux-x64-baseline 以兼容无 AVX2 的 Xeon E5 校园物理机）
RUN npm install -g bun@1.4.5 @oven/bun-linux-x64-baseline@1.4.5 --registry=${NPM_REGISTRY} --force \
    && BASELINE_BIN="$(npm root -g)/@oven/bun-linux-x64-baseline/bin/bun" \
    && if [ -x "$BASELINE_BIN" ]; then ln -sf "$BASELINE_BIN" /usr/local/bin/bun; fi \
    && bun --version

COPY package.json ./
# 使用 npm 串行稳定安装依赖以适配校园网 DNS 与国内镜像站，构建/测试/运行均走 Bun 1.4.5
RUN npm install --no-audit --no-fund --registry=${NPM_REGISTRY}

COPY . .
RUN bun run typecheck && bun run test && bun run build

# 仅打包生产依赖与编译产物，并提前设置权限避免运行阶段 overlayfs 复制膨胀
RUN mkdir -p /prod \
    && cp package.json /prod/ \
    && cp -r dist /prod/dist \
    && cd /prod && npm install --omit=dev --no-audit --no-fund --registry=${NPM_REGISTRY} \
    && chmod -R a+rX /prod

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOME=/tmp

COPY --from=builder /usr/local/lib/node_modules/@oven/bun-linux-x64-baseline/bin/bun /usr/local/bin/bun
COPY --from=builder /prod/package.json ./
COPY --from=builder /prod/node_modules ./node_modules
COPY --from=builder /prod/dist ./dist
RUN chmod 755 /usr/local/bin/bun

USER 65532
EXPOSE 8080
CMD ["bun", "run", "dist/main.js"]
