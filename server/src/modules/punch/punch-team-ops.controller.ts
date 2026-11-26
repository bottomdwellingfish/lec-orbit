/**
 * 团队协作运维模块（PostgreSQL TypeORM 版）：
 * 完整承接 LecPunch 的团队活动 (/team-events/*)、财务账本 (/team-ledger/*)、
 * 反馈举报 (/reports*)、站内通知 (/notifications/*) 与局域网会议 (/meet/token)。
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Inject,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnsupportedMediaTypeException,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-node';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import { S3StorageService } from '../storage/s3-storage.service.js';
import {
  PunchNotificationEntity,
  PunchNotificationReceiptEntity,
  PunchReportEntity,
  PunchTeamEventEntity,
  PunchTeamLedgerEntryEntity,
  type PunchReportImageMeta,
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
  requestKey: z.string().max(128).optional(),
});

const ALLOWED_REPORT_IMAGE_TYPES = new Map<string, string>([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

const REPORT_IMAGE_FILENAME_RE = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

interface UploadedBinaryFile {
  buffer?: Buffer;
  mimetype?: string;
  size?: number;
}

interface SseSubscriber {
  user: PunchAuthUser;
  send: (event: string, data: unknown) => void;
}

/** 校验上传图片的文件头魔数，防止伪造 MIME 类型上传非图片内容。 */
function matchesImageMagic(buf: Buffer, mime: string): boolean {
  if (buf.length < 12) return false;
  if (mime === 'image/jpeg') {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (mime === 'image/png') {
    return (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    );
  }
  if (mime === 'image/webp') {
    return buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

/** 按东八区提取账本聚合桶键（YYYY-MM-DD 或 YYYY-MM）。 */
function formatShanghaiBucket(date: Date, granularity: 'day' | 'month'): string {
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  if (granularity === 'month') return `${yyyy}-${mm}`;
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

@Controller()
@UseGuards(PunchAuthGuard)
export class PunchTeamOpsController implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PunchTeamOpsController.name);
  private readonly sseSubscribers = new Set<SseSubscriber>();
  private reportCleanupTimer?: ReturnType<typeof setInterval>;

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
    private readonly s3Storage: S3StorageService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.cfg.nodeEnv === 'test') return;
    await this.cleanupExpiredReportImages().catch(() => undefined);
    this.reportCleanupTimer = setInterval(() => {
      void this.cleanupExpiredReportImages().catch(() => undefined);
    }, 60_000);
    this.reportCleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.reportCleanupTimer) clearInterval(this.reportCleanupTimer);
  }

  /** 定期清理私有对象存储中已过期的举报图片并回写 images_purged_at。 */
  async cleanupExpiredReportImages(): Promise<number> {
    if (!this.s3Storage.isPunchPrivateConfigured()) return 0;
    const now = new Date();
    const expired = await this.reportRepo
      .createQueryBuilder('r')
      .where('r.images_expire_at IS NOT NULL AND r.images_expire_at <= :now AND r.images_purged_at IS NULL', {
        now,
      })
      .take(50)
      .getMany();

    let purgedCount = 0;
    const prefix = this.cfg.punchStorage.reportImagesPrefix;
    for (const report of expired) {
      try {
        for (const img of report.images ?? []) {
          if (REPORT_IMAGE_FILENAME_RE.test(img.filename)) {
            await this.s3Storage.deletePunchPrivateObject(`${prefix}/${img.filename}`);
          }
        }
        report.imagesPurgedAt = now;
        report.updatedAt = now;
        await this.reportRepo.save(report);
        purgedCount += 1;
      } catch (err) {
        this.logger.warn(
          `清理举报 ${report.id} 过期图片失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return purgedCount;
  }

  /** 向在线的 SSE 客户端广播通知变更事件（不携带敏感正文，由前端重新拉取鉴权接口）。 */
  private broadcastNotificationChange(teamId: string, opts?: { userId?: string; adminOnly?: boolean }): void {
    for (const sub of this.sseSubscribers) {
      if (sub.user.teamId !== teamId) continue;
      if (opts?.userId && sub.user.userId !== opts.userId) continue;
      if (opts?.adminOnly && sub.user.role !== 'admin') continue;
      try {
        sub.send('notifications.changed', {});
      } catch {
        this.sseSubscribers.delete(sub);
      }
    }
  }

  // ── 团队活动 (/team-events/*) ──

  @Get('team-events/events')
  async listPublicEvents(@PunchCurrentUser() user: PunchAuthUser) {
    const items = await this.eventRepo.find({
      where: { teamId: user.teamId },
      order: { eventAt: 'DESC' },
      take: 100,
    });
    return { items };
  }

  @Get('team-events/admin/events')
  @PunchAdminOnly()
  async listAdminEvents(@PunchCurrentUser() user: PunchAuthUser) {
    const items = await this.eventRepo.find({
      where: { teamId: user.teamId },
      order: { eventAt: 'DESC' },
      take: 200,
    });
    return { items };
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
  async listLedger(
    @PunchCurrentUser() user: PunchAuthUser,
    @Query('from') rawFrom?: string,
    @Query('to') rawTo?: string,
    @Query('type') rawType?: string,
    @Query('status') rawStatus?: string,
    @Query('category') rawCategory?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const limit = Math.min(Math.max(Number.parseInt(rawLimit ?? '100', 10) || 100, 1), 500);
    const qb = this.ledgerRepo
      .createQueryBuilder('e')
      .where('e.team_id = :teamId', { teamId: user.teamId });

    if (rawType === 'income' || rawType === 'expense') {
      qb.andWhere('e.type = :type', { type: rawType });
    }
    if (rawStatus === 'active' || rawStatus === 'voided') {
      qb.andWhere('e.status = :status', { status: rawStatus });
    }
    if (rawCategory?.trim()) {
      qb.andWhere('e.category = :category', { category: rawCategory.trim() });
    }
    if (rawFrom) {
      const fromDate = new Date(rawFrom);
      if (!Number.isNaN(fromDate.getTime())) qb.andWhere('e.occurred_at >= :from', { from: fromDate });
    }
    if (rawTo) {
      const toDate = new Date(rawTo);
      if (!Number.isNaN(toDate.getTime())) qb.andWhere('e.occurred_at <= :to', { to: toDate });
    }

    const items = await qb
      .orderBy('e.occurred_at', 'DESC')
      .addOrderBy('e.created_at', 'DESC')
      .take(limit)
      .getMany();
    return { items };
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
  async ledgerSummary(
    @PunchCurrentUser() user: PunchAuthUser,
    @Query('from') rawFrom?: string,
    @Query('to') rawTo?: string,
    @Query('status') rawStatus?: string,
  ) {
    const qb = this.ledgerRepo
      .createQueryBuilder('e')
      .where('e.team_id = :teamId', { teamId: user.teamId });

    if (rawStatus === 'voided') {
      qb.andWhere('e.status = :status', { status: 'voided' });
    } else if (rawStatus !== 'all') {
      qb.andWhere('e.status = :status', { status: 'active' });
    }
    if (rawFrom) {
      const fromDate = new Date(rawFrom);
      if (!Number.isNaN(fromDate.getTime())) qb.andWhere('e.occurred_at >= :from', { from: fromDate });
    }
    if (rawTo) {
      const toDate = new Date(rawTo);
      if (!Number.isNaN(toDate.getTime())) qb.andWhere('e.occurred_at <= :to', { to: toDate });
    }

    const rows = await qb.getMany();
    let incomeCents = 0;
    let expenseCents = 0;
    for (const r of rows) {
      if (r.type === 'income') incomeCents += r.amountCents;
      else expenseCents += r.amountCents;
    }
    const netCents = incomeCents - expenseCents;
    return {
      incomeCents,
      expenseCents,
      netCents,
      balanceCents: netCents,
      entryCount: rows.length,
      count: rows.length,
    };
  }

  @Get('team-ledger/admin/trend')
  @PunchAdminOnly()
  async ledgerTrend(
    @PunchCurrentUser() user: PunchAuthUser,
    @Query('granularity') rawGranularity?: string,
    @Query('from') rawFrom?: string,
    @Query('to') rawTo?: string,
    @Query('type') rawType?: string,
    @Query('category') rawCategory?: string,
  ) {
    const granularity: 'day' | 'month' = rawGranularity === 'day' ? 'day' : 'month';
    const qb = this.ledgerRepo
      .createQueryBuilder('e')
      .where('e.team_id = :teamId', { teamId: user.teamId })
      .andWhere('e.status = :status', { status: 'active' });

    if (rawType === 'income' || rawType === 'expense') {
      qb.andWhere('e.type = :type', { type: rawType });
    }
    if (rawCategory?.trim()) {
      qb.andWhere('e.category = :category', { category: rawCategory.trim() });
    }
    if (rawFrom) {
      const fromDate = new Date(rawFrom);
      if (!Number.isNaN(fromDate.getTime())) qb.andWhere('e.occurred_at >= :from', { from: fromDate });
    }
    if (rawTo) {
      const toDate = new Date(rawTo);
      if (!Number.isNaN(toDate.getTime())) qb.andWhere('e.occurred_at <= :to', { to: toDate });
    }

    const rows = await qb.orderBy('e.occurred_at', 'ASC').getMany();
    const buckets = new Map<
      string,
      { bucketKey: string; incomeCents: number; expenseCents: number; netCents: number; entryCount: number }
    >();

    for (const r of rows) {
      const key = formatShanghaiBucket(r.occurredAt, granularity);
      const bucket = buckets.get(key) ?? {
        bucketKey: key,
        incomeCents: 0,
        expenseCents: 0,
        netCents: 0,
        entryCount: 0,
      };
      if (r.type === 'income') bucket.incomeCents += r.amountCents;
      else bucket.expenseCents += r.amountCents;
      bucket.netCents = bucket.incomeCents - bucket.expenseCents;
      bucket.entryCount += 1;
      buckets.set(key, bucket);
    }

    return {
      items: [...buckets.values()].sort((a, b) => a.bucketKey.localeCompare(b.bucketKey)),
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
  @UseInterceptors(
    FilesInterceptor('images', 3, {
      limits: { fileSize: 3 * 1024 * 1024, files: 3 },
    }),
  )
  async createReport(
    @PunchCurrentUser() user: PunchAuthUser,
    @Body() rawBody: unknown,
    @UploadedFiles() rawFiles: UploadedBinaryFile[] = [],
  ) {
    const input = CreateReportSchema.parse(rawBody);
    const files = Array.isArray(rawFiles) ? rawFiles.filter((f) => f?.buffer && f.buffer.length > 0) : [];
    if (files.length > 3) {
      throw new UnsupportedMediaTypeException('最多上传 3 张图片');
    }

    for (const f of files) {
      const mime = f.mimetype ?? '';
      if (!ALLOWED_REPORT_IMAGE_TYPES.has(mime) || !f.buffer || !matchesImageMagic(f.buffer, mime)) {
        throw new UnsupportedMediaTypeException('仅支持上传 JPEG / PNG / WebP 格式图片（单张不超过 3MB）');
      }
    }

    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          description: input.description,
          files: files.map((f) => ({
            type: f.mimetype,
            digest: createHash('sha256').update(f.buffer!).digest('hex'),
          })),
        }),
      )
      .digest('hex');

    if (input.requestKey) {
      const existing = await this.reportRepo.findOne({
        where: { teamId: user.teamId, reporterUserId: user.userId, requestKey: input.requestKey },
      });
      if (existing) {
        if (existing.requestHash && existing.requestHash !== requestHash) {
          throw new ConflictException('同一请求标识不能提交不同消息');
        }
        return existing;
      }
    }

    const uploaded: PunchReportImageMeta[] = [];
    const prefix = this.cfg.punchStorage.reportImagesPrefix;
    try {
      for (const f of files) {
        const id = randomUUID();
        const ext = ALLOWED_REPORT_IMAGE_TYPES.get(f.mimetype!)!;
        const filename = `${id}${ext}`;
        await this.s3Storage.putPunchPrivateObject(`${prefix}/${filename}`, f.buffer!, f.mimetype!);
        uploaded.push({
          id,
          filename,
          contentType: f.mimetype!,
          sizeBytes: f.buffer!.length,
        });
      }
    } catch (err) {
      await Promise.all(
        uploaded.map((img) => this.s3Storage.deletePunchPrivateObject(`${prefix}/${img.filename}`)),
      );
      throw err;
    }

    const now = new Date();
    const retentionMs = this.cfg.punchStorage.reportImageRetentionHours * 3600 * 1000;
    const imagesExpireAt = uploaded.length > 0 ? new Date(now.getTime() + retentionMs) : null;

    const rec = this.reportRepo.create({
      id: newObjectIdHex(),
      teamId: user.teamId,
      reporterUserId: user.userId,
      reporterUsername: user.username,
      reporterDisplayName: user.displayName,
      description: input.description,
      images: uploaded,
      imagesExpireAt,
      imagesPurgedAt: null,
      requestKey: input.requestKey ?? null,
      requestHash,
      notificationPending: false,
      processingStatus: 'open',
      processingNote: null,
      processedBy: null,
      processedByDisplayName: null,
      processedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const saved = await this.reportRepo.save(rec);

    // 同步向管理员生成站内提醒并触发 SSE 刷新
    const notifId = newObjectIdHex();
    await this.notifRepo.save(
      this.notifRepo.create({
        id: notifId,
        teamId: user.teamId,
        userId: null,
        audience: 'team_admin',
        recipientUserIds: null,
        deliveryKey: `report:${saved.id}`,
        requestHash: null,
        type: 'report.submitted',
        title: `${user.displayName} 提交了新反馈`,
        message: input.description.slice(0, 120),
        payload: {
          reportId: saved.id,
          imageCount: uploaded.length,
          imagesExpireAt: imagesExpireAt?.toISOString() ?? null,
        },
        sourceType: 'report',
        sourceId: saved.id,
        createdBy: user.userId,
        acknowledgedAt: null,
        createdAt: now,
      }),
    );
    this.broadcastNotificationChange(user.teamId, { adminOnly: true });

    return saved;
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
    @Body() rawBody: { status?: 'open' | 'processed'; note?: string; processingStatus?: 'open' | 'processed'; processingNote?: string },
  ) {
    const rec = await this.reportRepo.findOne({
      where: { id: reportId.trim(), teamId: user.teamId },
    });
    if (!rec) throw new NotFoundException('反馈记录不存在');
    const now = new Date();
    rec.processingStatus = rawBody.processingStatus ?? rawBody.status ?? 'processed';
    const nextNote = rawBody.processingNote ?? rawBody.note;
    if (nextNote !== undefined) rec.processingNote = nextNote.trim();
    rec.processedBy = user.userId;
    rec.processedByDisplayName = user.displayName;
    rec.processedAt = now;
    rec.updatedAt = now;
    return this.reportRepo.save(rec);
  }

  @Get('reports/admin/:reportId/images/:imageId')
  @PunchAdminOnly()
  async getReportImage(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('reportId') reportId: string,
    @Param('imageId') imageId: string,
    @Res() res: ServerResponse,
  ) {
    const report = await this.reportRepo.findOne({
      where: { id: reportId.trim(), teamId: user.teamId },
    });
    if (!report) throw new NotFoundException('反馈记录不存在');

    if (report.imagesExpireAt && report.imagesExpireAt.getTime() <= Date.now()) {
      throw new NotFoundException('举报图片已过期清理');
    }

    const image = (report.images ?? []).find((c) => c.id === imageId.trim());
    if (!image || !REPORT_IMAGE_FILENAME_RE.test(image.filename)) {
      throw new NotFoundException('举报图片不存在');
    }

    const key = `${this.cfg.punchStorage.reportImagesPrefix}/${image.filename}`;
    const obj = await this.s3Storage.getPunchPrivateObject(key);
    if (!obj) {
      throw new NotFoundException('举报图片不存在');
    }

    res.setHeader('Content-Type', image.contentType || obj.contentType);
    res.setHeader('Content-Length', String(obj.body.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(obj.body);
  }

  // ── LecPunch 站内通知 (/notifications/*) ──

  /** 查询当前用户可见的通知及合并回执表（punch_notification_receipts）后的真实已读状态。 */
  private async queryScopedNotificationsWithAck(
    user: PunchAuthUser,
    opts?: { status?: 'unacked' | 'all'; limit?: number; before?: string },
  ) {
    const rawRows = await this.notifRepo
      .createQueryBuilder('n')
      .where('n.team_id = :teamId', { teamId: user.teamId })
      .andWhere(
        user.role === 'admin'
          ? '(n.user_id = :uid OR n.audience IN (:...audiences))'
          : "(n.type <> 'report.submitted' AND (n.user_id = :uid OR n.audience = :all))",
        {
          uid: user.userId,
          all: 'team_members',
          audiences: ['team_members', 'team_admin'],
        },
      )
      .orderBy('n.created_at', 'DESC')
      .addOrderBy('n.id', 'DESC')
      .take(300)
      .getMany();

    // 过滤限定接收人列表的群发通知（与原 LecPunch scope 语义完全一致）
    const scoped = rawRows.filter((n) => {
      if (n.audience === 'team_members') {
        if (Array.isArray(n.recipientUserIds) && n.recipientUserIds.length > 0) {
          return n.recipientUserIds.includes(user.userId);
        }
        return true;
      }
      if (n.audience === 'team_admin') {
        return user.role === 'admin';
      }
      return n.userId === user.userId;
    });

    if (scoped.length === 0) return [];

    const receipts = await this.receiptRepo.find({
      where: {
        teamId: user.teamId,
        userId: user.userId,
        notificationId: In(scoped.map((n) => n.id)),
      },
    });
    const receiptByNotifId = new Map(receipts.map((r) => [r.notificationId, r.readAt]));

    let merged = scoped.map((n) => {
      // 群发通知的已读状态必须取 punch_notification_receipts，绝不能只看主表 acknowledged_at
      const effectiveAck =
        receiptByNotifId.get(n.id) ?? (n.userId === user.userId ? n.acknowledgedAt : null);
      return {
        id: n.id,
        teamId: n.teamId,
        userId: n.userId,
        audience: n.audience,
        type: n.type,
        title: n.title,
        message: n.message,
        payload: n.payload,
        sourceType: n.sourceType,
        sourceId: n.sourceId,
        createdBy: n.createdBy,
        createdAt: n.createdAt.toISOString(),
        acknowledgedAt: effectiveAck ? effectiveAck.toISOString() : null,
      };
    });

    if (opts?.before) {
      const idx = merged.findIndex((i) => i.id === opts.before);
      if (idx >= 0) merged = merged.slice(idx + 1);
    }

    if (opts?.status === 'unacked') {
      merged = merged.filter((i) => i.acknowledgedAt === null);
    }

    const limit = Math.min(Math.max(opts?.limit ?? 80, 1), 100);
    return merged.slice(0, limit);
  }

  @Get('notifications/me')
  async myNotifications(
    @PunchCurrentUser() user: PunchAuthUser,
    @Query('status') rawStatus?: string,
    @Query('limit') rawLimit?: string,
    @Query('before') before?: string,
  ) {
    const status: 'unacked' | 'all' = rawStatus === 'all' ? 'all' : 'unacked';
    const limit = Math.min(Math.max(Number.parseInt(rawLimit ?? '20', 10) || 20, 1), 100);
    const items = await this.queryScopedNotificationsWithAck(user, {
      status,
      limit,
      before: before?.trim() || undefined,
    });
    return { items, nextCursor: items[items.length - 1]?.id ?? null };
  }

  @Get('notifications/me/unread-count')
  async unreadCount(@PunchCurrentUser() user: PunchAuthUser) {
    const [unacked, member] = await Promise.all([
      this.queryScopedNotificationsWithAck(user, { status: 'unacked', limit: 100 }),
      this.userRepo.findOne({ where: { id: user.userId } }),
    ]);
    const count = unacked.length;
    const badgeCount =
      member?.adminMessageBadgeEnabled === false
        ? unacked.filter((n) => n.type !== 'report.submitted').length
        : count;
    return { count, badgeCount };
  }

  @Patch('notifications/:notificationId/ack')
  async ackNotification(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('notificationId') notificationId: string,
  ) {
    const cleanId = notificationId.trim();
    const notice = await this.notifRepo.findOne({
      where: { id: cleanId, teamId: user.teamId },
    });
    if (!notice) {
      throw new NotFoundException('通知不存在');
    }

    const now = new Date();
    // 个人通知同时更新主表 acknowledged_at，群发通知仅写 punch_notification_receipts
    if (notice.userId === user.userId && !notice.acknowledgedAt) {
      await this.notifRepo.update(
        { id: cleanId, teamId: user.teamId, userId: user.userId },
        { acknowledgedAt: now },
      );
    }
    await this.receiptRepo.query(
      `INSERT INTO punch_notification_receipts (id, notification_id, user_id, team_id, read_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (notification_id, user_id) DO NOTHING`,
      [newObjectIdHex(), cleanId, user.userId, user.teamId, now],
    );
    const receipt = await this.receiptRepo.findOne({
      where: { notificationId: cleanId, userId: user.userId },
    });
    const effectiveAck = notice.acknowledgedAt ?? receipt?.readAt ?? now;
    this.broadcastNotificationChange(user.teamId, { userId: user.userId });
    return {
      id: notice.id,
      teamId: notice.teamId,
      userId: notice.userId,
      audience: notice.audience,
      type: notice.type,
      title: notice.title,
      message: notice.message,
      payload: notice.payload,
      sourceType: notice.sourceType,
      sourceId: notice.sourceId,
      createdBy: notice.createdBy,
      createdAt: notice.createdAt.toISOString(),
      acknowledgedAt: effectiveAck.toISOString(),
    };
  }

  @Post('notifications/admin/notices')
  @PunchAdminOnly()
  async createAdminNotice(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const input = AdminNoticeSchema.parse(rawBody);
    const deliveryKey = input.requestKey
      ? `notice:${user.teamId}:${user.userId}:${input.requestKey}`
      : null;
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          title: input.title,
          message: input.message,
          audience: input.audience,
        }),
      )
      .digest('hex');

    if (deliveryKey) {
      const existing = await this.notifRepo.findOne({ where: { deliveryKey } });
      if (existing) {
        if (existing.requestHash && existing.requestHash !== requestHash) {
          throw new ConflictException('同一请求标识不能发送不同的群发通知');
        }
        return existing;
      }
    }

    const id = newObjectIdHex();
    const members = await this.userRepo.find({ where: { teamId: user.teamId, status: 'active' } });
    const recipientUserIds = members.filter((m) => Boolean(m.logtoUserId)).map((m) => m.id);
    const rec = this.notifRepo.create({
      id,
      teamId: user.teamId,
      userId: null,
      audience: input.audience,
      recipientUserIds,
      deliveryKey,
      requestHash,
      type: 'admin.notice',
      title: input.title,
      message: input.message,
      payload: { noticeId: randomUUID() },
      sourceType: 'admin_notice',
      sourceId: input.requestKey ?? id,
      createdBy: user.userId,
      acknowledgedAt: null,
      createdAt: new Date(),
    });
    const saved = await this.notifRepo.save(rec);
    this.broadcastNotificationChange(user.teamId);
    return saved;
  }

  @Get('notifications/admin/sent')
  @PunchAdminOnly()
  async listSentNotices(@PunchCurrentUser() user: PunchAuthUser) {
    const rows = await this.notifRepo.find({
      where: {
        teamId: user.teamId,
        createdBy: user.userId,
        type: In(['admin.notice', 'attendance.record_marked']),
      },
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return rows.map((row) => ({
      id: row.id,
      teamId: row.teamId,
      userId: row.userId,
      audience: row.audience,
      type: row.type,
      title: row.title,
      message: row.message,
      payload: row.payload,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
    }));
  }

  @Get('notifications/admin/:notificationId/read-status')
  @PunchAdminOnly()
  async getNoticeReadStatus(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('notificationId') notificationId: string,
  ) {
    const notice = await this.notifRepo.findOne({
      where: {
        id: notificationId.trim(),
        teamId: user.teamId,
        type: In(['admin.notice', 'attendance.record_marked']),
      },
    });
    if (!notice) throw new NotFoundException('通知不存在');

    const recipientIds =
      notice.audience === 'team_members'
        ? (notice.recipientUserIds ?? [])
        : notice.userId
          ? [notice.userId]
          : [];

    const [members, receipts] = await Promise.all([
      recipientIds.length > 0
        ? this.userRepo.find({ where: { id: In(recipientIds), teamId: user.teamId } })
        : Promise.resolve([]),
      this.receiptRepo.find({ where: { notificationId: notice.id, teamId: user.teamId } }),
    ]);

    const memberById = new Map(members.map((m) => [m.id, m]));
    const readByUser = new Map(receipts.map((r) => [r.userId, r.readAt]));

    return recipientIds.map((uid) => {
      const readAt = readByUser.get(uid) ?? (uid === notice.userId ? notice.acknowledgedAt : null);
      return {
        userId: uid,
        displayName: memberById.get(uid)?.displayName ?? '已移除成员',
        readAt: readAt ? readAt.toISOString() : null,
      };
    });
  }

  @Get('notifications/stream')
  streamNotifications(
    @PunchCurrentUser() user: PunchAuthUser,
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    const writeEvent = (event: string, data: unknown) => {
      if (closed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const subscriber: SseSubscriber = { user, send: writeEvent };
    this.sseSubscribers.add(subscriber);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(maxLifetime);
      this.sseSubscribers.delete(subscriber);
      if (!res.writableEnded) res.end();
    };

    const heartbeat = setInterval(() => {
      if (closed) return;
      writeEvent('heartbeat', {});
    }, 30_000);
    heartbeat.unref();

    // 最长保持 1 小时连接后由前端 EventSource 自动重连刷新鉴权态
    const maxLifetime = setTimeout(cleanup, 3600 * 1000);
    maxLifetime.unref();

    req.on('close', cleanup);
    writeEvent('connected', {});
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
    const secret = this.cfg.meetJwtSecret || this.cfg.internalServiceToken || 'lec-meet-local-secret';
    const appId = this.cfg.meetJwtAppId || 'lec-meet';
    const nowSec = Math.floor(Date.now() / 1000);
    const exp = nowSec + 3600;
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: appId,
        aud: 'jitsi',
        sub: user.userId,
        room: '*',
        iat: nowSec,
        exp,
        context: { user: { id: user.userId, name: user.displayName, email: '' } },
      }),
      'utf8',
    ).toString('base64url');
    const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    return { token: `${header}.${payload}.${sig}`, expiresAt: exp * 1000 };
  }
}
