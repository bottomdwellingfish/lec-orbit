/**
 * @lec-space/orbit-sdk（v1.1.0）
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
  status: 'pending_accept' | 'locked' | 'settled' | 'refunded' | 'cancelled' | 'expired';
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

export interface OrbitMultiplayerAPI {
  /** 获取绑定当前工作室成员身份的 Nakama 联机会话（免前端管理 Server Key）。 */
  getNakamaSession: () => Promise<OrbitNakamaSession>;
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
  sdkVersion: '1.1.0' | '1.0.0';
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
    sdkVersion: '1.1.0',
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
