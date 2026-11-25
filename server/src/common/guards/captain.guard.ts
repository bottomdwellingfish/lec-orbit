import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ORBIT_AUTH_USER_KEY } from '../decorators/current-user.decorator.js';
import { REQUIRE_CAPTAIN_KEY } from '../decorators/require-captain.decorator.js';
import type { AuthUser } from '../../modules/auth/auth.types.js';

/** 队长 / 管理员权限守卫（配合 @RequireCaptain() 使用）。 */
@Injectable()
export class CaptainGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_CAPTAIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;
    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    const user = req[ORBIT_AUTH_USER_KEY] as AuthUser | undefined;
    if (!user || !user.isCaptain) {
      throw new ForbiddenException('仅队长/管理员可执行该操作');
    }
    return true;
  }
}
