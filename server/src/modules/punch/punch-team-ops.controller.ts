/**
 * 团队协作运维模块（PostgreSQL TypeORM 版）：
 * 完整承接 LecPunch 的团队活动 (/team-events/*)、财务账本 (/team-ledger/*)、
 * 反馈举报 (/reports*)、站内通知 (/notifications/*) 与局域网会议 (/meet/token)。
 */
import { createHmac } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import {
  PunchNotificationEntity,
  PunchNotificationReceiptEntity,
  PunchReportEntity,
  PunchTeamEventEntity,
  PunchTeamLedgerEntryEntity,
} from './entities/punch-collab.entities.js';
import { PunchUserEntity } from './entities/punch-core.entities.js';
import {
  PunchAdminOnly,
  PunchAuthGuard,
  PunchCurrentUser,
  type PunchAuthUser,
} from './punch-auth.guard.js';
import { newObjectIdHex } from './punch-shared.util.js';

const CreateEventSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  eventAt: z.string().datetime(),
  status: z.enum(['planned', 'done', 'cancelled']).default('planned'),
});

const UpdateEventSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(1000).nullable().optional(),
  eventAt: z.string().datetime().optional(),
  status: z.enum(['planned', 'done', 'cancelled']).optional(),
});

const CreateLedgerSchema = z.object({
  occurredAt: z.string().datetime(),
  type: z.enum(['income', 'expense']),
  amountCents: z.number().int().min(1),
  category: z.string().trim().min(1).max(64),
  counterparty: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
  proofFileName: z.string().max(200).optional(),
  proofFileMimeType: z.string().max(100).optional(),
  proofFileBase64: z.string().optional(),
});

const CreateReportSchema = z.object({
  description: z.string().trim().min(1).max(2000),
  requestKey: z.string().max(128).optional(),
});

const AdminNoticeSchema = z.object({
  title: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(2000),
  audience: z.enum(['team_members', 'team_admin']).default('team_members'),
});

