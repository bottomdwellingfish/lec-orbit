/**
 * 工作室称号系统服务（PostgreSQL TypeORM 版，完整实现 LecPunch 11 项自动判定称号、
 * 30 秒团队快照缓存、佩戴校验以及全员亮牌徽章映射）。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { z } from 'zod';
import { getShanghaiWeekKey } from '../../common/utils/week-key.js';
import { EconomyLedgerService } from '../economy/economy-ledger.service.js';
import {
  PunchAttendanceSessionEntity,
  PunchDurationAdjustmentEntity,
} from './entities/punch-attendance.entities.js';
import {
  PunchCardActionArchiveEntity,
  PunchCardGameEntity,
  PunchCardWeekArchiveEntity,
} from './entities/punch-cards.entities.js';
import { PunchUserEntity } from './entities/punch-core.entities.js';
import { PunchAuthGuard, PunchCurrentUser, type PunchAuthUser } from './punch-auth.guard.js';
import { assessmentEnrollYears } from './punch-shared.util.js';
import {
  TITLE_BY_ID,
  TITLE_CATALOG,
  toMemberTitleBadge,
  type MemberTitleBadge,
  type TitleDefinition,
  type TitleEvaluationItem,
} from './punch-title-catalog.js';
import {
  addShanghaiDays,
  evaluateTeamTitles,
  extractCardInteractionsFromReceipt,
  getTitleLookbackStartDate,
  shanghaiDayStartMs,
  type MemberTitleEvaluation,
  type TitleEngineCardInteraction,
  type TitleEngineSession,
} from './punch-title-engine.js';
import { PunchUsersService } from './punch-users.service.js';

export {
  TITLE_BY_ID,
  TITLE_CATALOG,
  toMemberTitleBadge,
  evaluateTeamTitles,
  extractCardInteractionsFromReceipt,
  type MemberTitleBadge,
  type TitleDefinition,
  type TitleEvaluationItem,
};

const TEAM_CACHE_TTL_MS = 30_000;

interface CachedTeamTitles {
  computedAt: number;
  weekKey: string;
  byUserId: Map<string, MemberTitleEvaluation>;
}

const EquipTitleSchema = z.object({
  titleId: z.string().trim().nullable().optional(),
});

@Injectable()
export class PunchTitlesService {
  private readonly teamCache = new Map<string, CachedTeamTitles>();

  constructor(
    @InjectRepository(PunchUserEntity)
    private readonly userRepo: Repository<PunchUserEntity>,
    @InjectRepository(PunchAttendanceSessionEntity)
    private readonly sessionRepo: Repository<PunchAttendanceSessionEntity>,
    @InjectRepository(PunchDurationAdjustmentEntity)
    private readonly adjRepo: Repository<PunchDurationAdjustmentEntity>,
    @InjectRepository(PunchCardGameEntity)
    private readonly cardGameRepo: Repository<PunchCardGameEntity>,
    @InjectRepository(PunchCardWeekArchiveEntity)
    private readonly cardWeekArchiveRepo: Repository<PunchCardWeekArchiveEntity>,
    @InjectRepository(PunchCardActionArchiveEntity)
    private readonly cardActionArchiveRepo: Repository<PunchCardActionArchiveEntity>,
    private readonly usersService: PunchUsersService,
    private readonly economyLedger: EconomyLedgerService,
  ) {}

  /** 考勤签退/调时/佩戴称号变更后主动失效团队快照缓存。 */
  invalidateTeamCache(teamId: string): void {
    this.teamCache.delete(teamId);
  }

  /** 获取当前登录成员的完整称号面板（非近三级成员仍可浏览全量 11 项称号图鉴，但不参与解锁与佩戴）。 */
  async getMyTitles(teamId: string, userId: string) {
    const snapshot = await this.computeTeamSnapshot(teamId, true);
    const mine = snapshot.byUserId.get(userId);
    if (!mine) {
      return {
        weekKey: snapshot.weekKey,
        eligible: false,
        equippedTitleId: null,
        displayTitles: [],
        catalog: TITLE_CATALOG.map((def) => ({
          ...toMemberTitleBadge(def),
          unlocked: false,
          equipped: false,
          progressText: '仅大一至大三可解锁',
        })),
      };
    }
    return {
      weekKey: snapshot.weekKey,
      eligible: true,
      equippedTitleId: mine.equippedTitleId,
      displayTitles: mine.displayTitles,
      catalog: mine.catalog,
    };
  }

  /** 手动佩戴或恢复自动佩戴称号，返回最新完整称号面板。 */
  async equipTitle(teamId: string, userId: string, rawTitleId?: string | null) {
    const trimmed = typeof rawTitleId === 'string' ? rawTitleId.trim() : '';
    const titleId = trimmed.length > 0 ? trimmed : null;

    if (titleId !== null) {
      const def = TITLE_BY_ID.get(titleId);
      if (!def) {
        throw new BadRequestException('指定的称号不存在');
      }
      if (def.forced) {
        throw new BadRequestException('状态类称号由系统自动亮牌，无需手动佩戴');
      }
      const current = await this.computeTeamSnapshot(teamId, true);
      const mine = current.byUserId.get(userId);
      const item = mine?.catalog.find((entry) => entry.id === titleId);
      if (!item?.unlocked) {
        throw new BadRequestException(`尚未解锁「${def.name}」称号`);
      }
    }

    const member = await this.userRepo.findOne({ where: { id: userId, teamId } });
    if (!member) {
      throw new BadRequestException('用户不存在');
    }
    member.equippedTitleId = titleId;
    member.updatedAt = new Date();
    await this.userRepo.save(member);

    this.invalidateTeamCache(teamId);
    return this.getMyTitles(teamId, userId);
  }

  /** 按内部 userId 返回团队所有成员的展示亮牌数组（供在线打卡榜、周榜挂载）。 */
  async getTeamDisplayTitlesByUserId(teamId: string): Promise<Map<string, MemberTitleBadge[]>> {
    const snapshot = await this.computeTeamSnapshot(teamId, false);
    const result = new Map<string, MemberTitleBadge[]>();
    for (const [userId, evalResult] of snapshot.byUserId.entries()) {
      result.set(userId, evalResult.displayTitles);
    }
    return result;
  }

  /** 按签名 memberKey 返回团队所有成员的展示亮牌映射（供 GET /titles/team 返回）。 */
  async getTeamDisplayTitlesByMemberKey(
    teamId: string,
  ): Promise<Record<string, MemberTitleBadge[]>> {
    const snapshot = await this.computeTeamSnapshot(teamId, false);
    const result: Record<string, MemberTitleBadge[]> = {};
    for (const [userId, evalResult] of snapshot.byUserId.entries()) {
      result[this.usersService.getMemberKey(userId)] = evalResult.displayTitles;
    }
    return result;
  }

  /** 汇总团队内指定多周的卡牌娱乐时长与 Orbit 交易时长（与周榜口径一致）。 */
  private async loadEntertainmentByUserWeek(
    teamId: string,
    members: PunchUserEntity[],
    weekKeys: string[],
  ): Promise<Map<string, number>> {
    const [game, archivedWeeks, ...tradeSummaries] = await Promise.all([
      this.cardGameRepo.findOne({ where: { teamId } }),
      this.cardWeekArchiveRepo.find({
        where: { teamId, weekKey: In(weekKeys) },
      }),
      ...weekKeys.map((wk) => this.economyLedger.getWeeklyTradeMinutesSummary(wk)),
    ]);

    const cardByUserWeek = new Map<string, number>();
    for (const row of archivedWeeks) {
      const secs = Number((row.week as { entertainmentSeconds?: number } | null)?.entertainmentSeconds ?? 0);
      if (Number.isFinite(secs)) {
        cardByUserWeek.set(`${row.userId}:${row.weekKey}`, secs);
      }
    }

    const stateMembers = (game?.state?.members ?? {}) as Record<
      string,
      { weeks?: Record<string, { entertainmentSeconds?: number }> }
    >;
    for (const [uid, mState] of Object.entries(stateMembers)) {
      for (const wk of weekKeys) {
        const weekEntry = mState?.weeks?.[wk];
        if (weekEntry && typeof weekEntry.entertainmentSeconds === 'number') {
          cardByUserWeek.set(`${uid}:${wk}`, weekEntry.entertainmentSeconds);
        }
      }
    }

    const result = new Map<string, number>();
    weekKeys.forEach((wk, idx) => {
      const summary = tradeSummaries[idx];
      const tradeMap = new Map(
        (summary?.items ?? []).map((item) => [item.userId, item.tradeMinutes]),
      );
      for (const member of members) {
        const cardSec = cardByUserWeek.get(`${member.id}:${wk}`) ?? 0;
        const tradeMin = tradeMap.get(member.logtoUserId || member.id) ?? 0;
        const totalEnt = cardSec + (summary?.affectsAssessment ? tradeMin * 60 : 0);
        if (totalEnt !== 0) {
          result.set(`${member.id}:${wk}`, totalEnt);
        }
      }
    });

    return result;
  }

  /** 读取本周卡牌跨人正/负面交互事件（合并归档表与实时 state.receipts，用于「吕洞宾」判定）。 */
  private async loadCurrentWeekCardInteractions(
    teamId: string,
    weekStartMs: number,
  ): Promise<TitleEngineCardInteraction[]> {
    const weekStartIso = new Date(weekStartMs).toISOString();
    const [archived, game] = await Promise.all([
      this.cardActionArchiveRepo.find({
        where: { teamId, at: MoreThanOrEqual(weekStartIso) },
      }),
      this.cardGameRepo.findOne({ where: { teamId } }),
    ]);

    const interactions: TitleEngineCardInteraction[] = [];
    const seenReceiptKeys = new Set<string>();

    for (const row of archived) {
      if (row.receiptKey) seenReceiptKeys.add(row.receiptKey);
      interactions.push(
        ...extractCardInteractionsFromReceipt({
          actorId: row.actorId,
          at: row.at,
          result: row.result,
          gift: row.gift,
        }),
      );
    }

    const receipts = game?.receipts as
      | Record<
          string,
          {
            actorId?: string;
            at?: string;
            result?: Record<string, unknown>;
            gift?: Record<string, unknown>;
          }
        >
      | undefined;
    if (receipts && typeof receipts === 'object') {
      for (const [key, receipt] of Object.entries(receipts)) {
        if (seenReceiptKeys.has(key) || !receipt?.at) continue;
        const atMs = Date.parse(receipt.at);
        if (Number.isNaN(atMs) || atMs < weekStartMs) continue;
        interactions.push(...extractCardInteractionsFromReceipt(receipt));
      }
    }

    return interactions;
  }

  /** 计算（或命中 30 秒缓存）全团队成员的 11 项称号评估快照。 */
  private async computeTeamSnapshot(teamId: string, bypassCache: boolean): Promise<CachedTeamTitles> {
    const now = new Date();
    const weekKey = getShanghaiWeekKey(now);
    const cached = this.teamCache.get(teamId);
    if (
      !bypassCache &&
      cached &&
      cached.weekKey === weekKey &&
      Date.now() - cached.computedAt < TEAM_CACHE_TTL_MS
    ) {
      return cached;
    }

    const allActive = await this.userRepo.find({ where: { teamId, status: 'active' } });
    const ssoActive = allActive.filter((m) => Boolean(m.logtoUserId));
    // 称号体系仅针对大一至大三（最近 3 级），其他往届成员不纳入计算
    const eligibleGrades = new Set(assessmentEnrollYears(ssoActive.map((m) => m.enrollYear)));
    const members = ssoActive.filter((m) => eligibleGrades.has(m.enrollYear));
    if (members.length === 0) {
      const empty: CachedTeamTitles = { computedAt: Date.now(), weekKey, byUserId: new Map() };
      this.teamCache.set(teamId, empty);
      return empty;
    }

    const lookbackStart = getTitleLookbackStartDate(now);
    const prevWeek1Key = addShanghaiDays(weekKey, -7);
    const prevWeek2Key = addShanghaiDays(weekKey, -14);
    const targetWeeks = [weekKey, prevWeek1Key, prevWeek2Key];
    const currentWeekStartMs = shanghaiDayStartMs(weekKey, 0);

    const [rawSessions, adjRows, entertainmentByUserWeek, cardInteractions] = await Promise.all([
      this.sessionRepo.find({
        where: {
          teamId,
          status: Not('invalidated'),
          checkInAt: MoreThanOrEqual(lookbackStart),
        },
        select: {
          userId: true,
          checkInAt: true,
          checkOutAt: true,
          durationSeconds: true,
          status: true,
          weekKey: true,
        },
      }),
      this.adjRepo.query(
        `SELECT user_id AS "userId",
                week_key AS "weekKey",
                COALESCE(SUM(signed_duration_seconds), 0)::int AS "manualSeconds"
         FROM punch_attendance_duration_adjustments
         WHERE team_id = $1 AND week_key = ANY($2::text[])
         GROUP BY user_id, week_key`,
        [teamId, targetWeeks],
      ) as Promise<Array<{ userId: string; weekKey: string; manualSeconds: number }>>,
      this.loadEntertainmentByUserWeek(teamId, members, targetWeeks),
      this.loadCurrentWeekCardInteractions(teamId, currentWeekStartMs),
    ]);

    const manualAdjustmentsByUserWeek = new Map<string, number>();
    for (const row of adjRows) {
      manualAdjustmentsByUserWeek.set(`${row.userId}:${row.weekKey}`, Number(row.manualSeconds ?? 0));
    }

    const sessions: TitleEngineSession[] = rawSessions.map((s) => ({
      userId: s.userId,
      checkInAt: s.checkInAt instanceof Date ? s.checkInAt : new Date(s.checkInAt),
      checkOutAt: s.checkOutAt
        ? s.checkOutAt instanceof Date
          ? s.checkOutAt
          : new Date(s.checkOutAt)
        : undefined,
      durationSeconds: typeof s.durationSeconds === 'number' ? s.durationSeconds : undefined,
      status: s.status as TitleEngineSession['status'],
      weekKey: s.weekKey,
    }));

    const byUserId = evaluateTeamTitles({
      now,
      members: members.map((m) => ({
        id: m.id,
        enrollYear: m.enrollYear,
        createdAt: m.createdAt,
        equippedTitleId: m.equippedTitleId ?? null,
      })),
      sessions,
      manualAdjustmentsByUserWeek,
      entertainmentByUserWeek,
      currentWeekCardInteractions: cardInteractions,
    });

    const snapshot: CachedTeamTitles = {
      computedAt: Date.now(),
      weekKey,
      byUserId,
    };
    this.teamCache.set(teamId, snapshot);
    return snapshot;
  }
}

@Controller('titles')
@UseGuards(PunchAuthGuard)
export class PunchTitlesController {
  constructor(private readonly service: PunchTitlesService) {}

  @Get('me')
  getMine(@PunchCurrentUser() user: PunchAuthUser) {
    return this.service.getMyTitles(user.teamId, user.userId);
  }

  @Patch('me/equip')
  equip(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const { titleId } = EquipTitleSchema.parse(rawBody ?? {});
    return this.service.equipTitle(user.teamId, user.userId, titleId ?? null);
  }

  @Get('team')
  async getTeam(@PunchCurrentUser() user: PunchAuthUser) {
    const items = await this.service.getTeamDisplayTitlesByMemberKey(user.teamId);
    return { items };
  }
}
