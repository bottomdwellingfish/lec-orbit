/**
 * GitHub 数据源与成员周报接口（PostgreSQL TypeORM 版，完全兼容 LecPunch /github-source* 与 /weekly-reports*）：
 * - GET /weekly-reports/me 返回 { week, item, attendanceSummary }；
 * - PUT /weekly-reports/me 严格校验 githubPath 与 rawUrl 同源一致性，返回 { week, item }；
 * - GET /weekly-reports/admin 返回 { week, weekKey, items }（完整携带 member 与 attendanceAdjustment）。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { z } from 'zod';
import { PunchDurationAdjustmentEntity } from './entities/punch-attendance.entities.js';
import {
  PunchGitHubSourceEntity,
  PunchWeeklyReportRefEntity,
} from './entities/punch-collab.entities.js';
import { PunchUserEntity } from './entities/punch-core.entities.js';
import { PunchAttendanceService } from './punch-attendance.service.js';
import {
  PunchAdminOnly,
  PunchAuthGuard,
  PunchCurrentUser,
  type PunchAuthUser,
} from './punch-auth.guard.js';
import {
  mondayKeyToIsoWeek,
  newObjectIdHex,
  parseIsoWeekToMondayKey,
} from './punch-shared.util.js';

const GITHUB_REPO_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}))\/((?![A-Za-z0-9._-]*\.git$)[A-Za-z0-9_-][A-Za-z0-9._-]*)$/;
const GITHUB_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const GITHUB_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

function isSafeGitHubPath(value: string): boolean {
  return GITHUB_PATH_RE.test(value) && !value.includes('..') && !value.includes('://');
}

function buildRawGitHubUrl(repoUrl: string, branch: string, githubPath: string): string | null {
  const match = GITHUB_REPO_URL_RE.exec(repoUrl);
  if (!match || !GITHUB_REF_RE.test(branch) || branch.includes('..') || !isSafeGitHubPath(githubPath)) {
    return null;
  }
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${branch}/${githubPath}`;
}

const UpsertGitHubSourceSchema = z.object({
  repoUrl: z.string().url('请填写合法的 GitHub 仓库地址'),
  branch: z.string().trim().min(1).max(64).default('main'),
  indexPath: z.string().trim().min(1).max(200).default('lecpunch/index.json'),
  enabled: z.boolean().default(true),
  siteUrl: z.string().url().nullable().optional(),
});

const UpsertWeeklyReportSchema = z.object({
  weekKey: z.string().trim().min(1).optional(),
  githubPath: z.string().nullable().optional(),
  rawUrl: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
  dailyLogCount: z.number().int().min(0).max(7).default(0),
  status: z.enum(['generated', 'missing', 'pending']).default('generated'),
});

function toWeeklyReportItem(rec: PunchWeeklyReportRefEntity) {
  return {
    id: rec.id,
    weekKey: rec.weekKey,
    githubPath: rec.githubPath,
    rawUrl: rec.rawUrl,
    commitSha: rec.commitSha,
    dailyLogCount: rec.dailyLogCount,
    status: rec.status,
    generatedAt: rec.generatedAt ? rec.generatedAt.toISOString() : null,
    updatedAt: rec.updatedAt.toISOString(),
  };
}

@Controller()
@UseGuards(PunchAuthGuard)
export class PunchWeeklyReportsController {
  constructor(
    @InjectRepository(PunchGitHubSourceEntity)
    private readonly sourceRepo: Repository<PunchGitHubSourceEntity>,
    @InjectRepository(PunchWeeklyReportRefEntity)
    private readonly reportRepo: Repository<PunchWeeklyReportRefEntity>,
    @InjectRepository(PunchDurationAdjustmentEntity)
    private readonly adjRepo: Repository<PunchDurationAdjustmentEntity>,
    @InjectRepository(PunchUserEntity)
    private readonly userRepo: Repository<PunchUserEntity>,
    private readonly attendanceService: PunchAttendanceService,
  ) {}

  @Get('github-source/me')
  getMySource(@PunchCurrentUser() user: PunchAuthUser) {
    return this.sourceRepo.findOne({ where: { userId: user.userId } });
  }

  @Put('github-source/me')
  async upsertMySource(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const input = UpsertGitHubSourceSchema.parse(rawBody);
    const now = new Date();
    let rec = await this.sourceRepo.findOne({ where: { userId: user.userId } });
    if (!rec) {
      rec = this.sourceRepo.create({
        id: newObjectIdHex(),
        userId: user.userId,
        accessMode: 'public',
        createdAt: now,
      });
    }
    rec.repoUrl = input.repoUrl;
    rec.branch = input.branch;
    rec.indexPath = input.indexPath;
    rec.enabled = input.enabled;
    rec.siteUrl = input.siteUrl ?? null;
    rec.verifiedAt = now;
    rec.updatedAt = now;
    return this.sourceRepo.save(rec);
  }

  @Delete('github-source/me')
  async deleteMySource(@PunchCurrentUser() user: PunchAuthUser) {
    await this.sourceRepo.delete({ userId: user.userId });
    return { ok: true };
  }

  @Get('github-sources/team')
  async listTeamSources(@PunchCurrentUser() user: PunchAuthUser) {
    const members = await this.userRepo.find({ where: { teamId: user.teamId, status: 'active' } });
    const memberIds = members.map((m) => m.id);
    if (memberIds.length === 0) return [];
    const sources = await this.sourceRepo
      .createQueryBuilder('s')
      .where('s.user_id IN (:...ids) AND s.enabled = TRUE', { ids: memberIds })
      .getMany();
    const byId = new Map(members.map((m) => [m.id, m]));
    return sources.map((s) => ({
      ...s,
      displayName: byId.get(s.userId)?.displayName ?? '',
      username: byId.get(s.userId)?.username ?? '',
    }));
  }

  @Get('weekly-reports/me')
  async getMyWeeklyReport(@PunchCurrentUser() user: PunchAuthUser, @Query('week') week?: string) {
    const mondayKey = parseIsoWeekToMondayKey(week);
    if (!mondayKey) throw new BadRequestException('无效的周标识');
    const isoWeek = mondayKeyToIsoWeek(mondayKey);

    // 兼容历史库里按 ISO 周（YYYY-Www）或周一日期（YYYY-MM-DD）存的周报索引
    const [reference, attendanceSummary] = await Promise.all([
      this.reportRepo.findOne({
        where: [
          { userId: user.userId, weekKey: isoWeek },
          { userId: user.userId, weekKey: mondayKey },
        ],
      }),
      this.attendanceService.getMyWeeklySummary(user, isoWeek),
    ]);

    return {
      week: isoWeek,
      item: reference ? toWeeklyReportItem(reference) : null,
      attendanceSummary,
    };
  }

  @Put('weekly-reports/me')
  async upsertMyWeeklyReport(
    @PunchCurrentUser() user: PunchAuthUser,
    @Query('week') queryWeek: string | undefined,
    @Body() rawBody: unknown,
  ) {
    const input = UpsertWeeklyReportSchema.parse(rawBody ?? {});
    const mondayKey = parseIsoWeekToMondayKey(queryWeek || input.weekKey);
    if (!mondayKey) throw new BadRequestException('无效的周标识');
    const isoWeek = mondayKeyToIsoWeek(mondayKey);

    const githubPath = input.githubPath?.trim() || undefined;
    const rawUrl = input.rawUrl?.trim() || undefined;
    const requiresSource =
      input.status === 'generated' || githubPath !== undefined || rawUrl !== undefined;

    if (input.status === 'generated' && (!githubPath || !rawUrl)) {
      throw new BadRequestException({
        code: 'WEEKLY_REPORT_GENERATED_REFERENCE_REQUIRED',
        message: '已生成的周报必须同时提供 githubPath 和 rawUrl',
      });
    }
    if ((githubPath === undefined) !== (rawUrl === undefined)) {
      throw new BadRequestException({
        code: 'WEEKLY_REPORT_REFERENCE_PAIR_REQUIRED',
        message: 'githubPath 和 rawUrl 必须成对提供',
      });
    }
    if (requiresSource) {
      const source = await this.sourceRepo.findOne({ where: { userId: user.userId } });
      if (!source?.enabled) {
        throw new BadRequestException({
          code: 'GITHUB_SOURCE_REQUIRED',
          message: '请先绑定并启用公开 GitHub 周报仓库后再保存周报引用',
        });
      }
      if (!githubPath || !isSafeGitHubPath(githubPath)) {
        throw new BadRequestException({
          code: 'WEEKLY_REPORT_PATH_INVALID',
          message: '周报仓库路径非法',
        });
      }
      const expectedRawUrl = buildRawGitHubUrl(source.repoUrl, source.branch, githubPath);
      if (!expectedRawUrl || rawUrl !== expectedRawUrl) {
        throw new BadRequestException({
          code: 'WEEKLY_REPORT_RAW_URL_MISMATCH',
          message: 'rawUrl 必须与已绑定的公开仓库、分支及 githubPath 严格一致',
        });
      }
    }

    const now = new Date();
    let rec = await this.reportRepo.findOne({
      where: [
        { userId: user.userId, weekKey: isoWeek },
        { userId: user.userId, weekKey: mondayKey },
      ],
    });
    if (!rec) {
      rec = this.reportRepo.create({
        id: newObjectIdHex(),
        userId: user.userId,
        weekKey: isoWeek,
        createdAt: now,
      });
    }
    rec.githubPath = githubPath ?? null;
    rec.rawUrl = rawUrl ?? null;
    rec.commitSha = input.commitSha?.trim() || null;
    rec.dailyLogCount = input.dailyLogCount;
    rec.status = input.status;
    rec.generatedAt = input.status === 'generated' ? now : null;
    rec.updatedAt = now;
    const saved = await this.reportRepo.save(rec);
    return { week: isoWeek, item: toWeeklyReportItem(saved) };
  }

  @Get('weekly-reports/admin')
  @PunchAdminOnly()
  async listAdminWeeklyReports(
    @PunchCurrentUser() user: PunchAuthUser,
    @Query('week') week?: string,
  ) {
    const mondayKey = parseIsoWeekToMondayKey(week);
    if (!mondayKey) throw new BadRequestException('无效的周标识');
    const isoWeek = mondayKeyToIsoWeek(mondayKey);

    const members = await this.userRepo.find({ where: { teamId: user.teamId, status: 'active' } });
    const memberIds = members.map((m) => m.id);
    if (memberIds.length === 0) {
      return { week: isoWeek, weekKey: mondayKey, items: [] };
    }

    const [refs, adjustments] = await Promise.all([
      this.reportRepo.find({
        where: { userId: In(memberIds), weekKey: In([isoWeek, mondayKey]) },
      }),
      this.adjRepo.find({
        where: { teamId: user.teamId, userId: In(memberIds), weekKey: mondayKey },
        order: { createdAt: 'ASC' },
      }),
    ]);

    const byUid = new Map<string, PunchWeeklyReportRefEntity>();
    for (const r of refs) {
      if (!byUid.has(r.userId) || r.weekKey === isoWeek) byUid.set(r.userId, r);
    }

    const adjByUid = new Map<string, PunchDurationAdjustmentEntity[]>();
    for (const a of adjustments) {
      const list = adjByUid.get(a.userId) ?? [];
      list.push(a);
      adjByUid.set(a.userId, list);
    }

    return {
      week: isoWeek,
      weekKey: mondayKey,
      items: members.map((m) => {
        const ref = byUid.get(m.id);
        const userAdjs = adjByUid.get(m.id) ?? [];
        const manualSeconds = userAdjs.reduce((sum, a) => sum + a.signedDurationSeconds, 0);
        const reportItem = ref ? toWeeklyReportItem(ref) : null;
        return {
          member: {
            userId: m.id,
            username: m.username,
            displayName: m.displayName,
            role: m.role,
            status: m.status,
          },
          attendanceAdjustment: {
            manualAdjustmentSeconds: manualSeconds,
            adjustmentsCount: userAdjs.length,
            items: userAdjs.map((a) => ({
              adjustmentId: a.id,
              operation: a.operation,
              durationSeconds: a.durationSeconds,
              signedDurationSeconds: a.signedDurationSeconds,
              reason: a.reason,
              createdAt: a.createdAt.toISOString(),
            })),
          },
          userId: m.id,
          username: m.username,
          displayName: m.displayName,
          enrollYear: m.enrollYear,
          githubPath: reportItem?.githubPath ?? null,
          rawUrl: reportItem?.rawUrl ?? null,
          commitSha: reportItem?.commitSha ?? null,
          dailyLogCount: reportItem?.dailyLogCount ?? 0,
          status: reportItem?.status ?? 'missing',
          generatedAt: reportItem?.generatedAt ?? null,
          report: reportItem,
        };
      }),
    };
  }
}
