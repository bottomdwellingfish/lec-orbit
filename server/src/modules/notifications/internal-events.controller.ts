import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { InternalTokenGuard } from '../../common/guards/internal-token.guard.js';
import { NotificationsService } from './notifications.service.js';

const InternalEventSchema = z.object({
  sourceApp: z.string().trim().min(1, '事件格式无效'),
  eventType: z.string().trim().min(1, '事件格式无效'),
  title: z.string().trim().min(1, '事件格式无效'),
  body: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  targetUserId: z.string().nullable().optional(),
  actionStatus: z.string().nullable().optional(),
});

const InternalDocRequestSchema = z.object({
  pageId: z.string().trim().min(1),
  pageSlugId: z.string().optional(),
  pageTitle: z.string().trim().min(1),
  pageUrl: z.string().optional(),
  authorSsoSub: z.string().trim().min(1),
  authorName: z.string().optional(),
  requesterSsoSub: z.string().trim().min(1),
  requesterName: z.string().trim().min(1),
  requesterAvatar: z.string().optional(),
  reason: z.string().optional(),
});

@Controller('internal/v1')
@UseGuards(InternalTokenGuard)
export class InternalEventsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('events')
  @HttpCode(HttpStatus.CREATED)
  pushEvent(@Body() rawBody: unknown) {
    const req = InternalEventSchema.parse(rawBody);
    return this.notificationsService.createAndPush({
      sourceApp: req.sourceApp,
      eventType: req.eventType,
      title: req.title,
      body: req.body?.trim() ?? '',
      payload: req.payload ?? {},
      targetUserId: req.targetUserId ?? null,
      actionStatus: req.actionStatus ?? null,
    });
  }

  @Post('webhooks/devtron')
  @HttpCode(HttpStatus.CREATED)
  devtronWebhook(@Body() rawBody: unknown) {
    const raw = z.record(z.string(), z.unknown()).parse(rawBody);
    return this.notificationsService.handleDevtronWebhook(raw);
  }

  @Post('doc-requests')
  @HttpCode(HttpStatus.CREATED)
  docEditRequest(@Body() rawBody: unknown) {
    const req = InternalDocRequestSchema.parse(rawBody);
    return this.notificationsService.createInternalDocEditRequest(req);
  }
}
