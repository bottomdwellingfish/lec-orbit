/**
 * 工坊 SDK v1.3.0 组队邀请与直达进房端到端集成测试：
 * - 真实启动本地 HTTP 测试服务承接 /api/v1/members、/api/v1/apps/presence、/api/v1/apps/:id/invites
 * - 真实运行 MiniAppContainerManager（冷启动进房、热进房零刷新、IPC 成员查询与防伪造邀请、房主回执派发）
 * - 验证 miniAppPreload 在 did-stop-loading 早于页面注册 onRoomJoin 时的冷启动缓冲重放
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContentsViewConstructorOptions } from 'electron';
import { OrbitAppManifestSchema, type MiniAppLaunchRoomContext } from '../src/shared/miniapp';

let nextWcId = 100;
const ipcHandlers = new Map<string, (event: { sender: { id: number; isDestroyed: () => boolean } }, ...args: unknown[]) => unknown>();
const sentMessages: Array<{ wcId: number; channel: string; args: unknown[] }> = [];
const preloadListeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
let exposedOrbitSdk: Record<string, unknown> | null = null;

class FakeWebContents extends EventEmitter {
  readonly id = nextWcId++;
  destroyed = false;
  loadedUrls: string[] = [];

  isDestroyed() {
    return this.destroyed;
  }
  close() {
    this.destroyed = true;
  }
  setWindowOpenHandler() {}
  send(channel: string, ...args: unknown[]) {
    sentMessages.push({ wcId: this.id, channel, args });
  }
  async loadURL(url: string) {
    this.loadedUrls.push(url);
    this.emit('did-start-loading');
    this.emit('did-stop-loading');
  }
}

class FakeWebContentsView {
  readonly webContents = new FakeWebContents();
  visible = false;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  constructor(readonly options: WebContentsViewConstructorOptions) {}
  setVisible(v: boolean) {
    this.visible = v;
  }
  setBounds(b: { x: number; y: number; width: number; height: number }) {
    this.bounds = b;
  }
}

mock.module('electron', () => ({
  app: { getVersion: () => '0.2.4-test' },
  BrowserWindow: class {},
  clipboard: { writeText: () => {} },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  ipcMain: {
    handle: (channel: string, handler: (event: { sender: { id: number; isDestroyed: () => boolean } }, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    },
  },
  ipcRenderer: {
    invoke: mock(async () => null),
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => {
      if (!preloadListeners.has(channel)) preloadListeners.set(channel, new Set());
      preloadListeners.get(channel)!.add(fn);
    },
    removeListener: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => {
      preloadListeners.get(channel)?.delete(fn);
    },
  },
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposedOrbitSdk = api;
    },
  },
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {} },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: () => {},
      protocol: { handle: () => {} },
      webRequest: { onHeadersReceived: () => {} },
    }),
  },
  shell: { openExternal: async () => {} },
  WebContentsView: FakeWebContentsView,
}));

import { ORBIT_ENDPOINTS } from '../src/shared/env';

const prevOrbitApiBase = ORBIT_ENDPOINTS.orbitApiBase;
const receivedInviteRequests: Array<{ appId: string; body: Record<string, unknown>; auth: string | null }> = [];

const mockServer = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/api/v1/members') {
      return Response.json({
        items: [
          { userId: 'u-self', username: 'me', displayName: '我自己', avatar: '', enrollYear: 2024, isCaptain: false },
          { userId: 'u-bob', username: 'bob', displayName: 'Bob', avatar: 'https://a/b.png', enrollYear: 2025, isCaptain: false },
          { userId: 'u-alice', username: 'alice', displayName: 'Alice', avatar: 'https://a/a.png', enrollYear: 2023, isCaptain: true },
        ],
      });
    }
    if (url.pathname === '/api/v1/apps/presence') {
      return Response.json({
        items: [{ userId: 'u-alice', appId: 'lec-chess', appName: '乐程象棋' }],
      });
    }
    const inviteMatch = url.pathname.match(/^\/api\/v1\/apps\/([^/]+)\/invites$/);
    if (inviteMatch && req.method === 'POST') {
      const body = (await req.json()) as Record<string, unknown>;
      receivedInviteRequests.push({
        appId: decodeURIComponent(inviteMatch[1]!),
        body,
        auth: req.headers.get('authorization'),
      });
      return Response.json(
        {
          ok: true,
          appId: decodeURIComponent(inviteMatch[1]!),
          roomId: body.roomId,
          expiresAt: '2026-11-26T20:00:00.000Z',
          sent: [{ userId: 'u-bob', displayName: 'Bob', inviteId: 'inv-live-001' }],
        },
        { status: 201 },
      );
    }
    if (url.pathname.endsWith('/presence') || url.pathname.endsWith('/play-session/end')) {
      return Response.json({ ok: true });
    }
    return new Response('Not Found', { status: 404 });
  },
});
ORBIT_ENDPOINTS.orbitApiBase = `http://127.0.0.1:${mockServer.port}`;

afterAll(() => {
  mockServer.stop(true);
  ORBIT_ENDPOINTS.orbitApiBase = prevOrbitApiBase;
});

const { MiniAppContainerManager } = await import('../electron/miniapp/containerManager');
await import('../electron/miniapp/miniAppPreload');

const sampleManifest = OrbitAppManifestSchema.parse({
  schemaVersion: 1,
  id: 'lec-chess',
  name: '乐程象棋',
  version: '1.0.2',
  type: 'minigame',
  engine: 'web',
  entry: 'index.html',
  window: { defaultMode: 'workspace', supportedModes: ['sidepanel', 'workspace', 'standalone'] },
  permissions: { scopes: ['user.profile', 'storage.cloud'], networkDomains: [] },
});

const roomOne: MiniAppLaunchRoomContext = {
  inviteId: 'inv-cold-1',
  appId: 'lec-chess',
  roomId: 'match-room-101',
  roomName: '快棋 1 号桌',
  mode: 'workspace',
  meta: { side: 'red' },
  inviter: { userId: 'u-alice', username: 'alice', displayName: 'Alice' },
  acceptedAt: '2026-11-26T19:30:00.000Z',
};

const roomTwo: MiniAppLaunchRoomContext = {
  ...roomOne,
  inviteId: 'inv-hot-2',
  roomId: 'match-room-202',
  roomName: '复盘 2 号桌',
};

describe('SDK v1.3.0 组队邀请与冷/热直达进房端到端闭环', () => {
  test('容器冷启动进房 -> SDK 查队友与发邀请 -> 同版本热进房零刷新 -> 房主收实时回执', async () => {
    const children: FakeWebContentsView[] = [];
    const mainWin = {
      isDestroyed: () => false,
      contentView: {
        children,
        addChildView: (v: FakeWebContentsView) => children.push(v),
        removeChildView: (v: FakeWebContentsView) => {
          const i = children.indexOf(v);
          if (i >= 0) children.splice(i, 1);
        },
      },
    } as unknown as BrowserWindow;

    const manager = new MiniAppContainerManager({
      packageManager: {
        findBuiltin: (id: string) =>
          id === 'lec-chess' ? { appId: 'lec-chess', manifest: sampleManifest, dirPath: '/tmp/lec-chess' } : undefined,
        ensureRemoteInstalled: async () => ({
          appId: 'lec-chess',
          version: '1.0.2',
          sha256: 'abc',
          sizeBytes: 123,
          installDir: '/tmp/lec-chess',
          manifest: sampleManifest,
          installedAt: Date.now(),
          lastOpenedAt: Date.now(),
        }),
        getInstalled: () => undefined,
        readLocalDirManifest: () => sampleManifest,
      } as never,
      localDb: {
        getAppPref: () => ({ appId: 'lec-chess' }),
        setAppPref: () => {},
      } as never,
      getScopeKey: () => 'campus:u-self',
      getAuthState: () => ({
        authenticated: true,
        isStudioMember: true,
        isAdmin: false,
        profile: { subject: 'u-self', username: 'me', name: '我自己' },
      }),
      getOrbitApiToken: async () => 'test-jwt-token',
      getMainWindow: () => mainWin,
      showMainWindow: () => {},
      mainPreloadPath: '/tmp/preload.js',
      miniAppPreloadPath: '/tmp/miniAppPreload.js',
      rendererEntry: { htmlPath: '/tmp/index.html' },
      onToastRequested: () => {},
    });

    manager.registerSdkIpcHandlers();
    manager.setWorkspaceBounds({ x: 0, y: 40, width: 960, height: 640 });

    // 1. 冷启动进房
    sentMessages.length = 0;
    const state1 = await manager.launch({ appId: 'lec-chess', mode: 'workspace', launchRoom: roomOne });
    expect(state1.appId).toBe('lec-chess');
    expect(children).toHaveLength(1);
    const wc = children[0]!.webContents;
    expect(wc.loadedUrls).toEqual(['orbit-app://lec-chess/index.html']);

    // did-stop-loading 应自动推送冷启动 roomJoin
    const coldPush = sentMessages.find((m) => m.wcId === wc.id && m.channel === 'orbit:sdk:event:roomJoin');
    expect(coldPush?.args[0]).toEqual(roomOne);

    // 2. 容器主动调用 getLaunchRoom
    const senderEvent = { sender: { id: wc.id, isDestroyed: () => false } };
    const pulled = await ipcHandlers.get('orbit:sdk:multiplayer:getLaunchRoom')!(senderEvent);
    expect(pulled).toEqual(roomOne);

    // 3. 容器拉取工作室成员（过滤自己，且正在玩本游戏的 Alice 自动排第一）
    const members = (await ipcHandlers.get('orbit:sdk:multiplayer:listStudioMembers')!(
      senderEvent,
      {},
    )) as Array<{ userId: string; isPlayingThisApp: boolean }>;
    expect(members.map((m) => m.userId)).toEqual(['u-alice', 'u-bob']);
    expect(members[0]?.isPlayingThisApp).toBe(true);
    expect(members[1]?.isPlayingThisApp).toBe(false);

    // 4. 容器发组队邀请（主进程按 sender.id 绑定真实 appId=lec-chess 并发出真实 HTTP 请求）
    const inviteRes = (await ipcHandlers.get('orbit:sdk:multiplayer:sendRoomInvite')!(senderEvent, {
      toUserIds: ['u-bob'],
      roomId: 'match-room-101',
      roomName: '快棋 1 号桌',
      meta: { round: 2 },
    })) as { ok: boolean; sent: Array<{ inviteId: string }> };
    expect(inviteRes.ok).toBe(true);
    expect(inviteRes.sent[0]?.inviteId).toBe('inv-live-001');
    expect(receivedInviteRequests).toHaveLength(1);
    expect(receivedInviteRequests[0]?.appId).toBe('lec-chess');
    expect(receivedInviteRequests[0]?.auth).toBe('Bearer test-jwt-token');
    expect(receivedInviteRequests[0]?.body.appNameHint).toBe('乐程象棋');

    // 5. 同版本热进房：传入 remoteBundle(v1.0.2) + roomTwo，应复用现有容器且零刷新
    sentMessages.length = 0;
    await manager.launch({
      appId: 'lec-chess',
      mode: 'workspace',
      remoteBundle: {
        version: '1.0.2',
        bundleUrl: 'https://cdn.example/chess.zip',
        bundleSha256: 'abc',
      },
      launchRoom: roomTwo,
    });
    expect(children).toHaveLength(1);
    expect(wc.loadedUrls).toHaveLength(1); // 零刷新！
    const hotPush = sentMessages.find((m) => m.wcId === wc.id && m.channel === 'orbit:sdk:event:roomJoin');
    expect(hotPush?.args[0]).toEqual(roomTwo);
    expect(await ipcHandlers.get('orbit:sdk:multiplayer:getLaunchRoom')!(senderEvent)).toEqual(roomTwo);

    // 6. 房主容器未声明 realtime.room 时也能收到 orbit.invite.responded 实时回执
    sentMessages.length = 0;
    manager.dispatchRealtimeEvent({
      appId: 'lec-chess',
      roomId: 'match-room-101',
      event: 'orbit.invite.responded',
      payload: { inviteId: 'inv-live-001', decision: 'approved', userId: 'u-bob' },
    });
    const rtMsg = sentMessages.find((m) => m.wcId === wc.id && m.channel === 'orbit:sdk:event:realtime');
    expect(rtMsg).toBeDefined();
    expect((rtMsg?.args[0] as { event: string }).event).toBe('orbit.invite.responded');

    manager.close('lec-chess');
  });

  test('miniAppPreload 在页面晚于 did-stop-loading 注册 onRoomJoin 时自动重放冷启动房间上下文', async () => {
    expect(exposedOrbitSdk?.sdkVersion).toBe('1.3.0');
    const mp = exposedOrbitSdk?.multiplayer as {
      onRoomJoin: (cb: (p: MiniAppLaunchRoomContext) => void) => () => void;
    };

    // 模拟主进程在页面脚本尚未挂载监听前就发出 roomJoin
    for (const fn of preloadListeners.get('orbit:sdk:event:roomJoin') ?? []) {
      fn({}, roomOne);
    }

    // 页面异步初始化完成后才注册监听，应自动补发缓冲的 roomOne
    const received: MiniAppLaunchRoomContext[] = [];
    const off = mp.onRoomJoin((p) => received.push(p));
    await Promise.resolve();
    expect(received).toEqual([roomOne]);

    // 后续热进房事件直接实时送达
    for (const fn of preloadListeners.get('orbit:sdk:event:roomJoin') ?? []) {
      fn({}, roomTwo);
    }
    expect(received).toEqual([roomOne, roomTwo]);
    off();
  });
});
