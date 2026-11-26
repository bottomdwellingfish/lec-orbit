# 多人联机指南（Nakama BaaS）

Orbit 平台已在工作室生产集群内置托管了开源游戏后端 **Nakama（v3.26.0）**，并与 **LecSSO 工作室统一账号**完成单点打通。

小游戏开发者**无需自建任何游戏服务端、无需维护服务器或数据库**，即可在 Web / Cocos Creator / Unity / Godot 中直接获得：

- **实时联机房间（Relayed Match）**：好友开黑建房、按房间号加入、毫秒级二进制/JSON 状态帧广播、玩家进出事件；
- **自动匹配（Matchmaker）**：按人数区间与自定义属性（如游戏 ID、段位、模式）自动撮合成局；
- **在线状态与实时聊天（Status / Chat）**：查看在线队友、房间内文字聊天与系统播报；
- **云端对象存储与排行榜（Storage / Leaderboards）**：支持公共/私有数据与赛季榜单。

::: tip 与 `orbitSDK.storage` 如何分工？
- **单机进度 / 个人设置**：直接用 [`window.orbitSDK.storage`](/api/orbit-sdk#storage-零运维托管云存档-kv)，零依赖、一行代码即可读写。
- **多人实时对战 / 房间匹配 / 排行榜 / 跨玩家共享数据**：使用本页介绍的 **Nakama BaaS**。
:::

---

## 架构与安全机制（前端零密钥）

为了防止游戏前端泄露 Nakama 私有 `Server Key`，Orbit 采用 **服务端单点换票** 模式：

1. 游戏调用 `window.orbitSDK.multiplayer.getNakamaSession()`；
2. Orbit 桌面主进程携带当前用户的 LecSSO 凭证请求 `POST https://orbit.lecspace.top/api/v1/nakama/session`；
3. `lec-orbit-server` 校验成员身份后，在集群内网以私有密钥为该成员签发（或复用）绑定 `custom_id = lec:<orbitUserId>` 的 **短期 Nakama JWT**，并自动同步工作室昵称与头像；
4. 游戏拿到 `{ host, port, useSSL, token, refreshToken }` 后，直接使用官方 Nakama SDK 连接公网 **`orbit.lecspace.top:443`**（HTTPS `/v2/*` 与 WebSocket `wss://orbit.lecspace.top/ws`）。

---

## 第一步：配置 `orbit.manifest.json` 域名白名单

Orbit 工坊容器启用了严格的 CSP（内容安全策略），使用 Nakama 联机前，**必须**在 `orbit.manifest.json` 的 `permissions.networkDomains` 中登记 `"orbit.lecspace.top"`：

```json
{
  "schemaVersion": 1,
  "id": "lec-tank-arena",
  "name": "坦克大乱斗",
  "version": "1.0.0",
  "type": "minigame",
  "engine": "web",
  "entry": "index.html",
  "permissions": {
    "scopes": ["user.profile", "storage.cloud"],
    "networkDomains": ["orbit.lecspace.top"]
  }
}
```

::: warning 切勿遗漏 `networkDomains`
如果忘记填写 `"orbit.lecspace.top"`，浏览器会在建立 `wss://orbit.lecspace.top/ws` 或请求 `https://orbit.lecspace.top/v2/...` 时抛出 `Refused to connect` CSP 拦截错误。
:::

---

## 第二步：Web / React / Vue / Cocos 快速接入

### 1. 安装官方客户端 SDK

```sh
npm install @heroiclabs/nakama-js
# 或 bun add @heroiclabs/nakama-js / pnpm add @heroiclabs/nakama-js
```

### 2. 换取 Session 并建立实时连接

```ts
import { Client, Session } from '@heroiclabs/nakama-js';
import { getOrbitSDK } from './orbit-sdk'; // 复制自 apps/lec-orbit/sdk/orbit-sdk.ts

export async function connectNakama() {
  const sdk = getOrbitSDK();
  if (!sdk.multiplayer) {
    throw new Error('当前 Orbit 客户端版本过低，请升级至最新版本');
  }

  // 1. 通过 Orbit SSO 一键换取当前工作室成员的 Nakama Session（免密、免登录页）
  const nk = await sdk.multiplayer.getNakamaSession();

  // 2. 初始化官方 Client 并恢复 Session（无需填写 serverKey，留空即可）
  const client = new Client('', nk.host, String(nk.port), nk.useSSL);
  const session = Session.restore(nk.token, nk.refreshToken);

  // 3. 建立实时 WebSocket 长连接
  const socket = client.createSocket(nk.useSSL, false);
  await socket.connect(session, true);

  return { client, session, socket, profile: nk };
}
```

### 3. 好友开黑：建房、加房与实时广播状态帧

**Relayed Match（中继房间）** 最适合派对游戏、桌游、双人/多人合作与轻度动作对战：房主建房后把 `match_id` 发给队友，房间内任意玩家发送的状态帧会自动广播给同房其他人。

```ts
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// 自定义消息操作码（opCode 为整数，按游戏协议自由约定）
const OP_PLAYER_MOVE = 1;
const OP_GAME_EVENT = 2;

const { socket } = await connectNakama();

// 监听同房其他玩家发来的实时状态帧
socket.onmatchdata = (matchData) => {
  const sender = matchData.presence?.username ?? 'unknown';
  const payload = JSON.parse(decoder.decode(matchData.data));
  if (matchData.op_code === OP_PLAYER_MOVE) {
    console.log(`[移动] ${sender}:`, payload.x, payload.y);
  }
};

// 监听玩家进出房间事件
socket.onmatchpresence = (event) => {
  for (const joined of event.joins ?? []) {
    console.log('玩家加入房间:', joined.username);
  }
  for (const left of event.leaves ?? []) {
    console.log('玩家离开房间:', left.username);
  }
};

// 房主创建房间（可把 match.match_id 复制给队友）
const match = await socket.createMatch();
console.log('房间号:', match.match_id);

// 队友按房间号加入：
// const match = await socket.joinMatch(roomIdFromHost);

// 向同房所有其他玩家广播一条状态帧
await socket.sendMatchState(
  match.match_id,
  OP_PLAYER_MOVE,
  encoder.encode(JSON.stringify({ x: 320, y: 180, facing: 'right' })),
);
```

### 4. 自动匹配（Matchmaker）

想做「点击开始匹配 → 凑齐 2~4 人自动开局」时，务必在 `stringProperties` 中带上你的**应用唯一 `app` 标识**，避免不同工坊小游戏的玩家互相匹配到一起：

```ts
const APP_ID = 'lec-tank-arena'; // 与 orbit.manifest.json 的 id 保持一致

socket.onmatchmakermatched = async (matched) => {
  // 匹配成功后，用系统下发的 token 进入同一房间
  const match = await socket.joinMatch(undefined, matched.token);
  console.log('匹配成功！已进入房间:', match.match_id, '玩家列表:', match.presences);
};

// 加入匹配池：只匹配同一款游戏（+properties.app:lec-tank-arena），2~4 人即开局
const ticket = await socket.addMatchmaker(
  `+properties.app:${APP_ID}`,
  2,
  4,
  { app: APP_ID },
);

// 取消匹配时调用：
// await socket.removeMatchmaker(ticket.ticket);
```

### 5. 云端对象存储（跨玩家共享 / 扩展存档）

Nakama Storage 支持细粒度的读写权限控制（`permission_read`: `0` 禁止 / `1` 仅本人 / `2` 公开可读），适合保存关卡分享、战绩回放或玩家资料：

```ts
// 写入一条公开可读的数据（collection 建议以你的 appId 为前缀做命名隔离）
await client.writeStorageObjects(session, [
  {
    collection: `${APP_ID}_profiles`,
    key: 'loadout',
    value: { skin: 'cyber-cat', wins: 12 },
    permission_read: 2,  // 其他玩家可见
    permission_write: 1, // 仅本人可写
  },
]);

// 读取自己或他人公开数据
const res = await client.readStorageObjects(session, {
  object_ids: [
    { collection: `${APP_ID}_profiles`, key: 'loadout', user_id: session.user_id },
  ],
});
console.log('读取结果:', res.objects?.[0]?.value);
```

---

## 第三步：Unity 与 Godot 接入建议

Nakama 官方提供全引擎客户端 SDK，在 Orbit WebGL 容器中接入同样非常直接：

- **Unity WebGL**：安装官方 [Nakama Unity SDK](https://heroiclabs.com/docs/nakama/client-libraries/unity/)（支持 WebGL 的 `UnityWebRequestAdapter` 与 `WebSocketAdapter`）。在 `.jslib` 中调用 `window.orbitSDK.multiplayer.getNakamaSession()` 把返回的 JSON 传回 C#，随后用 `Session.Restore(token, refreshToken)` 与 `new Client("https", host, int.Parse(port), "")` 连接即可。
- **Godot 4 Web**：安装官方 [nakama-godot](https://github.com/heroiclabs/nakama-godot) 插件。通过 `JavaScriptBridge.eval`（或扩展 `OrbitBridge.gd`）调用 `window.orbitSDK.multiplayer.getNakamaSession()` 拿到 `host / port / token / refreshToken`，使用 `Nakama.create_client("", host, int(port), "https")` 与 `NakamaSession.new(token, false, refresh_token)` 恢复会话并连接 Socket。

---

## 命名空间隔离与最佳实践

由于全工作室的工坊小游戏共用同一套 Nakama 集群，强烈建议遵循以下约定，避免多款游戏之间数据串扰：

1. **Matchmaker 查询必须按游戏隔离**：始终携带 `+properties.app:<你的 manifest id>`。
2. **Storage Collection 加前缀**：使用 `<manifest id>_<业务名>`（例如 `lec_tank_replays`），不要直接用 `save`、`profile` 这类通用名称。
3. **房间聊天频道加前缀**：`joinChat(\`${APP_ID}:${roomId}\`, 1)`。
4. **会话自动续期**：若单次游戏游玩时间较长（超过 1 小时）遇到 `401` / 断线，只需重新调用一次 `await sdk.multiplayer.getNakamaSession()` 即可无缝换取新 JWT 并重连 Socket。
5. **本地调试说明**：`getNakamaSession()` 依赖 Orbit 桌面主进程的 LecSSO 登录态，在普通 Chrome 独立预览时会抛出提示；请使用 Orbit **「工坊 → 本地调试 → Localhost 热重载 / 本地构建目录」** 进行联机联调，可开多台电脑或多人同时联机测试。

---

## 公网接入参数速查

| 项目 | 值 | 说明 |
| --- | --- | --- |
| 公网主机（`host`） | `orbit.lecspace.top` | 由 `getNakamaSession()` 动态下发，建议不要硬编码 |
| 端口（`port`） | `443` | 复用 HTTPS / WSS 标准端口 |
| 启用 TLS（`useSSL`） | `true` | 全链路加密传输 |
| HTTP API 前缀 | `/v2/*` | 官方 Nakama REST/gRPC Gateway |
| 实时长连接路径 | `/ws` | 官方 Nakama WebSocket 端点 |
| 换票接口（Orbit 内部） | `POST /api/v1/nakama/session` | 已封装为 `window.orbitSDK.multiplayer.getNakamaSession()` |
