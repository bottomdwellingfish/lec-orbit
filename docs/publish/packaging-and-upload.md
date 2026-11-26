# 打包、上传与审核发布

Orbit 工坊目前**仅限 `lec-studio` 组织内部成员使用**。所有作品在客户端首次打开时下载、校验 SHA256 并持久化缓存到本地磁盘，**二次打开 0 流量秒开**。

## 1. 打包规范（`.zip` / `.lecapp`）

将构建输出目录打包为标准 ZIP 文件（扩展名 `.zip` 或 `.lecapp` 均可）。

### 目录结构要求
- 压缩包根目录需包含 `orbit.manifest.json` 与声明的 `entry` 入口文件（如 `index.html`）；
- **若使用 Orbit 托管云函数（FaaS）**：将 `functions/` 目录一并打包在压缩包根目录，并确保 `orbit.manifest.json` 已声明 `permissions.scopes: ["cloud.functions"]` 与 `functions.routes`。上传时服务端会自动提取源码与 `.wasm` 产物，并在过审后随版本自动上线；
- **贴心兼容**：如果你在 macOS Finder 或 Windows 资源管理器中直接「右键压缩文件夹」产生了单层包装目录（例如 `my-app/orbit.manifest.json`），Orbit 客户端与服务端都会**自动识别并剥离单层目录**，不会报错；
- 系统会自动忽略 `__MACOSX/` 与 `.DS_Store` 噪声文件。

### 安全红线（触发即被拦截）
- 禁止包含 `../` 路径穿越或绝对路径；
- 禁止包含符号链接（Symlink）；
- 压缩包内文件总数不超过 **5,000** 个；
- 解压后总体积不超过 **250 MB**（RustFS 直传渠道）或 **800 MB**（GitHub Releases 大包渠道）；
- **云函数静态安全扫描红线**：`functions/` 最多 32 个文件、总原始体积 ≤ 5 MB、仅允许 `.ts / .js / .mjs / .json / .wasm`；严禁调用 `Deno.Command`、`Deno.run`、宿主机文件读写、`Deno.env`、`process.env`、`eval`、`new Function` 或危险 Node 系统模块。

### 推荐命令行打包方式

::: code-group

```sh [普通前端 / Cocos / Godot]
cd dist/
zip -r ../my-app-v1.0.0.zip . -x "*.DS_Store" "__MACOSX/*"
```

```sh [Unity WebGL（已含 .br / .gz，建议 -0 免二次压缩）]
cd UnityWebGLBuild/
zip -r -0 ../my-unity-game-v1.0.0.zip . -x "*.DS_Store" "__MACOSX/*"
```

:::

---

## 2. 两种上传与分发通道

### 通道 A：直接上传 ZIP（≤ 100 MB，推荐默认）

适合所有小程序与中小型游戏：

1. 打开 Orbit →「工坊」→ 右上角 **「上传 / 导入」**；
2. 切到 **「上传 ZIP / .lecapp（≤ 100MB）」**，点击「选择构建包」——客户端会立即离线预检 `orbit.manifest.json`、版本与体积；
3. 选择发布通道：
   - **仅体验版（`preview`）**：仅作者本人和队长可见，适合先验证线上云存档与下载链路；
   - **提交正式上架（`release`）**：上传后自动向队长推送 Orbit 审核通知；
4. 填写本次更新日志，点击 **「校验并上传」**，构建包将直传至校园统一 RustFS。

### 超大包体（> 100MB）：GitHub Releases 导入

考虑到校园生产服务器经过公网 FRP 隧道转发，为避免大型 3D 作品（例如 150~400MB 的 Unity/Godot 游戏）打满校园出口带宽，超过 100MB 的作品请走 **GitHub Releases 导入**：

1. 将打包好的 `.zip` 上传到你的 GitHub 仓库 Release 资产中，复制下载直链（格式如 `https://github.com/<org>/<repo>/releases/download/v1.0.0/game.zip`）；
2. 在终端计算该 ZIP 的 64 位 SHA256 校验值：

   ::: code-group
   ```sh [macOS / Linux]
   shasum -a 256 game.zip
   ```
   ```powershell [Windows PowerShell]
   Get-FileHash .\game.zip -Algorithm SHA256
   ```
   :::

3. 打开 Orbit →「工坊」→「上传 / 导入」→ 切到 **「GitHub Releases 导入（大包）」**；
4. 依次填入 **Release ZIP 直链**、**64 位 SHA256**、以及粘贴对应的 **`orbit.manifest.json`** 内容，提交即可！
5. 其他成员打开时，Orbit 会直连 GitHub Releases CDN 拉取并按 SHA256 严格验签后缓存到本地，**完全不走校园服务器带宽**。

---

## 3. 版本审核与更新治理

```text
上传/导入 ──▶ 体验版 (preview) ──▶ 提交正式上架 (pending) ──▶ 队长审核通过 (published)
                                          │
                                          └──▶ 驳回 (rejected) ──▶ 修改后重传新版本
```

- **归属权保护**：应用 `id` 首次创建后自动绑定作者账号，其他人不能覆盖你的 `id`（队长拥有兜底管理权限）。
- **队长审核**：在「工坊 → 待审核」点击「打开」试玩卡片上的待审版本；若该版本包含托管云函数，可点击 **「审云函数源码」** 完整审阅 `functions/` 源码与路由声明（但看不到作者加密 Secrets 的明文），确认无误后批准或驳回。审核结果会推送给作者。已上架作品的公开卡片沿用当前版本的资料，批准新版时同步切换。早于获批版本的待审提交随即失效。
- **作者云函数运维**：在「工坊 → 我的作品」点击 **「云函数管理」**，可随时可视化配置 AES-256-GCM 加密环境变量（Secrets）、查看最近调用日志与 `console` 输出，并核对当前版本的函数源码。
- **作者撤回送审**：在「工坊 → 我的作品」撤回待审的正式版本后，成员仍可使用已经上架的版本。
- **作者下架作品**：在「我的作品」下架已发布作品时，待审正式版本会一并撤回。历史版本和云存档仍会保留。
- **重新送审或更新**：撤回或下架后，点「重新送审」可将原包交给队长重新审核。若 ZIP 有改动，保留 `orbit.manifest.json` 中的 `id`，建议提高 `version` 后重新打包，再点该作品的「上传新版本」。工坊仍显示同一件作品，队长批准后新包成为公开版本。
- **静默缓存与版本升级**：成员再次打开作品时，Orbit 会在版本号或 SHA256 变化后自动下载新包。版本号和 SHA256 都匹配时直接复用本地缓存。
- **本地空间清理**：成员随时可在工坊顶部点击 **「清缓存」** 一键释放所有已下载的离线包空间。
