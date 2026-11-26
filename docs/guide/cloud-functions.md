# 托管云函数（Orbit FaaS）

Orbit 内置基于开源 **`supabase/edge-runtime`（Deno / V8 Isolate 沙箱）** 的托管无服务器云函数（FaaS）平台。
工坊开发者无需购买服务器、无需写 Dockerfile、无需申请域名或证书，只需在 ZIP 构建包内新增一个 `functions/` 目录，上传审核通过后即可**随应用自动上线**，享受毫秒级隔离执行、房间状态持久化、实时发牌推送、免密赌约结算、流式 AI 代理与加密环境变量托管。

## 一、什么时候用云函数 vs Nakama？

| 业务场景 | 推荐方案 | 原因 |
| --- | --- | --- |
| 回合制棋牌 / 狼人杀 / 剧本杀 / 跑团（防作弊、发暗牌、判定胜负） | **Orbit 云函数（FaaS）** | 无状态请求 + `ctx.roomState`（Redis 乐观锁）+ `ctx.realtime` 点对点发暗牌 |
| AI 聊天助手 / 翻译 / 代码评审 / 研报总结（需隐藏 API Key + 流式打字机） | **Orbit 云函数（FaaS）** | `ctx.secrets` 静态加密托管 Key + `async function*` 原生 SSE 流式输出 |
| 工具类小程序后端（Webhook 转发、数据聚合、排行榜校验） | **Orbit 云函数（FaaS）** | `ctx.kv` 应用级持久化 KV + `ctx.fetch` 白名单出网 |
| 60 FPS 动作/射击/格斗实时联机、高频位置同步 | **Nakama 多人联机（BaaS）** | 长连接 WebSocket 低延迟广播，见 [多人联机指南](/guide/multiplayer) |

---

## 二、5 分钟接入：目录结构与 Manifest

在你的工坊项目根目录下新建 `functions/` 文件夹（每个路由对应一个 `.ts` / `.js` / `.mjs` 文件，也可附带 `.json` 或 `.wasm` 产物）：

```text
my-werewolf-app/
├── orbit.manifest.json
├── index.html
├── assets/
└── functions/
    ├── deal.ts          # 路由名：deal
    ├── action.ts        # 路由名：action
    └── engine.wasm      # 可选：Go (TinyGo) / Rust / C++ 编译的 WebAssembly 逻辑模块
```

在 `orbit.manifest.json` 中声明 `cloud.functions`（如需实时推送加上 `realtime.room`）与 `functions` 块：

```json
{
  "schemaVersion": 1,
  "id": "lec-werewolf",
  "name": "乐程狼人杀",
  "version": "1.0.0",
  "type": "minigame",
  "engine": "web",
  "entry": "index.html",
  "permissions": {
    "scopes": [
      "user.profile",
      "cloud.functions",
      "realtime.room",
      "economy.wager.coin"
    ],
    "networkDomains": ["api.deepseek.com"]
  },
  "functions": {
    "dir": "functions",
    "timeoutMs": 5000,
    "allowStreaming": false,
    "routes": ["deal", "action"]
  }
}
```

::: tip 资源与安全配额
- 云函数目录最多 **32 个文件**，单文件 ≤ **2 MB**，总原始体积 ≤ **5 MB**，仅允许 `.ts` / `.js` / `.mjs` / `.json` / `.wasm`。
- 单次调用内存上限 **64 MB**，默认超时 **5 秒**（普通接口最高 `10000ms`；开启 `allowStreaming: true` 最高 `60000ms`）。
- 频次限流：单应用 **60 次/分钟**，单人单应用 **20 次/分钟**。
- **上传即安全扫描 + 队长源码审核**：禁止 `Deno.Command`、`Deno.env`、`process.env`、`eval`、`new Function` 与文件系统读写，且运行容器配有 Kubernetes `NetworkPolicy` 内核级出网隔离，严禁访问集群内网数据库与元数据地址。
:::

---

## 三、编写云函数：标准签名与 `ctx` 平台底座

每个云函数导出一个默认异步函数 `export default async function (ctx, body)`：
- `ctx`：Orbit 网关为本次调用注入的受控平台上下文（15 秒短期令牌绑定当前 `appId`，**天然防跨应用越权**）；
- `body`：客户端通过 `window.orbitSDK.cloud.call(fnName, payload)` 传入的 JSON 对象。

### 1. 身份信息 `ctx.user`

```ts
ctx.user // { userId, username, displayName, isCaptain }
```

服务端已基于 LecSSO JWT 完成真实身份校验，前端无法伪造。

### 2. 房间状态 `ctx.roomState`（Redis + 乐观锁 CAS）

适合存放回合制牌局的私密牌堆、玩家身份、回合进度等，仅服务端可见：

```ts
// 读取（直接返回存下的值，不存在返回 null）
const state = await ctx.roomState.get<{ phase: string; roles: Record<string, string> }>('room-01');

// 写入（ttlSeconds 默认 3600，范围 10~86400）
await ctx.roomState.set('room-01', { phase: 'night', roles }, 3600);

// 原子并发更新（内部自动重试 CAS 乐观锁，防两个玩家同时出牌覆盖）
const next = await ctx.roomState.update<{ votes: string[] }>('room-01', (cur) => ({
  votes: [...(cur?.votes ?? []), ctx.user.userId],
}));

// 删除
await ctx.roomState.del('room-01');
```

