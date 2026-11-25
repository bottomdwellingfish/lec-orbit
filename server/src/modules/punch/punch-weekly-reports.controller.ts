/**
 * GitHub 数据源与成员周报接口（PostgreSQL TypeORM 版，兼容 LecPunch /github-source* 与 /weekly-reports*）。
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
import { Repository } from 'typeorm';
import { z } from 'zod';
import {
  PunchGitHubSourceEntity,
  PunchWeeklyReportRefEntity,
} from './entities/punch-collab.entities.js';
import { PunchUserEntity } from './entities/punch-core.entities.js';
import {
  PunchAdminOnly,
  PunchAuthGuard,
  PunchCurrentUser,
  type PunchAuthUser,
} from './punch-auth.guard.js';
import { newObjectIdHex, parseIsoWeekToMondayKey } from './punch-shared.util.js';

const UpsertGitHubSourceSchema = z.object({
  repoUrl: z.string().url('请填写合法的 GitHub 仓库地址'),
  branch: z.string().trim().min(1).max(64).default('main'),
  indexPath: z.string().trim().min(1).max(200).default('lecpunch/index.json'),
  enabled: z.boolean().default(true),
  siteUrl: z.string().url().nullable().optional(),
});

const UpsertWeeklyReportSchema = z.object({
  weekKey: z.string().trim().min(1),
  githubPath: z.string().nullable().optional(),
  rawUrl: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
  dailyLogCount: z.number().int().min(0).max(7).default(0),
  status: z.enum(['generated', 'missing', 'pending']).default('generated'),
});

@Controller()
@UseGuards(PunchAuthGuard)
export class PunchWeeklyReportsController {
  constructor(
    @InjectRepository(PunchGitHubSourceEntity)
    private readonly sourceRepo: Repository<PunchGitHubSourceEntity>,
    @InjectRepository(PunchWeeklyReportRefEntity)
    private readonly reportRepo: Repository<PunchWeeklyReportRefEntity>,
    @InjectRepository(PunchUserEntity)
    private readonly userRepo: Repository<PunchUserEntity>,
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
    const key = parseIsoWeekToMondayKey(week);
    if (!key) throw new BadRequestException('无效的周标识');
    return this.reportRepo.findOne({ where: { userId: user.userId, weekKey: key } });
  }

  @Put('weekly-reports/me')
  async upsertMyWeeklyReport(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const input = UpsertWeeklyReportSchema.parse(rawBody);
    const key = parseIsoWeekToMondayKey(input.weekKey);
    if (!key) throw new BadRequestException('无效的周标识');
    const now = new Date();
    let rec = await this.reportRepo.findOne({ where: { userId: user.userId, weekKey: key } });
    if (!rec) {
      rec = this.reportRepo.create({
        id: newObjectIdHex(),
        userId: user.userId,
        weekKey: key,
        createdAt: now,
      });
    }
    rec.githubPath = input.githubPath ?? null;
    rec.rawUrl = input.rawUrl ?? null;
    rec.commitSha = input.commitSha ?? null;
    rec.dailyLogCount = input.dailyLogCount;
    rec.status = input.status;
    rec.generatedAt = input.status === 'generated' ? now : rec.generatedAt;
    rec.updatedAt = now;
    return this.reportRepo.save(rec);
  }

  @Get('weekly-reports/admin')
  @PunchAdminOnly()
  async listAdminWeeklyReports(
    @PunchCurrentUser() user: PunchAuthUser,
    @Query('week') week?: string,
  ) {
    const key = parseIsoWeekToMondayKey(week);
    if (!key) throw new BadRequestException('无效的周标识');
    const members = await this.userRepo.find({ where: { teamId: user.teamId, status: 'active' } });
    const refs = await this.reportRepo.find({ where: { weekKey: key } });
    const byUid = new Map(refs.map((r) => [r.userId, r]));
    return {
      weekKey: key,
      items: members.map((m) => ({
        userId: m.id,
        username: m.username,
        displayName: m.displayName,
        enrollYear: m.enrollYear,
        report: byUid.get(m.id) ?? null,
      })),
    };
  }
}
