# `window.orbitSDK` API 参考

在 Orbit 工坊容器内运行时，沙箱 Preload 会自动向全局注入只读对象 `window.orbitSDK`（当前版本 `1.3.0`）。
如果你使用 TypeScript 或需要在普通浏览器中也能无报错预览，推荐直接引入 `apps/lec-orbit/sdk/orbit-sdk.ts` 的 `getOrbitSDK()`，它会在非 Orbit 环境下自动降级到 `localStorage` 与模拟用户。

## 基础属性

```ts
window.orbitSDK.sdkVersion // '1.3.0'
window.orbitSDK.isOrbit    // true（浏览器降级封装中为 false）
```

---

## `env` — 运行环境与主题/形态事件

### `env.getInfo()`
返回当前容器的完整运行时上下文。

```ts
const info = await window.orbitSDK.env.getInfo();
```

返回值类型 `OrbitEnvInfo`：

```ts
interface OrbitEnvInfo {
  appId: string;
  name: string;
  version: string;
  mode: 'sidepanel' | 'workspace' | 'standalone';
  platform: 'darwin' | 'win32' | 'linux' | string;
  theme: 'light' | 'dark';
  crossOriginIsolated: boolean;
  orbitVersion: string;
}
```

### `env.getTheme()`
获取当前解析后的有效外观主题（`'light' | 'dark'`）。

### `env.onThemeChange(listener)`
监听 Orbit 外观切换（含系统跟随深浅色变化），返回取消订阅函数：

```ts
const off = window.orbitSDK.env.onThemeChange((theme) => {
  document.documentElement.dataset.theme = theme;
});
// 组件卸载时调用 off()
```

### `env.onModeChange(listener)`
监听用户在「右侧伴随栏 / 主区全幅 / 独立窗口」之间无损切换，返回取消订阅函数：

```ts
const off = window.orbitSDK.env.onModeChange((mode) => {
  console.log('已无损切换至：', mode);
});
```

---

## `user` — 当前成员信息

> 需在 `orbit.manifest.json` 的 `permissions.scopes` 中声明 `"user.profile"`。

### `user.getCurrent()`
获取当前已登录 LecSSO 成员的脱敏档案（未登录时返回 `null`）：

```ts
interface OrbitUserProfile {
  userId: string;      // LecSSO 唯一主体 ID（适合作为业务主键）
  username?: string;   // 账号 Handle
  displayName: string; // 工作室统一展示名
  avatar?: string;     // 头像 URL
  isAdmin: boolean;    // 是否为工作室队长
}

const user = await window.orbitSDK.user.getCurrent();
```

::: warning 安全约束
`user.getCurrent()` 仅返回展示所需的脱敏字段，**绝不暴露** LecSSO Refresh Token 或主应用 Access Token。
:::

---

## `storage` — 零运维托管云存档（KV）

> 需在 `orbit.manifest.json` 的 `permissions.scopes` 中声明 `"storage.cloud"`。

每个应用在每个成员账号下拥有独立的键值存储空间：
- **线上已上架应用**：自动同步至 `lec-orbit-server`（PostgreSQL）并在本地 SQLite 缓存，换电脑登录自动漫游；断网时自动降级读写本地缓存。
- **本地调试 / 内置示例**：直接持久化到 Orbit 本地 SQLite（`mini_app_kv_cache`），开发联调零配置。
- **容量配额**：单条记录序列化后上限 **64 KB**；单应用单人总配额 **1 MB**。键名长度 `1~128` 字符。

### 方法列表

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `storage.get` | `<T = unknown>(key: string) => Promise<T \| null>` | 读取指定键对应的 JSON 值，不存在返回 `null` |
| `storage.set` | `(key: string, value: unknown) => Promise<void>` | 写入任意可 JSON 序列化的值（覆盖更新） |
| `storage.remove` | `(key: string) => Promise<void>` | 删除指定键 |
| `storage.keys` | `() => Promise<string[]>` | 列出当前用户在本应用下的全部已存键名（升序） |

### 示例

```ts
await window.orbitSDK.storage.set('save-slot-1', {
  stage: 4,
  hp: 85,
  inventory: ['shield', 'potion'],
});

const slot = await window.orbitSDK.storage.get<{ stage: number; hp: number }>('save-slot-1');
const allKeys = await window.orbitSDK.storage.keys();
await window.orbitSDK.storage.remove('save-slot-1');
```

---

## `ui` — 宿主界面交互

### `ui.toast(message, tone?)`
触发一条 Orbit 主壳原生的液态玻璃提示（自动避让右侧伴随栏）：

```ts
await window.orbitSDK.ui.toast('关卡数据已保存', 'success');
// tone 可选：'info' | 'success' | 'warning' | 'error'，默认 'info'
```

### `ui.requestMode(mode)`
主动请求宿主将当前容器切换至指定形态（仅当目标形态在 `manifest.window.supportedModes` 内时生效，返回 `boolean`）：

```ts
const ok = await window.orbitSDK.ui.requestMode('standalone');
```

