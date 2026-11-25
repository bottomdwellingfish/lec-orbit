import { SetMetadata } from '@nestjs/common';

export const REQUIRE_CAPTAIN_KEY = 'orbitRequireCaptain';

/** 标记仅队长 / 管理员可访问的路由。 */
export const RequireCaptain = () => SetMetadata(REQUIRE_CAPTAIN_KEY, true);
