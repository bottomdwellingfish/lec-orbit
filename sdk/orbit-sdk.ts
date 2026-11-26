/**
 * @lec-space/orbit-sdk（v1.3.0）
 * 面向 Orbit 工坊小程序（React/Vue/Vanilla）与 Cocos Creator 3.x 的标准 TypeScript SDK。
 * 在 Orbit 容器外（例如普通浏览器预览）自动提供本地 localStorage 降级实现。
 */

export type OrbitTheme = 'light' | 'dark';
export type OrbitDisplayMode = 'sidepanel' | 'workspace' | 'standalone';
export type OrbitEconomyAsset = 'coin' | 'punch_minutes';

export interface OrbitWalletSummary {
  coinBalance: number;
  frozenCoins: number;
  lifetimeEarnedCoins: number;
  weeklyRecordedMinutes: number;
  weeklyTradeMinutes: number;
  punchAffectsAssessment: boolean;
  quotas: {
    maxCoinPerOrder: number;
    maxPunchPerOrder: number;
    dailyCoinRemaining: number;
    weeklyCoinGainRemaining: number;
    weeklyPunchGainRemaining: number;
    weeklyPunchLossRemaining: number;
    activeOrdersCount: number;
    maxActiveOrders: number;
  };
}

export interface OrbitWagerCreateInput {
  asset: OrbitEconomyAsset;
  amount: number;
  matchId: string;
  opponentUserId?: string;
  title: string;
  acceptTimeoutSeconds?: number;
}

export interface OrbitTipInput {
  toUserId: string;
  amount: number;
  note: string;
}

export interface OrbitOrderTicket {
  orderId: string;
  appId: string;
  orderType: string;
  matchId: string;
  title: string;
  asset: OrbitEconomyAsset;
  amount: number;
  weekKey: string;
  status: 'pending_accept' | 'locked' | 'disputed' | 'settled' | 'refunded' | 'cancelled' | 'expired';
  creatorUserId: string;
  opponentUserId?: string;
  winnerUserId?: string;
  loserUserId?: string;
  summary?: string;
  acceptExpiresAt: number;
  settleExpiresAt?: number;
  settledAt?: number;
  createdAt: number;
}

export interface OrbitEconomyAPI {
  readonly isNative?: boolean;
  getWallet: () => Promise<OrbitWalletSummary>;
  wager: {
    create: (input: OrbitWagerCreateInput) => Promise<OrbitOrderTicket>;
    accept: (orderId: string) => Promise<OrbitOrderTicket>;
    cancel: (orderId: string) => Promise<void>;
    get: (orderId: string) => Promise<OrbitOrderTicket>;
  };
  tip: (input: OrbitTipInput) => Promise<OrbitOrderTicket>;
}

export interface OrbitNakamaSession {
  host: string;
  port: string;
  useSSL: boolean;
  token: string;
  refreshToken: string;
  userId: string;
  orbitUserId: string;
  username: string;
  displayName: string;
  expiresAt: number;
  created: boolean;
}

export interface OrbitStudioMember {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  enrollYear: number | null;
  isCaptain: boolean;
  /** 该同学此刻是否正在玩本游戏/本应用。 */
  isPlayingThisApp: boolean;
  /** 若该同学此刻正在玩其他工坊作品，返回作品名称，否则为 null。 */
  playingAppName: string | null;
  isSelf: boolean;
}

export interface OrbitRoomInviteInput {
  /** 受邀工作室成员的 userId 列表（来自 listStudioMembers），单次 1~8 人。 */
  toUserIds: string[];
  /** 房间唯一标识（例如 Nakama match_id 或自定义房号）。 */
  roomId: string;
  /** 可选房间展示名称（如「快棋 1 号桌」）。 */
  roomName?: string;
  /** 可选自定义邀请附言（最长 140 字）。 */
  message?: string;
  /** 对方点击接受后优先以何种容器形态打开（默认沿用应用默认形态）。 */
  mode?: OrbitDisplayMode;
  /** 邀请有效期秒数（60~3600 秒，默认 600 秒）。 */
  expiresInSeconds?: number;
  /** 可选业务透传元数据（如地图、模式、密码等），接受进房时原样带回。 */
  meta?: Record<string, unknown>;
}

