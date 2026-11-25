import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SsoAuthGuard } from '../../common/guards/sso-auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RosterService } from './roster.service.js';

@Controller('api/v1')
@UseGuards(SsoAuthGuard)
export class RosterController {
  constructor(private readonly rosterService: RosterService) {}

  @Get('me')
  getMe(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Get('members')
  async listMembers() {
    const items = await this.rosterService.listActive();
    return { items };
  }
}
