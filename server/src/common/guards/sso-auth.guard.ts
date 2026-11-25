/**
 * LecSSO 认证守卫：
 * 从 Authorization: Bearer <token> 或 query.token 提取令牌，校验后注入 AuthUser，
 * 同时异步同步成员花名册缓存。
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
import { ORBIT_AUTH_USER_KEY } from '../decorators/current-user.decorator.js';
import { AuthService } from '../../modules/auth/auth.service.js';
import { RosterService } from '../../modules/roster/roster.service.js';

@Injectable()
export class SsoAuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    @Optional() private readonly rosterService?: RosterService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      query?: Record<string, string | string[] | undefined>;
      url?: string;
      [ORBIT_AUTH_USER_KEY]?: unknown;
    }>();

    const token = this.extractToken(req);
    const user = await this.authService.verifyToken(token);
    if (!user.isStudio && !user.isCaptain) {
      throw new ForbiddenException('仅限工作室正式成员访问');
    }

    req[ORBIT_AUTH_USER_KEY] = user;
    if (this.rosterService) {
      void this.rosterService.upsertFromAuth(user).catch(() => undefined);
    }
    return true;
  }

  private extractToken(req: {
    headers?: Record<string, string | string[] | undefined>;
    query?: Record<string, string | string[] | undefined>;
    url?: string;
  }): string {
    const rawHeader = req.headers?.authorization ?? req.headers?.Authorization;
    const authHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      return authHeader.slice(7).trim();
    }
    const qToken = req.query?.token;
    if (typeof qToken === 'string' && qToken.trim()) {
      return qToken.trim();
    }
    if (req.url) {
      try {
        const parsed = new URL(req.url, 'http://localhost');
        const t = parsed.searchParams.get('token');
        if (t?.trim()) return t.trim();
      } catch {
        // 忽略非法 URL
      }
    }
    return '';
  }
}