### 3. 实时消息推送 `ctx.realtime`（复用 Orbit `/api/v1/ws`）

无需自建 WebSocket 服务，云函数可直接给单个玩家发私密暗牌，或向房间内所有已加入玩家广播公开事件：

```ts
// 点对点推送（例如：只把狼人身份私发给某位玩家）
await ctx.realtime.sendToUser(playerId, 'role_assigned', { role: 'wolf' });

// 房间广播（推送给所有调用过 orbitSDK.realtime.joinRoom(roomId) 的在线成员）
await ctx.realtime.broadcastRoom('room-01', 'phase_changed', { phase: 'day', day: 2 });
```

### 4. 应用级全局持久化 KV `ctx.kv`（PostgreSQL）

与客户端 `orbitSDK.storage`（个人云存档）不同，`ctx.kv` 是**整个应用共享的持久化数据库**，适合做全服排行榜、赛季统计、全局配置（单条 ≤ 64 KB，单应用总额度 2 MB）：

```ts
const board = (await ctx.kv.get<Array<{ name: string; score: number }>>('leaderboard')) ?? [];
board.push({ name: ctx.user.displayName, score: 1200 });
await ctx.kv.set('leaderboard', board.slice(0, 50));
```

### 5. 托管赌约免密结算 `ctx.economy`

若应用获批 `economy.wager.coin` 或 `economy.wager.punch`，云函数可**免签 App Secret** 直接核验并结算本应用创建的托管赌约单（严格禁止跨应用访问）：

```ts
const order = await ctx.economy.getWager(body.orderId);
if (order.status === 'locked') {
  await ctx.economy.settleWager(body.orderId, {
    result: 'win',
    winnerUserId: winnerId,
    summary: '狼人杀好人阵营获胜',
  });
}
```

### 6. 加密环境变量 `ctx.secrets` 与白名单出网 `ctx.fetch`

对于大模型 API Key、第三方 Webhook Token 等敏感密钥，**切勿硬编码进代码**！
应用作者可在服务端接口（`PUT /api/v1/apps/:appId/secrets/:name`）中自助写入，数据在 PostgreSQL 中以 **AES-256-GCM 静态加密**存储，审核队长仅可见变量名不可读取明文：

```ts
export default async function (ctx, body) {
  const apiKey = await ctx.secrets.get('DEEPSEEK_API_KEY');
  if (!apiKey) return { error: '请先在应用密钥中配置 DEEPSEEK_API_KEY' };

  // 仅允许请求 manifest.permissions.networkDomains 中声明的公网 HTTPS 域名
  const resp = await ctx.fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'deepseek-chat', messages: body.messages }),
  });
  return await resp.json();
}
```

---

## 四、流式输出（SSE 打字机）

只需在 `orbit.manifest.json` 中设置 `"allowStreaming": true`，并在云函数中导出 `async function*` 生成器即可自动转为标准 `text/event-stream`：

```ts
// functions/chat.ts
export default async function* (ctx: any, body: { prompt: string }) {
  const chunks = ['你好，', ctx.user.displayName, '！这是来自 Orbit FaaS 的流式响应。'];
  for (const delta of chunks) {
    yield { delta };
  }
}
```

前端沙箱内调用：

```ts
await window.orbitSDK.cloud!.stream<{ delta: string }>(
  'chat',
  { prompt: '你好' },
  (chunk) => {
    appendText(chunk.delta);
  },
);
```

---

## 五、支持 Go / Rust / C++（WebAssembly）

`supabase/edge-runtime` 原生基于 V8 / Deno，内置标准 `WebAssembly.instantiate`。
如果你习惯用 **Go（TinyGo）**、**Rust（wasm-pack）** 或 **C++（Emscripten）** 编写游戏权威判定引擎，只需将编译出的 `.wasm` 放入 `functions/` 目录，并写一个薄 TypeScript 入口加载它即可：

```ts
// functions/judge.ts
const wasmUrl = new URL('./chess_engine.wasm', import.meta.url);
const wasmBytes = await fetch(wasmUrl).then((r) => r.arrayBuffer());
const { instance } = await WebAssembly.instantiate(wasmBytes);

export default async function (_ctx: any, body: { moves: number[] }) {
  const fn = instance.exports.evaluate as (a: number, b: number) => number;
  return { score: fn(body.moves[0] ?? 0, body.moves[1] ?? 0) };
}
```

---

## 六、日志排查与调试

- 云函数内调用 `console.log / warn / error` 会被自动采集（单次最多 32 条），按应用存入最近 200 条环形调用日志；
- 作者与队长可通过 `GET /api/v1/apps/:appId/fn-logs` 查看每次调用的状态码、耗时与控制台日志；
- 未上架的预览版本，作者与队长可在调用 `orbitSDK.cloud.call(fnName, payload, { previewVersionId })` 时指定预览版本 ID 进行线上真机联调。
