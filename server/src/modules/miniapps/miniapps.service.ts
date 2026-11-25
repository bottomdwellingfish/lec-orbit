import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RosterService } from '../roster/roster.service.js';
import { S3StorageService } from '../storage/s3-storage.service.js';
import { MiniAppEntity } from './entities/mini-app.entity.js';
import { MiniAppVersionEntity } from './entities/mini-app-version.entity.js';
import { MiniAppKvEntity } from './entities/mini-app-kv.entity.js';
import {
  isAllowedGitHubReleaseUrl,
  MINIAPP_MAX_BUNDLE_BYTES,
  normalizeAndValidateManifest,
  validateZipBundle,
  type MiniAppManifest,
} from './miniapp-validator.util.js';

const KV_MAX_VALUE_BYTES = 64 * 1024;
const KV_MAX_TOTAL_BYTES = 1024 * 1024;
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;

export interface MiniAppVersionDTO {
  id: string;
  appId: string;
  version: string;
  channel: string;
  status: string;
  sourceType: string;
  bundleUrl: string;
  bundleSha256: string;
  bundleSize: number;
  manifest: Record<string, unknown>;
  changelog: string;
  uploaderId: string;
  reviewerId?: string;
  reviewNote?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface MiniAppCatalogDTO {
  id: string;
  name: string;
  type: string;
  engine: string;
  description: string;
  iconUrl: string;
  tags: string[];
  ownerId: string;
  ownerName: string;
  ownerAvatar: string;
  status: string;
  featuredRank: number;
  playCount: number;
  activeVersion?: MiniAppVersionDTO;
  latestVersion?: MiniAppVersionDTO;
  createdAt: string;
  updatedAt: string;
}

function toVersionDTO(v: MiniAppVersionEntity): MiniAppVersionDTO {
  return {
    id: v.id,
    appId: v.appId,
    version: v.version,
    channel: v.channel,
    status: v.status,
    sourceType: v.sourceType,
    bundleUrl: v.bundleUrl,
    bundleSha256: v.bundleSha256,
    bundleSize: Number(v.bundleSize ?? 0),
    manifest: v.manifestJson ?? {},
    changelog: v.changelog,
    uploaderId: v.uploaderId,
    reviewerId: v.reviewerId ?? undefined,
    reviewNote: v.reviewNote ?? undefined,
    createdAt: new Date(v.createdAt).toISOString(),
    reviewedAt: v.reviewedAt ? new Date(v.reviewedAt).toISOString() : undefined,
  };
}

function toCatalogDTO(
  a: MiniAppEntity,
  active?: MiniAppVersionEntity,
  latest?: MiniAppVersionEntity,
): MiniAppCatalogDTO {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    engine: a.engine,
    description: a.description,
    iconUrl: a.iconUrl,
    tags: Array.isArray(a.tagsJson) ? a.tagsJson : [],
    ownerId: a.ownerId,
    ownerName: a.ownerName,
    ownerAvatar: a.ownerAvatar,
    status: a.status,
    featuredRank: a.featuredRank,
    playCount: Number(a.playCount ?? 0),
    activeVersion: active ? toVersionDTO(active) : undefined,
    latestVersion: latest ? toVersionDTO(latest) : undefined,
    createdAt: new Date(a.createdAt).toISOString(),
    updatedAt: new Date(a.updatedAt).toISOString(),
  };
}