@Controller()
@UseGuards(PunchAuthGuard)
export class PunchTeamOpsController {
  constructor(
    @InjectRepository(PunchTeamEventEntity)
    private readonly eventRepo: Repository<PunchTeamEventEntity>,
    @InjectRepository(PunchTeamLedgerEntryEntity)
    private readonly ledgerRepo: Repository<PunchTeamLedgerEntryEntity>,
    @InjectRepository(PunchReportEntity)
    private readonly reportRepo: Repository<PunchReportEntity>,
    @InjectRepository(PunchNotificationEntity)
    private readonly notifRepo: Repository<PunchNotificationEntity>,
    @InjectRepository(PunchNotificationReceiptEntity)
    private readonly receiptRepo: Repository<PunchNotificationReceiptEntity>,
    @InjectRepository(PunchUserEntity)
    private readonly userRepo: Repository<PunchUserEntity>,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  // ── 团队活动 (/team-events/*) ──

  @Get('team-events/events')
  listPublicEvents(@PunchCurrentUser() user: PunchAuthUser) {
    return this.eventRepo.find({
      where: { teamId: user.teamId },
      order: { eventAt: 'DESC' },
      take: 100,
    });
  }

  @Get('team-events/admin/events')
  @PunchAdminOnly()
  listAdminEvents(@PunchCurrentUser() user: PunchAuthUser) {
    return this.eventRepo.find({
      where: { teamId: user.teamId },
      order: { eventAt: 'DESC' },
      take: 200,
    });
  }

  @Post('team-events/admin/events')
  @PunchAdminOnly()
  createEvent(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const input = CreateEventSchema.parse(rawBody);
    const now = new Date();
    const entity = this.eventRepo.create({
      id: newObjectIdHex(),
      teamId: user.teamId,
      title: input.title,
      description: input.description ?? null,
      eventAt: new Date(input.eventAt),
      status: input.status,
      createdBy: user.userId,
      updatedBy: user.userId,
      createdAt: now,
      updatedAt: now,
    });
    return this.eventRepo.save(entity);
  }

  @Patch('team-events/admin/events/:eventId')
  @PunchAdminOnly()
  async updateEvent(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('eventId') eventId: string,
    @Body() rawBody: unknown,
  ) {
    const input = UpdateEventSchema.parse(rawBody);
    const entity = await this.eventRepo.findOne({
      where: { id: eventId.trim(), teamId: user.teamId },
    });
    if (!entity) throw new NotFoundException('活动不存在');
    if (input.title !== undefined) entity.title = input.title;
    if (input.description !== undefined) entity.description = input.description;
    if (input.eventAt !== undefined) entity.eventAt = new Date(input.eventAt);
    if (input.status !== undefined) entity.status = input.status;
    entity.updatedBy = user.userId;
    entity.updatedAt = new Date();
    return this.eventRepo.save(entity);
  }

  // ── 团队财务账本 (/team-ledger/*) ──

  @Get('team-ledger/admin/entries')
  @PunchAdminOnly()
  listLedger(@PunchCurrentUser() user: PunchAuthUser) {
    return this.ledgerRepo.find({
      where: { teamId: user.teamId },
      order: { occurredAt: 'DESC' },
      take: 500,
    });
  }

  @Post('team-ledger/admin/entries')
  @PunchAdminOnly()
  createLedger(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const input = CreateLedgerSchema.parse(rawBody);
    const now = new Date();
    const rec = this.ledgerRepo.create({
      id: newObjectIdHex(),
      teamId: user.teamId,
      occurredAt: new Date(input.occurredAt),
      type: input.type,
      status: 'active',
      amountCents: input.amountCents,
      category: input.category,
      counterparty: input.counterparty ?? null,
      note: input.note ?? null,
      proofFileName: input.proofFileName ?? null,
      proofFileMimeType: input.proofFileMimeType ?? null,
      proofFileBase64: input.proofFileBase64 ?? null,
      createdBy: user.userId,
      reversalOfEntryId: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      createdAt: now,
      updatedAt: now,
    });
    return this.ledgerRepo.save(rec);
  }

  @Patch('team-ledger/admin/entries/:entryId/void')
  @PunchAdminOnly()
  async voidLedger(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('entryId') entryId: string,
    @Body() rawBody: { reason?: string },
  ) {
    const rec = await this.ledgerRepo.findOne({
      where: { id: entryId.trim(), teamId: user.teamId },
    });
    if (!rec) throw new NotFoundException('账本记录不存在');
    const now = new Date();
    rec.status = 'voided';
    rec.voidedAt = now;
    rec.voidedBy = user.userId;
    rec.voidReason = rawBody?.reason?.trim() || null;
    rec.updatedAt = now;
    return this.ledgerRepo.save(rec);
  }

  @Post('team-ledger/admin/entries/:entryId/reversal')
  @PunchAdminOnly()
  async reverseLedger(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('entryId') entryId: string,
    @Body() rawBody: { note?: string },
  ) {
    const orig = await this.ledgerRepo.findOne({
      where: { id: entryId.trim(), teamId: user.teamId },
    });
    if (!orig) throw new NotFoundException('原账本记录不存在');
    const now = new Date();
    const rev = this.ledgerRepo.create({
      id: newObjectIdHex(),
      teamId: user.teamId,
      occurredAt: now,
      type: orig.type === 'income' ? 'expense' : 'income',
      status: 'active',
      amountCents: orig.amountCents,
      category: orig.category,
      counterparty: orig.counterparty,
      note: rawBody?.note?.trim() || `冲正记录 ${orig.id}`,
      proofFileName: null,
      proofFileMimeType: null,
      proofFileBase64: null,
      createdBy: user.userId,
      reversalOfEntryId: orig.id,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      createdAt: now,
      updatedAt: now,
    });
    return this.ledgerRepo.save(rev);
  }

  @Get('team-ledger/admin/summary')
  @PunchAdminOnly()
  async ledgerSummary(@PunchCurrentUser() user: PunchAuthUser) {
    const rows = await this.ledgerRepo.find({
      where: { teamId: user.teamId, status: 'active' },
    });
    let incomeCents = 0;
    let expenseCents = 0;
    for (const r of rows) {
      if (r.type === 'income') incomeCents += r.amountCents;
      else expenseCents += r.amountCents;
    }
    return {
      incomeCents,
      expenseCents,
      balanceCents: incomeCents - expenseCents,
      count: rows.length,
    };
  }

  @Get('team-ledger/admin/export')
  @PunchAdminOnly()
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportLedger(@PunchCurrentUser() user: PunchAuthUser) {
    const rows = await this.ledgerRepo.find({
      where: { teamId: user.teamId },
      order: { occurredAt: 'DESC' },
    });
    const lines = ['id,occurredAt,type,status,amountCents,category,counterparty,note'];
    for (const r of rows) {
      lines.push(
        [
          r.id,
          r.occurredAt.toISOString(),
          r.type,
          r.status,
          r.amountCents,
          r.category,
          r.counterparty ?? '',
          (r.note ?? '').replace(/[\r\n,]/g, ' '),
        ].join(','),
      );
    }
    return lines.join('\n');
  }

  // ── 举报反馈 (/reports*) ──

  @Post('reports')
  async createReport(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const input = CreateReportSchema.parse(rawBody);
    const now = new Date();
    const rec = this.reportRepo.create({
      id: newObjectIdHex(),
      teamId: user.teamId,
      reporterUserId: user.userId,
      reporterUsername: user.username,
      reporterDisplayName: user.displayName,
      description: input.description,
      images: [],
      imagesExpireAt: null,
      imagesPurgedAt: null,
      requestKey: input.requestKey ?? null,
      requestHash: null,
      notificationPending: false,
      processingStatus: 'open',
      processingNote: null,
      processedBy: null,
      processedByDisplayName: null,
      processedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    return this.reportRepo.save(rec);
  }

  @Get('reports/admin')
  @PunchAdminOnly()
  async listReports(
    @PunchCurrentUser() user: PunchAuthUser,
    @Query('page') rawPage?: string,
    @Query('pageSize') rawSize?: string,
  ) {
    const page = Math.max(1, Number.parseInt(rawPage ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(rawSize ?? '20', 10) || 20));
    const [items, total] = await this.reportRepo.findAndCount({
      where: { teamId: user.teamId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }

  @Patch('reports/admin/:reportId')
  @PunchAdminOnly()
  async processReport(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('reportId') reportId: string,
    @Body() rawBody: { processingStatus?: 'open' | 'processed'; processingNote?: string },
  ) {
    const rec = await this.reportRepo.findOne({
      where: { id: reportId.trim(), teamId: user.teamId },
    });
    if (!rec) throw new NotFoundException('反馈记录不存在');
    const now = new Date();
    rec.processingStatus = rawBody.processingStatus ?? 'processed';
    rec.processingNote = rawBody.processingNote?.trim() ?? rec.processingNote;
    rec.processedBy = user.userId;
    rec.processedByDisplayName = user.displayName;
    rec.processedAt = now;
    rec.updatedAt = now;
    return this.reportRepo.save(rec);
  }

  // ── LecPunch 站内通知 (/notifications/*) ──

  @Get('notifications/me')
  async myNotifications(@PunchCurrentUser() user: PunchAuthUser) {
    const items = await this.notifRepo
      .createQueryBuilder('n')
      .where('n.team_id = :teamId', { teamId: user.teamId })
      .andWhere('(n.user_id = :uid OR n.audience = :all)', {
        uid: user.userId,
        all: 'team_members',
      })
      .orderBy('n.created_at', 'DESC')
      .take(80)
      .getMany();
    return { items };
  }

  @Get('notifications/me/unread-count')
  async unreadCount(@PunchCurrentUser() user: PunchAuthUser) {
    const count = await this.notifRepo.count({
      where: { teamId: user.teamId, userId: user.userId, acknowledgedAt: null as unknown as Date },
    });
    return { count };
  }

  @Patch('notifications/:notificationId/ack')
  async ackNotification(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('notificationId') notificationId: string,
  ) {
    const now = new Date();
    await this.notifRepo.update(
      { id: notificationId.trim(), teamId: user.teamId, userId: user.userId },
      { acknowledgedAt: now },
    );
    await this.receiptRepo.query(
      `INSERT INTO punch_notification_receipts (id, notification_id, user_id, team_id, read_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (notification_id, user_id) DO NOTHING`,
      [newObjectIdHex(), notificationId.trim(), user.userId, user.teamId, now],
    );
    return { ok: true };
  }

  @Post('notifications/admin/notices')
  @PunchAdminOnly()
  createAdminNotice(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const input = AdminNoticeSchema.parse(rawBody);
    const id = newObjectIdHex();
    const rec = this.notifRepo.create({
      id,
      teamId: user.teamId,
      userId: null,
      audience: input.audience,
      recipientUserIds: null,
      deliveryKey: null,
      requestHash: null,
      type: 'admin.notice',
      title: input.title,
      message: input.message,
      payload: {},
      sourceType: 'admin_notice',
      sourceId: id,
      createdBy: user.userId,
      acknowledgedAt: null,
      createdAt: new Date(),
    });
    return this.notifRepo.save(rec);
  }

  @Get('notifications/preferences')
  async getPreferences(@PunchCurrentUser() user: PunchAuthUser) {
    const m = await this.userRepo.findOne({ where: { id: user.userId } });
    return { adminMessageBadgeEnabled: m?.adminMessageBadgeEnabled ?? true };
  }

  @Patch('notifications/preferences')
  async updatePreferences(
    @PunchCurrentUser() user: PunchAuthUser,
    @Body() rawBody: { adminMessageBadgeEnabled?: boolean },
  ) {
    if (typeof rawBody?.adminMessageBadgeEnabled !== 'boolean') {
      throw new BadRequestException('请提供 adminMessageBadgeEnabled 布尔值');
    }
    await this.userRepo.update(
      { id: user.userId },
      { adminMessageBadgeEnabled: rawBody.adminMessageBadgeEnabled, updatedAt: new Date() },
    );
    return { adminMessageBadgeEnabled: rawBody.adminMessageBadgeEnabled };
  }

  // ── 局域网会议 Token (/meet/token) ──

  @Get('meet/token')
  getMeetToken(@PunchCurrentUser() user: PunchAuthUser) {
    const secret = this.cfg.internalServiceToken || 'lec-meet-local-secret';
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(
      JSON.stringify({ sub: user.userId, name: user.displayName, teamId: user.teamId, exp }),
      'utf8',
    ).toString('base64url');
    const sig = createHmac('sha256', secret).update(payload).digest('base64url');
    return { token: `${payload}.${sig}`, expiresAt: exp * 1000 };
  }
}
