/**
 * 内部服务总线鉴权守卫（/internal/v1/*）：
 * 支持 X-Orbit-Service-Token、X-Orbit-Internal-Token 与 query.token，
 * 并兼容 LecDoc 双向令牌仅用于 /internal/v1/doc-requests 回调。
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import { constantTimeEqualString } from '../utils/hmac.js';

@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.cfg.internalServiceToken && !this.cfg.lecDocInternalToken) {
      throw new ServiceUnavailableException('内部事件总线令牌尚未配置');
    }

    const req = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      query?: Record<string, string | string[] | undefined>;
      url?: string;
    }>();

    const readHeader = (name: string): string => {
      const v = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
      return (Array.isArray(v) ? v[0] : v ?? '').trim();
    };

    let got = readHeader('x-orbit-service-token') || readHeader('x-orbit-internal-token');
    if (!got) {
      const qToken = req.query?.token;
      if (typeof qToken === 'string') got = qToken.trim();
    }
    if (!got && req.url) {
      try {
        got = new URL(req.url, 'http://localhost').searchParams.get('token')?.trim() ?? '';
      } catch {
        // 忽略
      }
    }

    let matched = false;
    if (this.cfg.internalServiceToken && constantTimeEqualString(got, this.cfg.internalServiceToken)) {
      matched = true;
    }

    const pathname = (req.url ?? '').split('?')[0];
    if (
      !matched &&
      this.cfg.lecDocInternalToken &&
      pathname.endsWith('/doc-requests') &&
      constantTimeEqualString(got, this.cfg.lecDocInternalToken)
    ) {
      matched = true;
    }

    if (!matched) {
      throw new UnauthorizedException('无效的内部服务令牌');
    }
    return true;
  }
}