@Injectable()
export class MiniAppsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(MiniAppEntity)
    private readonly appRepo: Repository<MiniAppEntity>,
    @InjectRepository(MiniAppVersionEntity)
    private readonly versionRepo: Repository<MiniAppVersionEntity>,
    @InjectRepository(MiniAppKvEntity)
    private readonly kvRepo: Repository<MiniAppKvEntity>,
    private readonly s3: S3StorageService,
    private readonly roster: RosterService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(
    user: AuthUser,
    query: { type?: string; engine?: string; q?: string; mine?: boolean; pending?: boolean },
  ): Promise<MiniAppCatalogDTO[]> {
    const qb = this.appRepo.createQueryBuilder('a');

    if (query.type === 'miniapp' || query.type === 'minigame') {
      qb.andWhere('a.type = :type', { type: query.type });
    }
    if (query.engine && query.engine !== 'all') {
      qb.andWhere('a.engine = :engine', { engine: query.engine });
    }
    if (query.q?.trim()) {
      const like = `%${query.q.trim()}%`;
      qb.andWhere('(a.name ILIKE :like OR a.description ILIKE :like OR a.id ILIKE :like)', {
        like,
      });
    }

    if (query.mine) {
      qb.andWhere('a.owner_id = :ownerId', { ownerId: user.userId });
    } else if (!user.isCaptain) {
      qb.andWhere('(a.status = :pub OR a.owner_id = :ownerId)', {
        pub: 'published',
        ownerId: user.userId,
      });
    }

    const apps = await qb
      .orderBy('a.featured_rank', 'DESC')
      .addOrderBy('a.play_count', 'DESC')
      .addOrderBy('a.updated_at', 'DESC')
      .getMany();

    if (apps.length === 0) return [];

    const versions = await this.versionRepo
      .createQueryBuilder('v')
      .where('v.app_id IN (:...ids)', { ids: apps.map((a) => a.id) })
      .orderBy('v.created_at', 'DESC')
      .getMany();

    const versionById = new Map<string, MiniAppVersionEntity>();
    const latestByApp = new Map<string, MiniAppVersionEntity>();
    const pendingByApp = new Set<string>();

    for (const v of versions) {
      versionById.set(v.id, v);
      if (!latestByApp.has(v.appId)) latestByApp.set(v.appId, v);
      if (v.status === 'pending') pendingByApp.add(v.appId);
    }

    const items: MiniAppCatalogDTO[] = [];
    for (const a of apps) {
      if (query.pending && !pendingByApp.has(a.id)) continue;
      const active = a.activeVersionId ? versionById.get(a.activeVersionId) : undefined;
      const hitLatest = latestByApp.get(a.id);
      const latest =
        hitLatest && (user.isCaptain || a.ownerId === user.userId || hitLatest.status === 'approved')
          ? hitLatest
          : undefined;
      items.push(toCatalogDTO(a, active, latest));
    }
    return items;
  }

  async getDetail(user: AuthUser, appId: string) {
    const app = await this.appRepo.findOne({ where: { id: appId } });
    if (!app) throw new NotFoundException('工坊应用不存在');
    if (app.status !== 'published' && !user.isCaptain && app.ownerId !== user.userId) {
      throw new ForbiddenException('无权查看尚未上架的应用');
    }

    const qb = this.versionRepo
      .createQueryBuilder('v')
      .where('v.app_id = :appId', { appId: app.id })
      .orderBy('v.created_at', 'DESC')
      .take(20);
    if (!user.isCaptain && app.ownerId !== user.userId) {
      qb.andWhere('v.status = :approved', { approved: 'approved' });
    }
    const versions = await qb.getMany();

    const latest = versions[0];
    const active = app.activeVersionId
      ? versions.find((v) => v.id === app.activeVersionId)
      : undefined;

    return {
      ...toCatalogDTO(app, active, latest),
      versions: versions.map(toVersionDTO),
    };
  }

  async uploadBundle(
    user: AuthUser,
    fileBuffer: Buffer,
    form: { channel?: string; changelog?: string; directPublish?: string },
  ): Promise<MiniAppCatalogDTO> {
    if (!this.s3.isConfigured()) {
      throw new ServiceUnavailableException('RustFS 对象存储尚未配置，无法上传构建包');
    }
    if (fileBuffer.length <= 0 || fileBuffer.length > MINIAPP_MAX_BUNDLE_BYTES) {
      throw new BadRequestException(
        '构建包体积需在 1B ~ 100MB 之间；更大体积请改用 GitHub Releases 导入',
      );
    }

    let validated;
    try {
      validated = await validateZipBundle(fileBuffer);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'ZIP 校验失败');
    }

    const existing = await this.appRepo.findOne({ where: { id: validated.manifest.id } });
    if (existing && existing.ownerId !== user.userId && !user.isCaptain) {
      throw new ForbiddenException(`应用 ID "${validated.manifest.id}" 已被其他成员注册`);
    }

    const safeVer = validated.manifest.version.replace(/\//g, '_');
    const bundleRelKey = `miniapps/${validated.manifest.id}/${safeVer}-${validated.sha256.slice(0, 10)}.zip`;
    let bundleUrl: string;
    try {
      bundleUrl = await this.s3.putPublicObject(bundleRelKey, fileBuffer, 'application/zip');
    } catch (err) {
      throw new BadGatewayException(
        `上传构建包至 RustFS 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let iconUrl = existing?.iconUrl ?? '';
    if (validated.iconBytes && validated.iconContentType && validated.iconExt) {
      const iconKey = `miniapps/${validated.manifest.id}/icon-${validated.sha256.slice(0, 8)}${validated.iconExt}`;
      try {
        iconUrl = await this.s3.putPublicObject(
          iconKey,
          validated.iconBytes,
          validated.iconContentType,
        );
      } catch {
        // 图标上传失败不阻塞
      }
    }

    const channel = form.channel?.trim() === 'release' ? 'release' : 'preview';
    const directPublish =
      user.isCaptain && (form.directPublish === 'true' || form.directPublish === '1');

    return this.persistVersion(user, {
      manifest: validated.manifest,
      iconUrl,
      sourceType: 'rustfs',
      bundleUrl,
      bundleKey: bundleRelKey,
      bundleSha256: validated.sha256,
      bundleSize: validated.compressedBytes,
      channel,
      changelog: (form.changelog ?? '').trim(),
      directPublish,
    });
  }

  async importFromGitHub(
    user: AuthUser,
    input: {
      bundleUrl: string;
      bundleSha256: string;
      bundleSize?: number;
      iconUrl?: string;
      channel?: string;
      changelog?: string;
      directPublish?: boolean;
      manifest: Partial<MiniAppManifest>;
    },
  ): Promise<MiniAppCatalogDTO> {
    if (!isAllowedGitHubReleaseUrl(input.bundleUrl)) {
      throw new BadRequestException(
        '仅允许导入来自 https://github.com 或 githubusercontent.com 的 Releases ZIP 链接',
      );
    }
    const sha = input.bundleSha256.trim().toLowerCase();
    if (!SHA256_HEX_RE.test(sha)) {
      throw new BadRequestException('请提供 64 位十六进制 SHA256 校验值以确保完整性');
    }

    let manifest: MiniAppManifest;
    try {
      manifest = normalizeAndValidateManifest(input.manifest);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Manifest 非法');
    }

    const existing = await this.appRepo.findOne({ where: { id: manifest.id } });
    if (existing && existing.ownerId !== user.userId && !user.isCaptain) {
      throw new ForbiddenException(`应用 ID "${manifest.id}" 已被其他成员注册`);
    }

    return this.persistVersion(user, {
      manifest,
      iconUrl: input.iconUrl?.trim() || existing?.iconUrl || '',
      sourceType: 'github',
      bundleUrl: input.bundleUrl.trim(),
      bundleKey: '',
      bundleSha256: sha,
      bundleSize: input.bundleSize ?? 0,
      channel: input.channel?.trim() === 'release' ? 'release' : 'preview',
      changelog: (input.changelog ?? '').trim(),
      directPublish: Boolean(user.isCaptain && input.directPublish),
    });
  }

  private async persistVersion(
    user: AuthUser,
    input: {
      manifest: MiniAppManifest;
      iconUrl: string;
      sourceType: string;
      bundleUrl: string;
      bundleKey: string;
      bundleSha256: string;
      bundleSize: number;
      channel: string;
      changelog: string;
      directPublish: boolean;
    },
  ): Promise<MiniAppCatalogDTO> {
    const now = new Date();
    const verId = randomUUID();
    const status = input.directPublish ? 'approved' : 'pending';

    const { savedApp, savedVer } = await this.dataSource.transaction(async (manager) => {
      let app = await manager.findOne(MiniAppEntity, { where: { id: input.manifest.id } });
      if (!app) {
        app = manager.create(MiniAppEntity, {
          id: input.manifest.id,
          name: input.manifest.name,
          type: input.manifest.type,
          engine: input.manifest.engine,
          description: input.manifest.description,
          iconUrl: input.iconUrl,
          tagsJson: input.manifest.tags,
          ownerId: user.userId,
          ownerName: user.displayName,
          ownerAvatar: user.avatar,
          status: input.directPublish ? 'published' : 'draft',
          activeVersionId: input.directPublish ? verId : null,
          featuredRank: 0,
          playCount: '0',
          createdAt: now,
          updatedAt: now,
        });
      } else {
        app.name = input.manifest.name;
        app.type = input.manifest.type;
        app.engine = input.manifest.engine;
        app.description = input.manifest.description;
        app.tagsJson = input.manifest.tags;
        if (input.iconUrl) app.iconUrl = input.iconUrl;
        if (input.directPublish) {
          app.status = 'published';
          app.activeVersionId = verId;
        }
        app.updatedAt = now;
      }
      await manager.save(MiniAppEntity, app);

      const ver = manager.create(MiniAppVersionEntity, {
        id: verId,
        appId: input.manifest.id,
        version: input.manifest.version,
        channel: input.channel,
        status,
        sourceType: input.sourceType,
        bundleUrl: input.bundleUrl,
        bundleKey: input.bundleKey,
        bundleSha256: input.bundleSha256,
        bundleSize: String(input.bundleSize),
        manifestJson: input.manifest as unknown as Record<string, unknown>,
        changelog: input.changelog,
        uploaderId: user.userId,
        reviewerId: input.directPublish ? user.userId : null,
        reviewNote: null,
        createdAt: now,
        reviewedAt: input.directPublish ? now : null,
      });
      await manager.save(MiniAppVersionEntity, ver);

      return { savedApp: app, savedVer: ver };
    });

    if (status === 'pending' && input.channel === 'release') {
      const captains = await this.roster.listActiveCaptains();
      for (const cap of captains) {
        void this.notifications.createAndPush({
          sourceApp: 'orbit',
          eventType: 'hub.version.pending',
          title: `工坊上新待审核：《${savedApp.name}》v${savedVer.version}`,
          body: `${user.displayName} 提交了 ${savedApp.name}（${savedApp.engine}），请前往「工坊 → 待审核」试玩并决定是否上架。`,
          payload: { appId: savedApp.id, versionId: savedVer.id, version: savedVer.version },
          targetUserId: cap.userId,
        });
      }
    }

    return toCatalogDTO(savedApp, input.directPublish ? savedVer : undefined, savedVer);
  }

  async reviewVersion(
    reviewer: AuthUser,
    appId: string,
    versionId: string,
    decision: 'approve' | 'reject',
    noteRaw?: string,
  ) {
    const app = await this.appRepo.findOne({ where: { id: appId } });
    if (!app) throw new NotFoundException('应用不存在');
    const ver = await this.versionRepo.findOne({ where: { id: versionId, appId } });
    if (!ver) throw new NotFoundException('目标版本不存在');

    const now = new Date();
    const note = (noteRaw ?? '').trim();
    const nextStatus = decision === 'approve' ? 'approved' : 'rejected';

    await this.dataSource.transaction(async (manager) => {
      ver.status = nextStatus;
      ver.reviewerId = reviewer.userId;
      ver.reviewNote = note;
      ver.reviewedAt = now;
      await manager.save(MiniAppVersionEntity, ver);

      if (decision === 'approve') {
        app.status = 'published';
        app.activeVersionId = ver.id;
        app.updatedAt = now;
        await manager.save(MiniAppEntity, app);
      }
    });

    const title =
      decision === 'approve'
        ? `《${app.name}》v${ver.version} 已通过审核并上架`
        : `《${app.name}》v${ver.version} 审核未通过`;
    const body =
      decision === 'approve'
        ? `审核人：${reviewer.displayName}。全员现在可以在 Orbit 工坊中打开体验！`
        : `审核人：${reviewer.displayName}。意见：${note}`;

    void this.notifications.createAndPush({
      sourceApp: 'orbit',
      eventType: 'hub.version.reviewed',
      title,
      body,
      payload: { appId: app.id, versionId: ver.id, decision },
      targetUserId: ver.uploaderId,
    });

    return { ok: true, appId: app.id, versionId: ver.id, status: nextStatus };
  }

  async updateStatus(
    user: AuthUser,
    appId: string,
    input: { status?: string; activeVersionId?: string },
  ) {
    const app = await this.appRepo.findOne({ where: { id: appId } });
    if (!app) throw new NotFoundException('应用不存在');
    if (!user.isCaptain && app.ownerId !== user.userId) {
      throw new ForbiddenException('仅作者或队长可执行此操作');
    }

    if (input.status) {
      if (!['published', 'suspended', 'draft'].includes(input.status)) {
        throw new BadRequestException('不支持的应用状态');
      }
      if (input.status === 'published' && !user.isCaptain) {
        throw new ForbiddenException('普通成员不能直接改为已上架状态');
      }
      app.status = input.status;
    }

    if (input.activeVersionId) {
      const ver = await this.versionRepo.findOne({
        where: { id: input.activeVersionId, appId, status: 'approved' },
      });
      if (!ver) {
        throw new BadRequestException('仅可回滚到已审核通过的历史版本');
      }
      app.activeVersionId = ver.id;
    }

    app.updatedAt = new Date();
    await this.appRepo.save(app);
    return { ok: true };
  }

  async recordPlay(appId: string) {
    await this.appRepo.query(
      `UPDATE mini_apps SET play_count = play_count + 1 WHERE id = $1`,
      [appId],
    );
    return { ok: true };
  }

  // ── 托管云存档 KV ──

  async listKvKeys(userId: string, appId: string) {
    const rows = await this.kvRepo.find({
      where: { appId, userId },
      select: { key: true },
      order: { key: 'ASC' },
    });
    return { keys: rows.map((r) => r.key) };
  }

  async getKv(userId: string, appId: string, key: string) {
    const item = await this.kvRepo.findOne({ where: { appId, userId, key } });
    if (!item) throw new NotFoundException('键不存在');
    return {
      key: item.key,
      value: item.valueJson,
      updatedAt: new Date(item.updatedAt).toISOString(),
    };
  }

  async setKv(userId: string, appId: string, key: string, value: unknown) {
    if (!key || key.length > 128) {
      throw new BadRequestException('存档键长度需在 1~128 字符之间');
    }
    const serialized = JSON.stringify(value === undefined ? null : value);
    const sizeBytes = Buffer.byteLength(serialized, 'utf8');
    if (sizeBytes > KV_MAX_VALUE_BYTES) {
      throw new PayloadTooLargeException('单条云存档不能超过 64 KB');
    }

    const [row] = (await this.kvRepo.query(
      `SELECT COALESCE(SUM(size_bytes), 0)::int AS used
       FROM mini_app_kv
       WHERE app_id = $1 AND user_id = $2 AND key <> $3`,
      [appId, userId, key],
    )) as [{ used: number }];
    if (Number(row?.used ?? 0) + sizeBytes > KV_MAX_TOTAL_BYTES) {
      throw new PayloadTooLargeException('单应用云存档总配额已达 1 MB 上限');
    }

    const now = new Date();
    await this.kvRepo.query(
      `INSERT INTO mini_app_kv (app_id, user_id, key, value_json, size_bytes, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (app_id, user_id, key) DO UPDATE SET
         value_json = EXCLUDED.value_json,
         size_bytes = EXCLUDED.size_bytes,
         updated_at = EXCLUDED.updated_at`,
      [appId, userId, key, serialized, sizeBytes, now],
    );
    return { ok: true, key, sizeBytes };
  }

  async deleteKv(userId: string, appId: string, key: string) {
    await this.kvRepo.delete({ appId, userId, key });
    return { ok: true };
  }
}
