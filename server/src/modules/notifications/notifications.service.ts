import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RealtimeHub } from '../realtime/realtime.hub.js';
import { DocBridgeService } from './docbridge.service.js';
import { buildReleaseMeta } from './devtron-release.util.js';
import { NotificationEntity } from './entities/notification.entity.js';
import { NotificationReadEntity } from './entities/notification-read.entity.js';

export interface NotificationDTO {
  id: string;
  sourceApp: string;
  eventType: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  targetUserId?: string;
  actionStatus?: string;
  actionNote?: string;
  actionBy?: string;
  actionAt?: string;
  isRead: boolean;
  createdAt: string;
}

export interface CreateNotificationInput {
  sourceApp: string;
  eventType: string;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
  targetUserId?: string | null;
  actionStatus?: string | null;
}

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notifRepo: Repository<NotificationEntity>,
    @InjectRepository(NotificationReadEntity)
    private readonly readRepo: Repository<NotificationReadEntity>,
    private readonly docBridge: DocBridgeService,
    private readonly hub: RealtimeHub,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async createAndPush(input: CreateNotificationInput, push = true): Promise<NotificationDTO> {
    const id = randomUUID();
    const now = new Date();
    const record = this.notifRepo.create({
      id,
      sourceApp: input.sourceApp,
      eventType: input.eventType,
      title: input.title,
      body: input.body ?? '',
      payload: input.payload ?? {},
      targetUserId: input.targetUserId ?? null,
      actionStatus: input.actionStatus ?? null,
      actionNote: null,
      actionBy: null,
      actionAt: null,
      createdAt: now,
    });
    await this.notifRepo.save(record);

    const dto: NotificationDTO = {
      id,
      sourceApp: record.sourceApp,
      eventType: record.eventType,
      title: record.title,
      body: record.body,
      payload: record.payload,
      targetUserId: record.targetUserId ?? undefined,
      actionStatus: record.actionStatus ?? undefined,
      isRead: false,
      createdAt: now.toISOString(),
    };

    if (push) {
      if (record.targetUserId) {
        void this.hub.pushToUser(record.targetUserId, { type: 'notification.created', payload: dto });
      } else {
        void this.hub.broadcast({ type: 'notification.created', payload: dto });
      }
    }
    return dto;
  }

  async listForUser(
    userId: string,
    opts?: { sourceApp?: string; unreadOnly?: boolean },
  ): Promise<NotificationDTO[]> {
    const sourceApp = (opts?.sourceApp ?? '').trim();
    const unreadOnly = Boolean(opts?.unreadOnly);

    const rows = (await this.notifRepo.query(
      `SELECT n.id::text AS id, n.source_app AS "sourceApp", n.event_type AS "eventType",
              n.title, n.body, n.payload, n.target_user_id AS "targetUserId",
              n.action_status AS "actionStatus", n.action_note AS "actionNote",
              n.action_by AS "actionBy", n.action_at AS "actionAt",
              EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = $1) AS "isRead",
              n.created_at AS "createdAt"
       FROM notifications n
       WHERE (n.target_user_id IS NULL OR n.target_user_id = $1)
         AND ($2 = '' OR n.source_app = $2)
         AND (NOT $3 OR NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = $1))
       ORDER BY n.created_at DESC
       LIMIT 80`,
      [userId, sourceApp, unreadOnly],
    )) as Array<{
      id: string;
      sourceApp: string;
      eventType: string;
      title: string;
      body: string;
      payload: Record<string, unknown>;
      targetUserId: string | null;
      actionStatus: string | null;
      actionNote: string | null;
      actionBy: string | null;
      actionAt: Date | null;
      isRead: boolean;
      createdAt: Date;
    }>;

    return rows.map((r) => ({
      id: r.id,
      sourceApp: r.sourceApp,
      eventType: r.eventType,
      title: r.title,
      body: r.body,
      payload: r.payload ?? {},
      targetUserId: r.targetUserId ?? undefined,
      actionStatus: r.actionStatus ?? undefined,
      actionNote: r.actionNote ?? undefined,
      actionBy: r.actionBy ?? undefined,
      actionAt: r.actionAt ? new Date(r.actionAt).toISOString() : undefined,
      isRead: Boolean(r.isRead),
      createdAt: new Date(r.createdAt).toISOString(),
    }));
  }

  async markRead(userId: string, notifId: string): Promise<{ ok: true }> {
    await this.readRepo.query(
      `INSERT INTO notification_reads (notification_id, user_id, read_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (notification_id, user_id) DO NOTHING`,
      [notifId, userId, new Date()],
    );
    return { ok: true };
  }

  async markAllRead(userId: string): Promise<{ ok: true }> {
    await this.readRepo.query(
      `INSERT INTO notification_reads (notification_id, user_id, read_at)
       SELECT n.id, $1, NOW()
       FROM notifications n
       WHERE (n.target_user_id IS NULL OR n.target_user_id = $1)
       ON CONFLICT DO NOTHING`,
      [userId],
    );
    return { ok: true };
  }

  async createDocEditRequest(user: AuthUser, pageKey: string, rawReason?: string) {
    const meta = await this.docBridge.resolvePageMeta(pageKey, user.userId);
    if (meta.requesterCanEdit) {
      throw new BadRequestException('你已拥有该文档的编辑权限，无需重复申请');
    }
    if (!meta.creatorSsoSub) {
      throw new BadRequestException('未找到该文档作者的 LecSSO 账号，无法推送审批');
    }
    if (meta.creatorSsoSub === user.userId) {
      throw new BadRequestException('你是该文档的作者，默认拥有完整编辑权');
    }

    const reason = (rawReason ?? '').trim() || '申请协作编辑该文档';
    const notif = await this.createAndPush({
      sourceApp: 'lec-doc',
      eventType: 'doc.edit_request',
      title: `文档编辑权限申请：《${meta.title}》`,
      body: `${user.displayName} 申请编辑你的云文档《${meta.title}》，理由：${reason}`,
      payload: {
        pageId: meta.pageId,
        pageSlugId: meta.slugId,
        pageTitle: meta.title,
        pageUrl: meta.pageUrl,
        requesterId: user.userId,
        requesterName: user.displayName,
        requesterAvatar: user.avatar,
        reason,
      },
      targetUserId: meta.creatorSsoSub,
      actionStatus: 'pending',
    });

    return {
      ok: true,
      requestId: notif.id,
      pageTitle: meta.title,
      authorName: meta.creatorName,
      description: `已向作者 ${meta.creatorName} 发送 Orbit 实时审批卡片`,
    };
  }

  async createInternalDocEditRequest(input: {
    pageId: string;
    pageSlugId?: string;
    pageTitle: string;
    pageUrl?: string;
    authorSsoSub: string;
    authorName?: string;
    requesterSsoSub: string;
    requesterName: string;
    requesterAvatar?: string;
    reason?: string;
  }) {
    if (input.authorSsoSub === input.requesterSsoSub) {
      throw new BadRequestException('你是该文档的作者，默认拥有完整编辑权');
    }
    const reason = (input.reason ?? '').trim() || '申请协作编辑该文档';
    const notif = await this.createAndPush({
      sourceApp: 'lec-doc',
      eventType: 'doc.edit_request',
      title: `文档编辑权限申请：《${input.pageTitle}》`,
      body: `${input.requesterName} 申请编辑你的云文档《${input.pageTitle}》，理由：${reason}`,
      payload: {
        pageId: input.pageId,
        pageSlugId: input.pageSlugId ?? '',
        pageTitle: input.pageTitle,
        pageUrl: input.pageUrl ?? '',
        requesterId: input.requesterSsoSub,
        requesterName: input.requesterName,
        requesterAvatar: input.requesterAvatar ?? '',
        reason,
      },
      targetUserId: input.authorSsoSub.trim(),
      actionStatus: 'pending',
    });
    const authorLabel = (input.authorName ?? '').trim() || '文档作者';
    return {
      ok: true,
      requestId: notif.id,
      pageTitle: input.pageTitle,
      authorName: authorLabel,
      description: `已向作者 ${authorLabel} 发送 Orbit 实时审批卡片`,
    };
  }

  async handleNotificationAction(
    user: AuthUser,
    notifId: string,
    decisionRaw: string,
    noteRaw?: string,
  ) {
    const decision = decisionRaw.trim().toLowerCase();
    if (decision !== 'approve' && decision !== 'deny') {
      throw new BadRequestException('decision 仅支持 approve 或 deny');
    }

    const record = await this.notifRepo.findOne({ where: { id: notifId } });
    if (!record) throw new NotFoundException('通知不存在');
    if (record.targetUserId !== user.userId) {
      throw new ForbiddenException('仅被通知的审批人可处理该请求');
    }
    if (record.actionStatus !== 'pending') {
      throw new ConflictException('该申请已处理，无需重复操作');
    }

    const payload = record.payload ?? {};
    const pageId = String(payload.pageId ?? '');
    const pageTitle = String(payload.pageTitle ?? '');
    const pageUrl = String(payload.pageUrl ?? '');
    const requesterId = String(payload.requesterId ?? '');

    if (record.eventType === 'doc.edit_request' && decision === 'approve') {
      await this.docBridge.grantEditorAccess(pageId, requesterId, user.userId);
    }

    const nextStatus = decision === 'approve' ? 'approved' : 'denied';
    const now = new Date();
    const note = (noteRaw ?? '').trim();

    record.actionStatus = nextStatus;
    record.actionNote = note;
    record.actionBy = user.userId;
    record.actionAt = now;
    await this.notifRepo.save(record);
    await this.markRead(user.userId, notifId);

    void this.hub.pushToUser(user.userId, {
      type: 'notification.updated',
      payload: {
        id: notifId,
        actionStatus: nextStatus,
        actionNote: note,
        actionBy: user.userId,
        actionAt: now.toISOString(),
        isRead: true,
      },
    });

    if (requesterId) {
      const resultTitle =
        decision === 'approve'
          ? `编辑权限申请已通过：《${pageTitle}》`
          : `编辑权限申请未通过：《${pageTitle}》`;
      const resultBody =
        decision === 'approve'
          ? `作者 ${user.displayName} 已同意你的编辑申请，现在可以直接编辑该文档。`
          : `作者 ${user.displayName} 拒绝了你的编辑申请${note ? `，说明：${note}` : '。'}`;
      await this.createAndPush({
        sourceApp: 'lec-doc',
        eventType: 'doc.edit_request_result',
        title: resultTitle,
        body: resultBody,
        payload: { pageId, pageTitle, pageUrl, decision: nextStatus },
        targetUserId: requesterId,
      });
    }

    return { ok: true, id: notifId, actionStatus: nextStatus };
  }

  async handleDevtronWebhook(raw: Record<string, unknown>): Promise<NotificationDTO> {
    const { meta, summary } = await buildReleaseMeta(raw, this.cfg.githubToken);
    const enriched = { ...raw, release: meta };
    const title = meta.version
      ? `${meta.appName} 已更新至 ${meta.version}`
      : `${meta.appName} 已发布更新`;

    return this.createAndPush({
      sourceApp: meta.appName,
      eventType: 'app.updated',
      title,
      body: summary,
      payload: enriched,
    });
  }
}
