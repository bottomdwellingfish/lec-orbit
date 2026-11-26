/**
 * Nakama 游戏联机 BaaS 单点换票服务：
 * - 服务端私密持有 NAKAMA_SERVER_KEY，绝不向前端或小游戏构建包泄露；
 * - 客户端凭已验证的 LecSSO 身份调用 POST /api/v1/nakama/session，由本服务通过集群内网
 *   为成员签发绑定 `lec:<orbitUserId>` 的 Nakama Session JWT，并同步昵称与头像；
 * - 游戏端拿到 { host, port, useSSL, token, refreshToken } 后可直接传入官方 JS / Cocos / Unity / Godot SDK。
 */
import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import type { AuthUser } from '../auth/auth.types.js';

export interface NakamaPublicConfigDTO {
  enabled: boolean;
  host: string;
  port: string;
  useSSL: boolean;
}

export interface NakamaSessionDTO {
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

/** 将 Orbit 用户名规范化为 Nakama 允许的合法用户名（避免非法字符或空串）。 */
export function sanitizeNakamaUsername(rawUsername: string | undefined, userId: string): string {
  const cleaned = (rawUsername ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (cleaned.length >= 3) return cleaned;
  const fallbackSuffix = userId.replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'member';
  return `lec_${fallbackSuffix}`;
}

/** 从 Nakama 返回的 JWT 中提取 uid / usn / exp（仅用于填充回包元信息，信任来源为内网直连响应）。 */
export function decodeNakamaJwtClaims(token: string): {
  uid?: string;
  usn?: string;
  exp?: number;
} {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return {};
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      uid?: unknown;
      usn?: unknown;
      exp?: unknown;
    };
    return {
      uid: typeof payload.uid === 'string' ? payload.uid : undefined,
      usn: typeof payload.usn === 'string' ? payload.usn : undefined,
      exp: typeof payload.exp === 'number' ? payload.exp : undefined,
    };
  } catch {
    return {};
  }
}

@Injectable()
export class NakamaService {
  private readonly logger = new Logger(NakamaService.name);

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  getPublicConfig(): NakamaPublicConfigDTO {
    return {
      enabled: Boolean(this.cfg.nakama.serverKey && this.cfg.nakama.internalUrl),
      host: this.cfg.nakama.publicHost,
      port: this.cfg.nakama.publicPort,
      useSSL: this.cfg.nakama.publicUseSsl,
    };
  }

  /** 将当前已鉴权的 Orbit / LecSSO 成员换取为 Nakama 实时联机会话。 */
  async exchangeSession(
    user: AuthUser,
    appId?: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<NakamaSessionDTO> {
    const { internalUrl, serverKey, publicHost, publicPort, publicUseSsl } = this.cfg.nakama;
    if (!serverKey || !internalUrl) {
      throw new ServiceUnavailableException('Nakama 游戏联机服务尚未配置');
    }

    const customId = `lec:${user.userId}`;
    const baseUsername = sanitizeNakamaUsername(user.username, user.userId);
    const basicAuth = `Basic ${Buffer.from(`${serverKey}:`, 'utf8').toString('base64')}`;

    const vars: Record<string, string> = {
      orbitUserId: user.userId,
      displayName: user.displayName || user.username || user.userId,
    };
    if (user.username) vars.username = user.username;
    if (appId?.trim()) vars.appId = appId.trim().slice(0, 64);

    const requestAuth = async (usernameCandidate: string) => {
      const url = `${internalUrl}/v2/account/authenticate/custom?create=true&username=${encodeURIComponent(usernameCandidate)}`;
      return fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: basicAuth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ id: customId, vars }),
      });
    };

    let resp = await requestAuth(baseUsername);
    // 若用户名恰好与历史账号冲突，附加短后缀重试一次
    if (resp.status === 409) {
      const suffix = user.userId.replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'u';
      resp = await requestAuth(`${baseUsername.slice(0, 40)}_${suffix}`);
    }

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      this.logger.warn(`Nakama 单点换票失败（HTTP ${resp.status}）：${detail.slice(0, 200)}`);
      throw new BadGatewayException('Nakama 联机服务认证失败，请稍后重试');
    }

    const body = (await resp.json()) as {
      token?: string;
      refresh_token?: string;
      created?: boolean;
    };
    if (!body.token) {
      throw new BadGatewayException('Nakama 返回了无效的会话凭证');
    }

    // 最佳努力同步工作室成员的显示名称与头像，不阻塞主登录链路
    void fetchImpl(`${internalUrl}/v2/account`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${body.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        display_name: user.displayName || user.username || baseUsername,
        ...(user.avatar ? { avatar_url: user.avatar } : {}),
      }),
    }).catch(() => undefined);

    const claims = decodeNakamaJwtClaims(body.token);

    return {
      host: publicHost,
      port: publicPort,
      useSSL: publicUseSsl,
      token: body.token,
      refreshToken: body.refresh_token ?? '',
      userId: claims.uid ?? '',
      orbitUserId: user.userId,
      username: claims.usn ?? baseUsername,
      displayName: user.displayName || user.username || baseUsername,
      expiresAt: claims.exp ? claims.exp * 1000 : Date.now() + 7200 * 1000,
      created: Boolean(body.created),
    };
  }
}
