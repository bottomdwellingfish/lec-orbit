import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SsoAuthGuard } from '../../common/guards/sso-auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { NakamaService } from './nakama.service.js';

const SessionExchangeSchema = z.object({
  appId: z.string().trim().max(64).optional(),
});

@Controller('api/v1/nakama')
@UseGuards(SsoAuthGuard)
export class NakamaController {
  constructor(private readonly nakamaService: NakamaService) {}

  @Get('config')
  getConfig() {
    return this.nakamaService.getPublicConfig();
  }

  @Post('session')
  @HttpCode(HttpStatus.OK)
  exchangeSession(@CurrentUser() user: AuthUser, @Body() rawBody?: unknown) {
    const parsed = SessionExchangeSchema.parse(rawBody ?? {});
    return this.nakamaService.exchangeSession(user, parsed.appId);
  }
}
