import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '../../modules/auth/auth.types.js';

export const ORBIT_AUTH_USER_KEY = 'orbitAuthUser';

/** 从请求上下文中提取通过 LecSSO 鉴权的当前成员身份。 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<Record<string, unknown>>();
    return req[ORBIT_AUTH_USER_KEY] as AuthUser;
  },
);
