import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SsoAuthGuard } from '../../common/guards/sso-auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { NotificationsService } from './notifications.service.js';

const UuidSchema = z.string().uuid('无效的通知 ID');

const DocRequestSchema = z.object({
  pageKey: z.string().trim().min(1, '请提供文档标识'),
  reason: z.string().optional(),
});

const ActionSchema = z.object({
  decision: z.string().trim().min(1, '请指定 decision（approve / deny）'),
  note: z.string().optional(),
});

@Controller('api/v1')
@UseGuards(SsoAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('notifications')
  async list(
    @CurrentUser() user: AuthUser,
    @Query('sourceApp') sourceApp?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    const items = await this.notificationsService.listForUser(user.userId, {
      sourceApp,
      unreadOnly: unreadOnly === 'true',
    });
    return { items };
  }

  @Post('notifications/:id/read')
  @HttpCode(HttpStatus.OK)
  markRead(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.notificationsService.markRead(user.userId, UuidSchema.parse(id));
  }

  @Post('notifications/read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notificationsService.markAllRead(user.userId);
  }

  @Post('notifications/:id/action')
  @HttpCode(HttpStatus.OK)
  action(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() rawBody: unknown) {
    const body = ActionSchema.parse(rawBody);
    return this.notificationsService.handleNotificationAction(
      user,
      UuidSchema.parse(id),
      body.decision,
      body.note,
    );
  }

  @Post('doc-requests')
  @HttpCode(HttpStatus.CREATED)
  createDocRequest(@CurrentUser() user: AuthUser, @Body() rawBody: unknown) {
    const body = DocRequestSchema.parse(rawBody);
    return this.notificationsService.createDocEditRequest(user, body.pageKey, body.reason);
  }
}