---

## `clipboard` — 系统剪贴板

> 需在 `orbit.manifest.json` 的 `permissions.scopes` 中声明 `"clipboard"`。

### `clipboard.writeText(text)`
将纯文本写入系统剪贴板（单次上限 `50,000` 字符）：

```ts
await window.orbitSDK.clipboard.writeText(formattedJson);
await window.orbitSDK.ui.toast('已复制到剪贴板', 'success');
```

---

## `lifecycle` — 窗口生命周期事件

### `lifecycle.onPause(listener)` / `lifecycle.onResume(listener)`
独立窗口最小化或恢复时触发，适合暂停游戏渲染循环与背景音乐：

```ts
const offPause = window.orbitSDK.lifecycle.onPause(() => pauseGame());
const offResume = window.orbitSDK.lifecycle.onResume(() => resumeGame());
```

---

## `multiplayer` — 内置多人联机 BaaS（Nakama）

Orbit 已内置托管 **Nakama 3.26.0** 联机后端并与工作室 LecSSO 打通，小游戏无需自建服务端即可拥有实时房间、自动匹配、排行榜、聊天与云端对象存储。

> 在连接 Nakama 前，请在 `orbit.manifest.json` 的 `permissions.networkDomains` 中添加 `"orbit.lecspace.top"`。完整建房与匹配实战教程见 [多人联机指南（Nakama BaaS）](/guide/multiplayer)。

### `multiplayer.getNakamaSession()`
通过 Orbit 后端单点换票，获取当前已登录工作室成员对应的 Nakama 短期会话凭证（前端零 Server Key）：

```ts
interface OrbitNakamaSession {
  host: string;         // 例如 "orbit.lecspace.top"
  port: string;         // 例如 "443"
  useSSL: boolean;      // true
  token: string;        // Nakama JWT 访问令牌
  refreshToken: string; // Nakama Refresh Token
  userId: string;       // Nakama 内部用户 UUID
  orbitUserId: string;  // 对应的 LecSSO / Orbit 用户 ID
  username: string;     // Nakama 用户名
  displayName: string;  // 工作室展示昵称（自动同步）
  expiresAt: number;    // 令牌过期毫秒时间戳
  created: boolean;     // 是否为该成员首次创建 Nakama 账号
}

const nk = await window.orbitSDK.multiplayer!.getNakamaSession();
```

配合官方 `@heroiclabs/nakama-js` 即可直接连接：

```ts
import { Client, Session } from '@heroiclabs/nakama-js';

const nk = await window.orbitSDK.multiplayer!.getNakamaSession();
const client = new Client('', nk.host, String(nk.port), nk.useSSL);
const session = Session.restore(nk.token, nk.refreshToken);
const socket = client.createSocket(nk.useSSL, false);
await socket.connect(session, true);
```

### `multiplayer.listStudioMembers(options?)`（v1.3.0+）
拉取当前可邀请组队的工作室活跃成员列表（自动标注谁正在玩本游戏或工坊其他作品，按在玩优先 + 届别降序排序；默认过滤掉自己，传入 `{ includeSelf: true }` 可包含本人）。需声明 `"user.profile"` 权限：

```ts
interface OrbitStudioMember {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  enrollYear: number | null;
  isCaptain: boolean;
  isPlayingThisApp: boolean;
  playingAppName: string | null;
  isSelf: boolean;
}

const teammates = await window.orbitSDK.multiplayer!.listStudioMembers!();
```

### `multiplayer.sendRoomInvite(input)`（v1.3.0+）
向工作室同学发送实时组队邀请（支持一次邀请 `1~8` 人，10 分钟内限发 15 人次防骚扰）。应用 ID 由主进程根据容器身份强绑定，无法伪造：

```ts
const res = await window.orbitSDK.multiplayer!.sendRoomInvite!({
  toUserIds: ['teammate-user-id'],
  roomId: match.match_id,
  roomName: '快棋 1 号桌',
  message: '来一把 5 分钟快棋！',
  mode: 'standalone',     // 可选：对方点接受时优先以此形态打开
  expiresInSeconds: 600,  // 可选：60~3600 秒，默认 600 秒
  meta: { side: 'black' }, // 可选：任意业务元数据，对方进房时原样带回
});
```

受邀同学的 Orbit 客户端会立即弹出**实时通知 Toast** 并在**通知中心**生成可操作卡片；点击**「接受并进房」**后：
1. 若对方尚未下载本作品，Orbit 自动下载并安装最新线上版本；
2. 若作品未启动，冷启动打开并通过 `getLaunchRoom()` 与 `onRoomJoin()` 传入房间上下文；
3. 若作品已在运行同版本，直接聚焦窗口并通过 `onRoomJoin()` 实时热进房（零刷新）；
4. 同时向房主推送 `orbit.invite.responded` 实时事件（可通过 `window.orbitSDK.realtime.onMessage` 接收）。

