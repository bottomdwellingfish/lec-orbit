/**
 * 工坊小程序 / 小游戏专用最小权限 Preload（contextIsolation: true, sandbox: true, nodeIntegration: false）：
 * - 仅暴露受控的 window.orbitSDK
 * - 绝不暴露主进程认证 Token、本地密钥库、文件系统或系统 Shell
 * - 主进程依据 event.sender.id 绑定真实 appId，调用方无法伪造跨应用身份
 */
import { contextBridge, ipcRenderer } from 'electron';

export type OrbitSdkTheme = 'light' | 'dark';
export type OrbitSdkMode = 'sidepanel' | 'workspace' | 'standalone';

export interface OrbitSdkUser {
  userId: string;
  username?: string;
  displayName: string;
  avatar?: string;
  isAdmin: boolean;
}

export interface OrbitSdkEnvInfo {
  appId: string;
  name: string;
  version: string;
  mode: OrbitSdkMode;
  platform: string;
  theme: OrbitSdkTheme;
  crossOriginIsolated: boolean;
  orbitVersion: string;
}

export type OrbitSdkAsset = 'coin' | 'punch_minutes';

export interface OrbitSdkWalletSummary {
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

export interface OrbitSdkWagerCreateInput {
  asset: OrbitSdkAsset;
  amount: number;
  matchId: string;
  opponentUserId?: string;
  title: string;
  acceptTimeoutSeconds?: number;
}

export interface OrbitSdkTipInput {
  toUserId: string;
  amount: number;
  note: string;
}

export interface OrbitSdkOrderTicket {
  orderId: string;
  appId: string;
  orderType: string;
  matchId: string;
  title: string;
  asset: OrbitSdkAsset;
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

export interface OrbitSdkNakamaSession {
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

export interface OrbitSdkRealtimeMessage {
  roomId: string | null;
  event: string;
  payload: unknown;
  ts: number;
}

export interface OrbitSdkCloudCallOptions {
  previewVersionId?: string;
}

const orbitSDK = {
  sdkVersion: '1.2.0' as const,
  isOrbit: true as const,

  env: {
    getInfo: (): Promise<OrbitSdkEnvInfo> => ipcRenderer.invoke('orbit:sdk:env:getInfo'),
    getTheme: (): Promise<OrbitSdkTheme> => ipcRenderer.invoke('orbit:sdk:env:getTheme'),
    onThemeChange: (listener: (theme: OrbitSdkTheme) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, theme: OrbitSdkTheme) => listener(theme);
      ipcRenderer.on('orbit:sdk:event:themeChanged', wrapped);
      return () => ipcRenderer.removeListener('orbit:sdk:event:themeChanged', wrapped);
    },
    onModeChange: (listener: (mode: OrbitSdkMode) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, mode: OrbitSdkMode) => listener(mode);
      ipcRenderer.on('orbit:sdk:event:modeChanged', wrapped);
      return () => ipcRenderer.removeListener('orbit:sdk:event:modeChanged', wrapped);
    },
  },

  user: {
    getCurrent: (): Promise<OrbitSdkUser | null> => ipcRenderer.invoke('orbit:sdk:user:getCurrent'),
  },

