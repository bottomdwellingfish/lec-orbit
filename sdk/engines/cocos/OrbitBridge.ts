/**
 * Cocos Creator 3.8 适配器（SDK v1.3.0，直接复制到 assets/scripts/OrbitBridge.ts 即可使用）。
 * 构建平台推荐选择 Web Desktop 或 Web Mobile，并在构建产物根目录放入 orbit.manifest.json。
 */
import {
  getOrbitSDK,
  type OrbitDisplayMode,
  type OrbitNakamaSession,
  type OrbitRoomInviteInput,
  type OrbitRoomInviteResult,
  type OrbitRoomJoinPayload,
  type OrbitStudioMember,
  type OrbitTheme,
  type OrbitUserProfile,
} from '../../orbit-sdk';

export class CocosOrbitBridge {
  static get isOrbit(): boolean {
    return getOrbitSDK().isOrbit;
  }

  static async getUser(): Promise<OrbitUserProfile | null> {
    return getOrbitSDK().user.getCurrent();
  }

  static async getTheme(): Promise<OrbitTheme> {
    return getOrbitSDK().env.getTheme();
  }

  static onThemeChange(cb: (theme: OrbitTheme) => void): () => void {
    return getOrbitSDK().env.onThemeChange(cb);
  }

  static onModeChange(cb: (mode: OrbitDisplayMode) => void): () => void {
    return getOrbitSDK().env.onModeChange(cb);
  }

  static async saveData(key: string, value: unknown): Promise<void> {
    return getOrbitSDK().storage.set(key, value);
  }

  static async loadData<T = unknown>(key: string): Promise<T | null> {
    return getOrbitSDK().storage.get<T>(key);
  }

  static toast(message: string, tone: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    void getOrbitSDK().ui.toast(message, tone);
  }

  // ── 多人联机与工作室组队直达进房（SDK v1.3.0+）──

  static async getNakamaSession(): Promise<OrbitNakamaSession> {
    const mp = getOrbitSDK().multiplayer;
    if (!mp) throw new Error('当前 Orbit 客户端版本过低，请升级至最新版本');
    return mp.getNakamaSession();
  }

  static async listStudioMembers(options?: { includeSelf?: boolean }): Promise<OrbitStudioMember[]> {
    const mp = getOrbitSDK().multiplayer;
    if (!mp?.listStudioMembers) return [];
    return mp.listStudioMembers(options);
  }

  static async sendRoomInvite(input: OrbitRoomInviteInput): Promise<OrbitRoomInviteResult> {
    const mp = getOrbitSDK().multiplayer;
    if (!mp?.sendRoomInvite) {
      throw new Error('当前 Orbit 客户端版本不支持组队邀请，请升级至 v0.2.4+');
    }
    return mp.sendRoomInvite(input);
  }

  static async getLaunchRoom(): Promise<OrbitRoomJoinPayload | null> {
    const mp = getOrbitSDK().multiplayer;
    if (!mp?.getLaunchRoom) return null;
    return mp.getLaunchRoom();
  }

  static onRoomJoin(cb: (payload: OrbitRoomJoinPayload) => void): () => void {
    const mp = getOrbitSDK().multiplayer;
    if (!mp?.onRoomJoin) return () => undefined;
    return mp.onRoomJoin(cb);
  }

  /** 房主监听受邀同学接受/婉拒的实时回执事件。 */
  static onInviteResponded(cb: (payload: Record<string, unknown>) => void): () => void {
    const rt = getOrbitSDK().realtime;
    if (!rt) return () => undefined;
    return rt.onMessage((msg) => {
      if (msg.event === 'orbit.invite.responded' && msg.payload && typeof msg.payload === 'object') {
        cb(msg.payload as Record<string, unknown>);
      }
    });
  }
}
