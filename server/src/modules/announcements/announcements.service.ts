import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { sanitizeAnnouncementHtml } from '../../common/utils/html-sanitizer.js';
import type { AuthUser } from '../auth/auth.types.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RealtimeHub } from '../realtime/realtime.hub.js';
import { RosterService } from '../roster/roster.service.js';
import { S3StorageService } from '../storage/s3-storage.service.js';
import { AnnouncementEntity } from './entities/announcement.entity.js';
import { AnnouncementReceiptEntity } from './entities/announcement-receipt.entity.js';

export interface AnnouncementDTO {
  id: string;
  title: string;
  contentHtml: string;
  contentText: string;
  pinned: boolean;
  authorId: string;
  authorName: string;
  authorAvatar: string;
  readCount: number;
  totalCount: number;
  isReadByMe: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 通过文件头魔数检测图片真实格式，防止伪造 MIME。 */
export function detectImageType(buf: Buffer): { contentType: string; ext: string } | null {
  if (buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { contentType: 'image/png', ext: '.png' };
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { contentType: 'image/jpeg', ext: '.jpg' };
  }
  // GIF: GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { contentType: 'image/gif', ext: '.gif' };
  }
  // WEBP: RIFF....WEBP
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { contentType: 'image/webp', ext: '.webp' };
  }
  return null;
}

@Injectable()
export class AnnouncementsService {
  constructor(
    @InjectRepository(AnnouncementEntity)
    private readonly annRepo: Repository<AnnouncementEntity>,
    @InjectRepository(AnnouncementReceiptEntity)
    private readonly receiptRepo: Repository<AnnouncementReceiptEntity>,
    private readonly roster: RosterService,
    private readonly notifications: NotificationsService,
    private readonly hub: RealtimeHub,
    private readonly s3: S3StorageService,
  ) {}

  async list(userId: string): Promise<AnnouncementDTO[]> {
    const total = await this.roster.countActive();
    const rows = (await this.annRepo.query(
      `SELECT a.id::text AS id, a.title, a.content_html AS "contentHtml", a.content_text AS "contentText",
              a.pinned, a.author_id AS "authorId", a.author_name AS "authorName", a.author_avatar AS "authorAvatar",
              a.created_at AS "createdAt", a.updated_at AS "updatedAt",
              (SELECT COUNT(*)::int FROM announcement_receipts r
               JOIN orbit_members m ON m.user_id = r.user_id AND m.is_active = TRUE
               WHERE r.announcement_id = a.id) AS "readCount",
              EXISTS (SELECT 1 FROM announcement_receipts r WHERE r.announcement_id = a.id AND r.user_id = $1) AS "isReadByMe"
       FROM announcements a
       WHERE a.deleted_at IS NULL
       ORDER BY a.pinned DESC, a.created_at DESC
       LIMIT 50`,
      [userId],
    )) as Array<{
      id: string;
      title: string;
      contentHtml: string;
      contentText: string;
      pinned: boolean;
      authorId: string;
      authorName: string;
      authorAvatar: string;
      createdAt: Date;
      updatedAt: Date;
      readCount: number;
      isReadByMe: boolean;
    }>;

    return rows.map((r) => {
      const readCount = Number(r.readCount ?? 0);
      return {
        id: r.id,
        title: r.title,
        contentHtml: r.contentHtml,
        contentText: r.contentText,
        pinned: Boolean(r.pinned),
        authorId: r.authorId,
        authorName: r.authorName,
        authorAvatar: r.authorAvatar,
        readCount,
        totalCount: Math.max(total, readCount),
        isReadByMe: Boolean(r.isReadByMe),
        createdAt: new Date(r.createdAt).toISOString(),
        updatedAt: new Date(r.updatedAt).toISOString(),
      };
    });
  }

