# `@lec-orbit/server` — 乐程 Orbit 统一核心服务端

基于 **NestJS 12 (`@nestjs/platform-node` 官方原生 HTTP 底层)** + **TypeORM 1.1** + **PostgreSQL**，同时兼容 **Bun 1.3+** 与 **Node.js 22+** 运行时。

## 核心能力模块

- **认证与成员花名册**（`AuthModule` / `RosterModule`）：LecSSO JWKS 验签 + Opaque Token 校验 + M2M 组织成员定时同步。
- **实时推送总线**（`RealtimeModule`）：原生 WebSocket `/api/v1/ws`（兼容原 `{ type, payload }` 协议，30s 心跳，可选 Redis Pub/Sub 跨副本同步）。
- **公告与已读回执**（`AnnouncementsModule`）：富文本安全清洗、置顶、全员已读/未读清单、未读提醒与 RustFS 图片直传。
- **统一通知中心与桥接**（`NotificationsModule`）：站内通知、云文档编辑权限审批（`DocBridge`）、Devtron 发版通知与 GitHub 贡献归属。
- **工坊应用容器后端**（`MiniAppsModule`）：ZIP 构建包安全校验（防 Zip Bomb / 路径穿越 / 符号链接）、GitHub Releases 导入、版本审核与用户云存档 KV。
- **乐币与打卡时长通用交易底层**（`EconomyModule`）：
  - 极简双资产：`coin`（乐币，跨周留存）+ `punch_minutes`（本周打卡时长，不修改原始考勤）+ 只读 `lifetimeEarnedCoins`；
  - 5 道防刷硬防线：零和守恒强校验、一应用一密钥（AES-256-GCM 静态加密 + 全要素 HMAC-SHA256 + Nonce 防重放）、后端强校验应用上架与 Manifest scope、每周净赢/净输与同对手频次硬上限 + 真实打卡门槛、双超时自动解冻退款调度器。

## 本地开发与校验

```bash
# 1. 启动本地 PostgreSQL 16 + Redis 7
docker compose -f docker-compose.dev.yml up -d

# 2. 安装依赖与运行检查
bun install
bun run typecheck
bun run test
bun run build

# 3. 启动服务（Bun 或 Node 22+ 均可）
DATABASE_URL=postgres://orbit:orbit_dev_password@127.0.0.1:15432/lec_orbit_dev bun run dev
# 或 Node 模式：
DATABASE_URL=postgres://orbit:orbit_dev_password@127.0.0.1:15432/lec_orbit_dev node dist/main.js
```

## 关键新增环境变量

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `ECONOMY_CREDENTIAL_MASTER_KEY` | 回退 `ORBIT_INTERNAL_TOKEN` | 加密存储工坊应用 S2S 密钥的 AES-256 主密钥 |
| `ECONOMY_PUNCH_AFFECTS_ASSESSMENT` | `true` | `punch_minutes` 交易时长是否并入周考核总开关 |
| `ECONOMY_BURN_RATE_BPS` | `0` | 可选 `coin` 交易燃烧税（万分比，如 `200` = 2%） |
| `ECONOMY_MAX_COIN_PER_ORDER` | `50` | 单笔乐币赌约/打赏上限 |
| `ECONOMY_MAX_PUNCH_PER_ORDER` | `30` | 单笔打卡时长赌约上限（分钟） |
| `ECONOMY_WEEKLY_PUNCH_GAIN_LIMIT` | `60` | 每周净赢打卡时长硬上限（分钟，防刷周考核） |
| `ECONOMY_PUNCH_MIN_RECORDED_MINUTES` | `60` | 参与打卡时长赌约所需的本周最低真实打卡分钟数 |

## MongoDB → PostgreSQL 生产数据无损迁移（LecPunch 融合）

所有 20 张 LecPunch 集合均以原 24 位 ObjectId 字符串作为 PostgreSQL `TEXT` 主键，支持零 ID 重写、100% 幂等重跑与逐表 SHA256 指纹核验：

```bash
# 1. 只读预演（输出 20 张表记录数与期初乐币 1:1 结转预览，不写入任何数据）
MONGO_URL="mongodb://..." DATABASE_URL="postgres://..." bun run migrate:mongo:dry-run

# 2. 执行全量幂等迁移 + 存量 totalPoints 1:1 结转期初 coin + 自动逐表核验
MONGO_URL="mongodb://..." DATABASE_URL="postgres://..." bun run migrate:mongo

# 3. 随时单独重跑逐表指纹与业务总和核验（行数 + ID SHA256 + 有效打卡总秒数 + 总积分 + 总财务分值）
MONGO_URL="mongodb://..." DATABASE_URL="postgres://..." bun run migrate:mongo:verify
```