export interface OrbitRoomInviteResult {
  ok: true;
  appId: string;
  roomId: string;
  expiresAt: string;
  sent: Array<{ userId: string; displayName: string; inviteId: string }>;
}

export interface OrbitRoomJoinPayload {
  inviteId: string;
  appId: string;
  roomId: string;
  roomName?: string;
  mode?: OrbitDisplayMode;
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

export interface OrbitMultiplayerAPI {
  /** 获取绑定当前工作室成员身份的 Nakama 联机会话（免前端管理 Server Key）。 */
  getNakamaSession: () => Promise<OrbitNakamaSession>;
  /** 获取可邀请组队的工作室活跃成员列表（自动按在玩状态与届别排序）。 */
  listStudioMembers?: (options?: { includeSelf?: boolean }) => Promise<OrbitStudioMember[]>;
  /** 向工作室同学发送实时组队邀请，对方点击「接受并进房」即直达对应房间。 */
  sendRoomInvite?: (input: OrbitRoomInviteInput) => Promise<OrbitRoomInviteResult>;
  /** 获取冷启动时携带的直达房间上下文（无邀请直达则返回 null）。 */
  getLaunchRoom?: () => Promise<OrbitRoomJoinPayload | null>;
  /** 监听热进房或加载完成后的组队直达房间事件，返回取消订阅函数。 */
  onRoomJoin?: (listener: (payload: OrbitRoomJoinPayload) => void) => () => void;
}

export interface OrbitCloudCallOptions {
  /** 仅作者与队长调试未上架版本时可指定预览版本 ID。 */
  previewVersionId?: string;
}

export interface OrbitCloudAPI {
  /** 调用本应用随包部署的 Orbit 托管云函数（需声明 cloud.functions 权限）。 */
  call: <T = unknown>(
    fnName: string,
    payload?: unknown,
    options?: OrbitCloudCallOptions,
  ) => Promise<T>;
  /** 调用支持 SSE 流式输出的托管云函数（如 AI 打字机），逐片回调 onChunk。 */
  stream: <T = unknown>(
    fnName: string,
    payload: unknown,
    onChunk: (chunk: T) => void,
    options?: OrbitCloudCallOptions,
  ) => Promise<void>;
}

export interface OrbitRealtimeMessage {
  roomId: string | null;
  event: string;
  payload: unknown;
  ts: number;
}

export interface OrbitRealtimeAPI {
  /** 加入房间以接收云函数 ctx.realtime.broadcastRoom 广播。 */
  joinRoom: (roomId: string) => Promise<{ ok: boolean; appId: string; roomId: string }>;
  /** 离开指定实时房间。 */
  leaveRoom: (roomId: string) => Promise<{ ok: boolean; appId: string; roomId: string }>;
  /** 监听云函数推送的点对点消息（如发暗牌）或房间广播。 */
  onMessage: (listener: (msg: OrbitRealtimeMessage) => void) => () => void;
}

export interface OrbitUserProfile {
  userId: string;
  username?: string;
  displayName: string;
  avatar?: string;
  isAdmin: boolean;
}

export interface OrbitEnvInfo {
  appId: string;
  name: string;
  version: string;
  mode: OrbitDisplayMode;
  platform: string;
  theme: OrbitTheme;
  crossOriginIsolated: boolean;
  orbitVersion: string;
}

export interface OrbitSDK {
  sdkVersion: '1.3.0' | '1.2.0' | '1.1.0' | '1.0.0';
  isOrbit: boolean;
  env: {
    getInfo: () => Promise<OrbitEnvInfo>;
    getTheme: () => Promise<OrbitTheme>;
    onThemeChange: (listener: (theme: OrbitTheme) => void) => () => void;
    onModeChange: (listener: (mode: OrbitDisplayMode) => void) => () => void;
  };
  user: {
    getCurrent: () => Promise<OrbitUserProfile | null>;
  };
  storage: {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<void>;
    remove: (key: string) => Promise<void>;
    keys: () => Promise<string[]>;
  };
  ui: {
    toast: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => Promise<void>;
    requestMode: (mode: OrbitDisplayMode) => Promise<boolean>;
  };
  clipboard: {
    writeText: (text: string) => Promise<void>;
  };
  lifecycle: {
    onPause: (listener: () => void) => () => void;
    onResume: (listener: () => void) => () => void;
  };
  economy?: OrbitEconomyAPI;
  multiplayer?: OrbitMultiplayerAPI;
  cloud?: OrbitCloudAPI;
  realtime?: OrbitRealtimeAPI;
}

declare global {
  interface Window {
    orbitSDK?: OrbitSDK;
  }
}

const FALLBACK_PREFIX = 'orbit-sdk-dev-kv:';

function createBrowserFallbackSDK(): OrbitSDK {
  const prefersDark = () =>
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';

  return {
    sdkVersion: '1.3.0',
    isOrbit: false,
    env: {
      getInfo: async () => ({
        appId: 'browser-dev',
        name: document.title || 'Browser Preview',
        version: '0.0.0-dev',
        mode: 'standalone',
        platform: navigator.platform || 'web',
        theme: prefersDark(),
        crossOriginIsolated: Boolean(window.crossOriginIsolated),
        orbitVersion: '0.0.0',
      }),
      getTheme: async () => prefersDark(),
      onThemeChange: (listener) => {
        const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
        if (!mq) return () => undefined;
        const onChange = () => listener(mq.matches ? 'dark' : 'light');
        mq.addEventListener?.('change', onChange);
        return () => mq.removeEventListener?.('change', onChange);
      },
      onModeChange: () => () => undefined,
    },
    user: {
      getCurrent: async () => ({
        userId: 'dev-local-user',
        username: 'dev',
        displayName: '本地调试开发者',
        isAdmin: true,
      }),
    },
    storage: {
      get: async <T = unknown>(key: string) => {
        const raw = window.localStorage.getItem(FALLBACK_PREFIX + key);
        if (raw == null) return null;
        try {
          return JSON.parse(raw) as T;
        } catch {
          return raw as unknown as T;
        }
      },
      set: async (key: string, value: unknown) => {
        window.localStorage.setItem(FALLBACK_PREFIX + key, JSON.stringify(value));
      },
      remove: async (key: string) => {
        window.localStorage.removeItem(FALLBACK_PREFIX + key);
      },
      keys: async () => {
        const out: string[] = [];
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith(FALLBACK_PREFIX)) {
            out.push(k.slice(FALLBACK_PREFIX.length));
          }
        }
        return out.sort();
      },
    },
    ui: {
      toast: async (message) => {
        console.info('[orbit-sdk:toast]', message);
      },
      requestMode: async () => false,
    },
    clipboard: {
      writeText: async (text) => {
        await navigator.clipboard?.writeText(text);
      },
    },
    lifecycle: {
      onPause: () => () => undefined,
      onResume: () => () => undefined,
    },
    economy: {
      isNative: false,
      getWallet: async () => ({
        coinBalance: 500,
        frozenCoins: 0,
        lifetimeEarnedCoins: 500,
        weeklyRecordedMinutes: 180,
        weeklyTradeMinutes: 0,
        punchAffectsAssessment: true,
        quotas: {
          maxCoinPerOrder: 50,
          maxPunchPerOrder: 30,
          dailyCoinRemaining: 200,
          weeklyCoinGainRemaining: 500,
          weeklyPunchGainRemaining: 60,
          weeklyPunchLossRemaining: 60,
          activeOrdersCount: 0,
          maxActiveOrders: 3,
        },
      }),
      wager: {
        create: async (input) => ({
          orderId: `dev-order-${Date.now().toString(36)}`,
          appId: 'browser-dev',
          orderType: 'escrow_wager',
          matchId: input.matchId,
          title: input.title,
          asset: input.asset,
          amount: input.amount,
          weekKey: '2026-11-23',
          status: 'pending_accept',
          creatorUserId: 'dev-local-user',
          opponentUserId: input.opponentUserId,
          acceptExpiresAt: Date.now() + 30 * 60 * 1000,
          createdAt: Date.now(),
        }),
        accept: async (orderId) => ({
          orderId,
          appId: 'browser-dev',
          orderType: 'escrow_wager',
          matchId: 'dev-match',
          title: '本地预览对局',
          asset: 'coin',
          amount: 10,
          weekKey: '2026-11-23',
          status: 'locked',
          creatorUserId: 'dev-opponent',
          opponentUserId: 'dev-local-user',
          acceptExpiresAt: Date.now() + 30 * 60 * 1000,
          settleExpiresAt: Date.now() + 4 * 60 * 60 * 1000,
          createdAt: Date.now(),
        }),
        cancel: async () => undefined,
        get: async (orderId) => ({
          orderId,
          appId: 'browser-dev',
          orderType: 'escrow_wager',
          matchId: 'dev-match',
          title: '本地预览对局',
          asset: 'coin',
          amount: 10,
          weekKey: '2026-11-23',
          status: 'pending_accept',
          creatorUserId: 'dev-local-user',
          acceptExpiresAt: Date.now() + 30 * 60 * 1000,
          createdAt: Date.now(),
        }),
      },
      tip: async (input) => ({
        orderId: `dev-tip-${Date.now().toString(36)}`,
        appId: 'browser-dev',
        orderType: 'p2p_tip',
        matchId: '',
        title: input.note,
        asset: 'coin',
        amount: input.amount,
        weekKey: '2026-11-23',
        status: 'settled',
        creatorUserId: 'dev-local-user',
        opponentUserId: input.toUserId,
        acceptExpiresAt: Date.now(),
        settledAt: Date.now(),
        createdAt: Date.now(),
      }),
    },
    multiplayer: {
      getNakamaSession: async () => {
        throw new Error('浏览器独立预览环境无法直接换取工作室 Nakama 凭证，请在 Orbit 容器内运行');
      },
      listStudioMembers: async () => [
        {
          userId: 'dev-teammate-1',
          username: 'teammate1',
          displayName: '测试队友 A',
          avatar: '',
          enrollYear: 2025,
          isCaptain: false,
          isPlayingThisApp: true,
          playingAppName: document.title || 'Browser Preview',
          isSelf: false,
        },
        {
          userId: 'dev-teammate-2',
          username: 'teammate2',
          displayName: '测试队友 B',
          avatar: '',
          enrollYear: 2024,
          isCaptain: false,
          isPlayingThisApp: false,
          playingAppName: null,
          isSelf: false,
        },
      ],
      sendRoomInvite: async (input) => {
        console.info('[orbit-sdk:sendRoomInvite]', input);
        return {
          ok: true,
          appId: 'browser-dev',
          roomId: input.roomId,
          expiresAt: new Date(Date.now() + (input.expiresInSeconds ?? 600) * 1000).toISOString(),
          sent: input.toUserIds.map((userId, idx) => ({
            userId,
            displayName: `测试队友 ${idx + 1}`,
            inviteId: `dev-invite-${Date.now().toString(36)}-${idx}`,
          })),
        };
      },
      getLaunchRoom: async () => {
        if (typeof window === 'undefined') return null;
        const params = new URLSearchParams(window.location.search);
        const roomId = params.get('orbit_room');
        if (!roomId) return null;
        return {
          inviteId: 'dev-url-invite',
          appId: 'browser-dev',
          roomId,
          roomName: params.get('orbit_room_name') ?? undefined,
          inviter: {
            userId: 'dev-host',
            username: 'host',
            displayName: '本地调试房主',
          },
          acceptedAt: new Date().toISOString(),
        };
      },
      onRoomJoin: () => () => undefined,
    },
    cloud: {
      call: async () => {
        throw new Error('浏览器独立预览环境无法调用 Orbit 托管云函数，请在 Orbit 客户端容器内运行');
      },
      stream: async () => {
        throw new Error('浏览器独立预览环境无法调用 Orbit 流式云函数，请在 Orbit 客户端容器内运行');
      },
    },
    realtime: {
      joinRoom: async (roomId) => ({ ok: true, appId: 'browser-dev', roomId }),
      leaveRoom: async (roomId) => ({ ok: true, appId: 'browser-dev', roomId }),
      onMessage: () => () => undefined,
    },
  };
}

let cachedFallback: OrbitSDK | null = null;

export function getOrbitSDK(): OrbitSDK {
  if (typeof window !== 'undefined' && window.orbitSDK) {
    return window.orbitSDK;
  }
  if (!cachedFallback) {
    cachedFallback = createBrowserFallbackSDK();
  }
  return cachedFallback;
}