  storage: {
    get: <T = unknown>(key: string): Promise<T | null> =>
      ipcRenderer.invoke('orbit:sdk:storage:get', key),
    set: (key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke('orbit:sdk:storage:set', { key, value }),
    remove: (key: string): Promise<void> => ipcRenderer.invoke('orbit:sdk:storage:remove', key),
    keys: (): Promise<string[]> => ipcRenderer.invoke('orbit:sdk:storage:keys'),
  },

  ui: {
    toast: (message: string, tone: 'info' | 'success' | 'warning' | 'error' = 'info'): Promise<void> =>
      ipcRenderer.invoke('orbit:sdk:ui:toast', { message, tone }),
    requestMode: (mode: OrbitSdkMode): Promise<boolean> =>
      ipcRenderer.invoke('orbit:sdk:ui:requestMode', mode),
  },

  clipboard: {
    writeText: (text: string): Promise<void> =>
      ipcRenderer.invoke('orbit:sdk:clipboard:writeText', text),
  },

  lifecycle: {
    onPause: (listener: () => void): (() => void) => {
      const wrapped = () => listener();
      ipcRenderer.on('orbit:sdk:event:pause', wrapped);
      return () => ipcRenderer.removeListener('orbit:sdk:event:pause', wrapped);
    },
    onResume: (listener: () => void): (() => void) => {
      const wrapped = () => listener();
      ipcRenderer.on('orbit:sdk:event:resume', wrapped);
      return () => ipcRenderer.removeListener('orbit:sdk:event:resume', wrapped);
    },
  },

  economy: {
    isNative: true as const,
    getWallet: (): Promise<OrbitSdkWalletSummary> =>
      ipcRenderer.invoke('orbit:sdk:economy:getWallet'),
    wager: {
      create: (input: OrbitSdkWagerCreateInput): Promise<OrbitSdkOrderTicket> =>
        ipcRenderer.invoke('orbit:sdk:economy:wager:create', input),
      accept: (orderId: string): Promise<OrbitSdkOrderTicket> =>
        ipcRenderer.invoke('orbit:sdk:economy:wager:accept', orderId),
      cancel: (orderId: string): Promise<void> =>
        ipcRenderer.invoke('orbit:sdk:economy:wager:cancel', orderId),
      get: (orderId: string): Promise<OrbitSdkOrderTicket> =>
        ipcRenderer.invoke('orbit:sdk:economy:wager:get', orderId),
    },
    tip: (input: OrbitSdkTipInput): Promise<OrbitSdkOrderTicket> =>
      ipcRenderer.invoke('orbit:sdk:economy:tip', input),
  },

  multiplayer: {
    getNakamaSession: (): Promise<OrbitSdkNakamaSession> =>
      ipcRenderer.invoke('orbit:sdk:multiplayer:getNakamaSession'),
  },

  cloud: {
    call: <T = unknown>(
      fnName: string,
      payload?: unknown,
      options?: OrbitSdkCloudCallOptions,
    ): Promise<T> =>
      ipcRenderer.invoke('orbit:sdk:cloud:call', {
        fnName,
        payload,
        previewVersionId: options?.previewVersionId,
      }),
    stream: async <T = unknown>(
      fnName: string,
      payload: unknown,
      onChunk: (chunk: T) => void,
      options?: OrbitSdkCloudCallOptions,
    ): Promise<void> => {
      const streamId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const handler = (
        _event: Electron.IpcRendererEvent,
        msg: { streamId?: string; chunk?: T; done?: boolean },
      ) => {
        if (msg?.streamId !== streamId) return;
        if (!msg.done && msg.chunk !== undefined) {
          onChunk(msg.chunk);
        }
      };
      ipcRenderer.on('orbit:sdk:event:cloudStreamChunk', handler);
      try {
        await ipcRenderer.invoke('orbit:sdk:cloud:stream', {
          streamId,
          fnName,
          payload,
          previewVersionId: options?.previewVersionId,
        });
      } finally {
        ipcRenderer.removeListener('orbit:sdk:event:cloudStreamChunk', handler);
      }
    },
  },

  realtime: {
    joinRoom: (roomId: string): Promise<{ ok: boolean; appId: string; roomId: string }> =>
      ipcRenderer.invoke('orbit:sdk:realtime:joinRoom', roomId),
    leaveRoom: (roomId: string): Promise<{ ok: boolean; appId: string; roomId: string }> =>
      ipcRenderer.invoke('orbit:sdk:realtime:leaveRoom', roomId),
    onMessage: (listener: (msg: OrbitSdkRealtimeMessage) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, msg: OrbitSdkRealtimeMessage) =>
        listener(msg);
      ipcRenderer.on('orbit:sdk:event:realtime', wrapped);
      return () => ipcRenderer.removeListener('orbit:sdk:event:realtime', wrapped);
    },
  },
};

contextBridge.exposeInMainWorld('orbitSDK', orbitSDK);
