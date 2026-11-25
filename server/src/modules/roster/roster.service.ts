/**
 * 工作室成员花名册服务（等价迁移原 Go internal/roster/roster.go）：
 * - 登录活跃自动 Upsert；
 * - 若配置了 LecSSO M2M 凭证，启动时及每 10 分钟定时同步全量 lec-studio 组织成员。
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import { isCaptainRole } from '../auth/auth.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { OrbitMemberEntity } from './entities/orbit-member.entity.js';

export interface MemberDTO {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  isCaptain: boolean;
}

interface LogtoOrgUser {
  id?: string;
  username?: string;
  name?: string;
  avatar?: string;
  isSuspended?: boolean;
  organizationRoles?: Array<{ name?: string }>;
}

@Injectable()
export class RosterService implements OnModuleInit {
  private readonly logger = new Logger(RosterService.name);
  private m2mToken = '';
  private m2mExpiresAt = 0;

  constructor(
    @InjectRepository(OrbitMemberEntity)
    private readonly memberRepo: Repository<OrbitMemberEntity>,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.cfg.ssoM2mClientId || !this.cfg.ssoM2mClientSecret) {
      this.logger.log('LEC_SSO_M2M_CLIENT_ID 未配置，成员列表将按登录活跃自动同步');
      return;
    }
    void this.syncFromLecSso().catch((err: unknown) => {
      this.logger.warn(
        `首次同步 LecSSO 成员失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  @Cron('*/10 * * * *')
  async handlePeriodicSync(): Promise<void> {
    if (!this.cfg.ssoM2mClientId || !this.cfg.ssoM2mClientSecret) return;
    try {
      await this.syncFromLecSso();
    } catch (err) {
      this.logger.warn(
        `定时同步 LecSSO 成员失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async upsertFromAuth(user: AuthUser): Promise<void> {
    if (!user.userId) return;
    const display = user.displayName || user.username || '';
    const now = new Date();
    await this.memberRepo.query(
      `INSERT INTO orbit_members (user_id, username, display_name, avatar, is_captain, is_active, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         username = CASE WHEN EXCLUDED.username <> '' THEN EXCLUDED.username ELSE orbit_members.username END,
         display_name = CASE WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name ELSE orbit_members.display_name END,
         avatar = CASE WHEN EXCLUDED.avatar <> '' THEN EXCLUDED.avatar ELSE orbit_members.avatar END,
         is_captain = EXCLUDED.is_captain,
         is_active = TRUE,
         updated_at = EXCLUDED.updated_at`,
      [user.userId, user.username, display, user.avatar, user.isCaptain, now],
    );
  }

  async listActive(): Promise<MemberDTO[]> {
    const rows = await this.memberRepo.find({
      where: { isActive: true },
      order: { isCaptain: 'DESC', displayName: 'ASC', username: 'ASC' },
    });
    return rows.map((r) => ({
      userId: r.userId,
      username: r.username,
      displayName: r.displayName,
      avatar: r.avatar,
      isCaptain: r.isCaptain,
    }));
  }

  async countActive(): Promise<number> {
    const cnt = await this.memberRepo.count({ where: { isActive: true } });
    return Math.max(1, cnt);
  }

  async listActiveCaptains(): Promise<OrbitMemberEntity[]> {
    return this.memberRepo.find({ where: { isActive: true, isCaptain: true } });
  }

  private async fetchM2mToken(): Promise<string> {
    const now = Date.now();
    if (this.m2mToken && now < this.m2mExpiresAt) {
      return this.m2mToken;
    }
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      resource: this.cfg.ssoM2mResource,
      scope: 'all',
    });
    const basic = Buffer.from(
      `${this.cfg.ssoM2mClientId}:${this.cfg.ssoM2mClientSecret}`,
      'utf8',
    ).toString('base64');

    const resp = await fetch(`${this.cfg.ssoEndpoint}/oidc/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) {
      const body = (await resp.text().catch(() => '')).slice(0, 512);
      throw new Error(`换取 LecSSO M2M Token 失败（HTTP ${resp.status}）: ${body}`);
    }
    const res = (await resp.json()) as { access_token?: string; expires_in?: number };
    this.m2mToken = res.access_token ?? '';
    const ttlSec = Math.max(60, (res.expires_in ?? 300) - 60);
    this.m2mExpiresAt = now + ttlSec * 1000;
    return this.m2mToken;
  }

  async syncFromLecSso(): Promise<number> {
    const token = await this.fetchM2mToken();
    const pageSize = 100;
    const users: LogtoOrgUser[] = [];

    for (let page = 1; page <= 20; page += 1) {
      const url =
        `${this.cfg.ssoEndpoint}/api/organizations/${encodeURIComponent(this.cfg.ssoOrgId)}/users` +
        `?page=${page}&page_size=${pageSize}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!resp.ok) {
        const body = (await resp.text().catch(() => '')).slice(0, 512);
        throw new Error(`拉取 LecSSO 组织成员失败（HTTP ${resp.status}）: ${body}`);
      }
      const batch = (await resp.json()) as LogtoOrgUser[];
      if (!Array.isArray(batch)) break;
      users.push(...batch);
      if (batch.length < pageSize) break;
    }

    const activeIds: string[] = [];
    const now = new Date();
    for (const u of users) {
      if (!u.id || u.isSuspended) continue;
      const roleNames = (u.organizationRoles ?? [])
        .map((r) => r.name ?? '')
        .filter((n) => n.length > 0);
      const display = u.name || u.username || '';
      await this.memberRepo.query(
        `INSERT INTO orbit_members (user_id, username, display_name, avatar, is_captain, is_active, updated_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6)
         ON CONFLICT (user_id) DO UPDATE SET
           username = EXCLUDED.username,
           display_name = EXCLUDED.display_name,
           avatar = EXCLUDED.avatar,
           is_captain = EXCLUDED.is_captain,
           is_active = TRUE,
           updated_at = EXCLUDED.updated_at`,
        [u.id, u.username ?? '', display, u.avatar ?? '', isCaptainRole(roleNames), now],
      );
      activeIds.push(u.id);
    }

    if (activeIds.length > 0) {
      await this.memberRepo.query(
        `UPDATE orbit_members SET is_active = FALSE WHERE NOT (user_id = ANY($1))`,
        [activeIds],
      );
    }
    this.logger.log(`已从 LecSSO 同步 ${activeIds.length} 名在岗成员`);
    return activeIds.length;
  }
}