  async create(
    user: AuthUser,
    input: { title: string; contentHtml: string; pinned?: boolean },
  ): Promise<AnnouncementDTO> {
    const title = input.title.trim();
    const { safeHtml, plainText } = sanitizeAnnouncementHtml(input.contentHtml);
    if (!title || !safeHtml) {
      throw new BadRequestException('公告标题和正文不能为空');
    }

    const now = new Date();
    const id = randomUUID();
    const record = this.annRepo.create({
      id,
      title,
      contentHtml: safeHtml,
      contentText: plainText,
      pinned: Boolean(input.pinned),
      authorId: user.userId,
      authorName: user.displayName,
      authorAvatar: user.avatar,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    await this.annRepo.save(record);

    await this.receiptRepo.query(
      `INSERT INTO announcement_receipts (announcement_id, user_id, read_at)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [id, user.userId, now],
    );

    const total = await this.roster.countActive();
    const dto: AnnouncementDTO = {
      id,
      title: record.title,
      contentHtml: record.contentHtml,
      contentText: record.contentText,
      pinned: record.pinned,
      authorId: record.authorId,
      authorName: record.authorName,
      authorAvatar: record.authorAvatar,
      readCount: 1,
      totalCount: total,
      isReadByMe: true,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    void this.hub.broadcast({ type: 'announcement.created', payload: dto });
    return dto;
  }

  async update(
    id: string,
    input: { title?: string; contentHtml?: string; pinned?: boolean },
  ) {
    const record = await this.annRepo.findOne({ where: { id } });
    if (!record) throw new NotFoundException('公告不存在');

    if (input.title !== undefined && input.title.trim()) {
      record.title = input.title.trim();
    }
    if (input.contentHtml !== undefined) {
      const { safeHtml, plainText } = sanitizeAnnouncementHtml(input.contentHtml);
      if (safeHtml) {
        record.contentHtml = safeHtml;
        record.contentText = plainText;
      }
    }
    if (input.pinned !== undefined) {
      record.pinned = input.pinned;
    }
    record.updatedAt = new Date();
    await this.annRepo.save(record);

    void this.hub.broadcast({
      type: 'announcement.updated',
      payload: {
        id: record.id,
        title: record.title,
        contentHtml: record.contentHtml,
        contentText: record.contentText,
        pinned: record.pinned,
        updatedAt: record.updatedAt.toISOString(),
      },
    });
    return { ok: true, id: record.id, updatedAt: record.updatedAt.toISOString() };
  }

  async softDelete(id: string) {
    const res = await this.annRepo.softDelete({ id });
    if (!res.affected) {
      throw new NotFoundException('公告不存在或已删除');
    }
    void this.hub.broadcast({ type: 'announcement.deleted', payload: { id } });
    return { ok: true };
  }

  async markRead(user: AuthUser, id: string) {
    const now = new Date();
    await this.receiptRepo.query(
      `INSERT INTO announcement_receipts (announcement_id, user_id, read_at)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [id, user.userId, now],
    );

    const [row] = (await this.receiptRepo.query(
      `SELECT COUNT(*)::int AS cnt
       FROM announcement_receipts r
       JOIN orbit_members m ON m.user_id = r.user_id AND m.is_active = TRUE
       WHERE r.announcement_id = $1`,
      [id],
    )) as [{ cnt: number }];
    const readCount = Number(row?.cnt ?? 0);
    const totalCount = Math.max(await this.roster.countActive(), readCount);

    const payload = {
      announcementId: id,
      userId: user.userId,
      displayName: user.displayName,
      avatar: user.avatar,
      readAt: now.toISOString(),
      readCount,
      totalCount,
    };
    void this.hub.broadcast({ type: 'announcement.receipt', payload });
    return payload;
  }

  async getReceipts(id: string) {
    const rows = (await this.receiptRepo.query(
      `SELECT m.user_id AS "userId", m.username, m.display_name AS "displayName",
              m.avatar, m.is_captain AS "isCaptain", r.read_at AS "readAt"
       FROM orbit_members m
       LEFT JOIN announcement_receipts r
         ON r.user_id = m.user_id AND r.announcement_id = $1
       WHERE m.is_active = TRUE
       ORDER BY (r.read_at IS NULL) ASC, r.read_at ASC, m.display_name ASC`,
      [id],
    )) as Array<{
      userId: string;
      username: string;
      displayName: string;
      avatar: string;
      isCaptain: boolean;
      readAt: Date | null;
    }>;

    const read: unknown[] = [];
    const unread: unknown[] = [];
    for (const m of rows) {
      const item = {
        userId: m.userId,
        username: m.username,
        displayName: m.displayName,
        avatar: m.avatar,
        isCaptain: Boolean(m.isCaptain),
        ...(m.readAt ? { readAt: new Date(m.readAt).toISOString() } : {}),
      };
      if (m.readAt) read.push(item);
      else unread.push(item);
    }

    return {
      announcementId: id,
      readCount: read.length,
      unreadCount: unread.length,
      totalCount: read.length + unread.length,
      read,
      unread,
    };
  }

  async remindUnread(user: AuthUser, id: string) {
    const ann = await this.annRepo.findOne({ where: { id }, select: { id: true, title: true } });
    if (!ann) throw new NotFoundException('公告不存在');

    const unreadRows = (await this.annRepo.query(
      `SELECT m.user_id AS "userId"
       FROM orbit_members m
       WHERE m.is_active = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM announcement_receipts r
           WHERE r.announcement_id = $1 AND r.user_id = m.user_id
         )`,
      [id],
    )) as Array<{ userId: string }>;

    let remindedCount = 0;
    for (const row of unreadRows) {
      await this.notifications.createAndPush({
        sourceApp: 'orbit',
        eventType: 'announcement.remind',
        title: '队长提醒查阅公告',
        body: `${user.displayName} 提醒你阅读公告《${ann.title}》`,
        payload: { announcementId: id, title: ann.title },
        targetUserId: row.userId,
      });
      remindedCount += 1;
    }

    return { ok: true, remindedCount };
  }

  async uploadImage(buffer: Buffer): Promise<{ url: string }> {
    if (!this.s3.isConfigured()) {
      throw new ServiceUnavailableException('RustFS 对象存储尚未配置');
    }
    if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) {
      throw new BadRequestException('单张图片不能超过 10MB');
    }
    const detected = detectImageType(buffer);
    if (!detected) {
      throw new BadRequestException('仅支持 PNG / JPG / WEBP / GIF 图片');
    }
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const relKey = `announcements/${yyyy}/${mm}/${randomUUID()}${detected.ext}`;

    try {
      const url = await this.s3.putPublicObject(relKey, buffer, detected.contentType);
      return { url };
    } catch (err) {
      throw new BadGatewayException(err instanceof Error ? err.message : '上传图片失败');
    }
  }
}