### `multiplayer.getLaunchRoom()` 与 `multiplayer.onRoomJoin(listener)`（v1.3.0+）
接收「接受并进房」带来的目标房间上下文：

```ts
interface OrbitRoomJoinPayload {
  inviteId: string;
  appId: string;
  roomId: string;
  roomName?: string;
  mode?: 'sidepanel' | 'workspace' | 'standalone';
  message?: string;
  meta?: Record<string, unknown>;
  inviter: {
    userId: string;
    username?: string;
    displayName: string;
    avatar?: string;
  };
  acceptedAt: string;
}

const handledInvites = new Set<string>();
async function handleRoomJoin(payload: OrbitRoomJoinPayload) {
  if (handledInvites.has(payload.inviteId)) return;
  handledInvites.add(payload.inviteId);
  await joinRoomById(payload.roomId, payload.meta);
}

// 1. 冷启动时主动拉取（防止页面异步初始化晚于容器 did-stop-loading）
const initialRoom = await window.orbitSDK.multiplayer?.getLaunchRoom?.();
if (initialRoom) {
  void handleRoomJoin(initialRoom);
}

// 2. 监听热进房（应用已开着时再次接受新邀请）
const offJoin = window.orbitSDK.multiplayer?.onRoomJoin?.((payload) => {
  void handleRoomJoin(payload);
});
```

---

## `economy` — 通用乐币与受控对赌 / 打赏

> 需按需在 `orbit.manifest.json` 的 `permissions.scopes` 中声明 `economy.read`、`economy.wager.coin`、`economy.wager.punch` 或 `economy.tip`。涉及扣款与结算的操作均由 Orbit 桌面主进程弹出原生二次确认框并由服务端强校验限额。

### 方法列表

| 方法 | 所需 Scope | 说明 |
| --- | --- | --- |
| `economy.getWallet()` | `economy.read`（或任意 `economy.*`） | 查询当前成员乐币余额、冻结金额、本周打卡时长及剩余额度 |
| `economy.wager.create(input)` | `economy.wager.coin` / `economy.wager.punch` | 发起托管对赌单（支持 `'coin'` 乐币或 `'punch_minutes'` 本周打卡分钟） |
| `economy.wager.accept(orderId)` | `economy.wager.coin` / `economy.wager.punch` | 接受对手发起的对赌单并锁定双方担保资产 |
| `economy.wager.cancel(orderId)` | `economy.wager.coin` / `economy.wager.punch` | 取消尚未被接受的待确认对赌单 |
| `economy.wager.get(orderId)` | `economy.read` / `economy.wager.*` | 查询单笔对赌单当前状态与结果 |
| `economy.tip(input)` | `economy.tip` | 向指定工作室成员发起点对点乐币打赏 |

```ts
const wallet = await window.orbitSDK.economy!.getWallet();
console.log('当前可用乐币:', wallet.coinBalance, '本周可交易打卡分钟:', wallet.weeklyTradeMinutes);
```

---

## `cloud` — 托管云函数调用（Orbit FaaS）

> 需在 `orbit.manifest.json` 中声明 `permissions.scopes: ["cloud.functions"]` 与 `functions` 配置块。完整指南见 [托管云函数（Orbit FaaS）](/guide/cloud-functions)。

### `cloud.call(fnName, payload?, options?)`
调用当前应用随包部署的云函数路由并返回结果：

```ts
const res = await window.orbitSDK.cloud!.call<{ ok: boolean; roomId: string }>('deal', {
  roomId: 'room-01',
});
```

### `cloud.stream(fnName, payload, onChunk, options?)`
调用启用了 `allowStreaming: true` 的 SSE 流式云函数，逐片触发 `onChunk` 回调：

```ts
await window.orbitSDK.cloud!.stream<{ delta: string }>(
  'chat',
  { prompt: '帮我总结今日打卡数据' },
  (chunk) => console.log('收到分片:', chunk.delta),
);
```

> 调试未上架的预览版本时，作者或队长可在 `options` 中传入 `{ previewVersionId }`。

---

## `realtime` — 房间实时消息通道

> 需在 `orbit.manifest.json` 的 `permissions.scopes` 中声明 `"realtime.room"`。底层直接复用 Orbit 主通道 `/api/v1/ws`，免自建 WebSocket。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `realtime.joinRoom` | `(roomId: string) => Promise<{ ok: boolean; appId: string; roomId: string }>` | 加入房间，开始接收云函数 `ctx.realtime.broadcastRoom` 广播 |
| `realtime.leaveRoom` | `(roomId: string) => Promise<{ ok: boolean; appId: string; roomId: string }>` | 离开房间 |
| `realtime.onMessage` | `(listener: (msg: OrbitRealtimeMessage) => void) => () => void` | 监听点对点推送（如发暗牌）或房间广播，返回取消订阅函数 |

```ts
await window.orbitSDK.realtime!.joinRoom('room-01');
const off = window.orbitSDK.realtime!.onMessage((msg) => {
  console.log(`[${msg.roomId ?? '私信'}] ${msg.event}`, msg.payload);
});
```
