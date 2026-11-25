/**
 * 周统计、团队排行榜与周考核服务（PostgreSQL TypeORM 版，原生融合 Economy punch_minutes 交易时长）：
 * - 综合时长 = recorded + manual + cardEntertainment + (punchAffectsAssessment ? orbitTradeMinutes * 60 : 0)
 * - 同时暴露 /stats/* 与 /assessment/* 全部兼容接口。
 */
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { getShanghaiWeekKey } from '../../common/utils/week-key.js';
import { EconomyLedgerService } from '../economy/economy-ledger.service.js';
import { PunchAssessmentWeekEntity } from './entities/punch-assessment.entities.js';
import {
  PunchAttendanceSessionEntity,
  PunchDurationAdjustmentEntity,
} from './entities/punch-attendance.entities.js';
import { PunchCardGameEntity } from './entities/punch-cards.entities.js';
import { PunchUserEntity } from './entities/punch-core.entities.js';
import { PunchAuthGuard, PunchCurrentUser, type PunchAuthUser } from './punch-auth.guard.js';
import {
  assessmentEnrollYears,
  comprehensiveDurationSeconds,
  weeklyGoalSeconds,
} from './punch-shared.util.js';
import { PunchUsersService } from './punch-users.service.js';

@Injectable()
export class PunchStatsAssessmentService {
  constructor(
    @InjectRepository(PunchAttendanceSessionEntity)
    private readonly sessionRepo: Repository<PunchAttendanceSessionEntity>,
    @InjectRepository(PunchDurationAdjustmentEntity)
    private readonly adjRepo: Repository<PunchDurationAdjustmentEntity>,
    @InjectRepository(PunchUserEntity)
    private readonly userRepo: Repository<PunchUserEntity>,
    @InjectRepository(PunchCardGameEntity)
    private readonly cardGameRepo: Repository<PunchCardGameEntity>,
    @InjectRepository(PunchAssessmentWeekEntity)
    private readonly assessWeekRepo: Repository<PunchAssessmentWeekEntity>,
    private readonly usersService: PunchUsersService,
    private readonly economyLedger: EconomyLedgerService,
  ) {}

  private async loadCardEntertainmentMap(
    teamId: string,
    weekKey: string,
  ): Promise<Map<string, { entertainmentSeconds: number; cardCount: number }>> {
    const game = await this.cardGameRepo.findOne({ where: { teamId } });
    const result = new Map<string, { entertainmentSeconds: number; cardCount: number }>();
    if (!game?.state) return result;
    const members = (game.state.members ?? {}) as Record<
      string,
      {
        inventory?: Record<string, number>;
        weeks?: Record<string, { entertainmentSeconds?: number }>;
      }
    >;
    for (const [uid, m] of Object.entries(members)) {
      const cardCount = Object.values(m.inventory ?? {}).reduce(
        (sum, qty) => sum + (Number.isFinite(qty) ? qty : 0),
        0,
      );
      const entSecs = Number(m.weeks?.[weekKey]?.entertainmentSeconds ?? 0);
      result.set(uid, { entertainmentSeconds: entSecs, cardCount });
    }
    return result;
  }

  async getUserWeeklyHistory(teamId: string, userId: string) {
    const member = await this.userRepo.findOne({ where: { id: userId, teamId } });
    if (!member) throw new ForbiddenException('成员不存在');

    const rows = (await this.sessionRepo.query(
      `SELECT week_key AS "weekKey",
              COALESCE(SUM(duration_seconds), 0)::int AS "recordedDurationSeconds",
              COUNT(*)::int AS "sessionsCount",
              MAX(weekly_goal_seconds_snapshot)::int AS "goalSnapshot"
       FROM punch_attendance_sessions
       WHERE team_id = $1 AND user_id = $2 AND status = 'completed'
       GROUP BY week_key
       ORDER BY week_key DESC
       LIMIT 24`,
      [teamId, userId],
    )) as Array<{
      weekKey: string;
      recordedDurationSeconds: number;
      sessionsCount: number;
      goalSnapshot: number | null;
    }>;

    const adjRows = (await this.adjRepo.query(
      `SELECT week_key AS "weekKey",
              COALESCE(SUM(signed_duration_seconds), 0)::int AS "manualSeconds",
              COUNT(*)::int AS "adjustmentsCount"
       FROM punch_attendance_duration_adjustments
       WHERE team_id = $1 AND user_id = $2
       GROUP BY week_key`,
      [teamId, userId],
    )) as Array<{ weekKey: string; manualSeconds: number; adjustmentsCount: number }>;
    const adjMap = new Map(adjRows.map((a) => [a.weekKey, a]));

    const items = [];
    for (const r of rows) {
      const adj = adjMap.get(r.weekKey);
      const cardMap = await this.loadCardEntertainmentMap(teamId, r.weekKey);
      const tradeSummary = await this.economyLedger.getWeeklyTradeMinutesSummary(r.weekKey);
      const economyUid = member.logtoUserId || member.id;
      const tradeMin =
        tradeSummary.items.find((i) => i.userId === economyUid)?.tradeMinutes ?? 0;
      const cardSec = cardMap.get(userId)?.entertainmentSeconds ?? 0;
      const entertainmentSeconds =
        cardSec + (tradeSummary.affectsAssessment ? tradeMin * 60 : 0);

      const recorded = Number(r.recordedDurationSeconds ?? 0);
      const manual = Number(adj?.manualSeconds ?? 0);
      const total = comprehensiveDurationSeconds(recorded, manual, entertainmentSeconds);
      const goal = r.goalSnapshot ?? weeklyGoalSeconds(member.enrollYear);

      items.push({
        weekKey: r.weekKey,
        recordedDurationSeconds: recorded,
        manualAdjustmentSeconds: manual,
        adjustmentsCount: Number(adj?.adjustmentsCount ?? 0),
        sessionsCount: Number(r.sessionsCount ?? 0),
        entertainmentSeconds,
        tradeMinutes: tradeMin,
        totalDurationSeconds: total,
        weeklyGoalSeconds: goal,
        assessmentComplete: total >= goal,
      });
    }
    return items;
  }

  async getTeamCurrentWeekRanking(teamId: string) {
    const weekKey = getShanghaiWeekKey(new Date());
    const [members, recRows, adjRows, cardMap, tradeSummary] = await Promise.all([
      this.userRepo.find({ where: { teamId, status: 'active' } }),
      this.sessionRepo.query(
        `SELECT user_id AS "userId",
                COALESCE(SUM(duration_seconds), 0)::int AS "recordedSeconds",
                COUNT(*)::int AS "sessionsCount"
         FROM punch_attendance_sessions
         WHERE team_id = $1 AND week_key = $2 AND status = 'completed'
         GROUP BY user_id`,
        [teamId, weekKey],
      ) as Promise<Array<{ userId: string; recordedSeconds: number; sessionsCount: number }>>,
      this.adjRepo.query(
        `SELECT user_id AS "userId",
                COALESCE(SUM(signed_duration_seconds), 0)::int AS "manualSeconds",
                COUNT(*)::int AS "adjustmentsCount"
         FROM punch_attendance_duration_adjustments
         WHERE team_id = $1 AND week_key = $2
         GROUP BY user_id`,
        [teamId, weekKey],
      ) as Promise<Array<{ userId: string; manualSeconds: number; adjustmentsCount: number }>>,
      this.loadCardEntertainmentMap(teamId, weekKey),
      this.economyLedger.getWeeklyTradeMinutesSummary(weekKey),
    ]);

    const recMap = new Map(recRows.map((r) => [r.userId, r]));
    const adjMap = new Map(adjRows.map((a) => [a.userId, a]));
    const tradeMap = new Map(tradeSummary.items.map((t) => [t.userId, t.tradeMinutes]));

    const items = members
      .map((m) => {
        const rec = recMap.get(m.id);
        const adj = adjMap.get(m.id);
        const card = cardMap.get(m.id);
        const tradeMin = tradeMap.get(m.logtoUserId || m.id) ?? 0;

        const recorded = Number(rec?.recordedSeconds ?? 0);
        const manual = Number(adj?.manualSeconds ?? 0);
        const cardSec = card?.entertainmentSeconds ?? 0;
        const entertainmentSeconds =
          cardSec + (tradeSummary.affectsAssessment ? tradeMin * 60 : 0);
        const total = comprehensiveDurationSeconds(recorded, manual, entertainmentSeconds);
        const goal = weeklyGoalSeconds(m.enrollYear);

        return {
          weekKey,
          memberKey: this.usersService.getMemberKey(m.id),
          displayName: m.displayName,
          username: m.username,
          realName: m.realName ?? undefined,
          role: m.role,
          enrollYear: m.enrollYear,
          avatarUrl: m.avatarUrl ?? undefined,
          avatarColor: m.avatarColor ?? undefined,
          avatarEmoji: m.avatarEmoji ?? undefined,
          equippedTitleId: m.equippedTitleId ?? undefined,
          cardCount: card?.cardCount ?? 0,
          recordedDurationSeconds: recorded,
          manualAdjustmentSeconds: manual,
          adjustmentsCount: Number(adj?.adjustmentsCount ?? 0),
          sessionsCount: Number(rec?.sessionsCount ?? 0),
          entertainmentSeconds,
          tradeMinutes: tradeMin,
          totalDurationSeconds: total,
          weeklyGoalSeconds: goal,
          assessmentComplete: total >= goal,
        };
      })
      .sort((a, b) => b.totalDurationSeconds - a.totalDurationSeconds)
      .map((item, idx) => ({ ...item, rank: idx + 1 }));

    return { weekKey, items };
  }

  async getAssessmentLeaderboard(teamId: string) {
    const ranking = await this.getTeamCurrentWeekRanking(teamId);
    const requiredYears = assessmentEnrollYears(ranking.items.map((i) => i.enrollYear));
    return {
      enabled: true,
      week: ranking.weekKey,
      requiredEnrollYears: requiredYears,
      items: ranking.items.filter((i) => requiredYears.includes(i.enrollYear)),
    };
  }

  async getAssessmentMemberSummaries(teamId: string) {
    const weekKey = getShanghaiWeekKey(new Date());
    const members = await this.userRepo.find({ where: { teamId, status: 'active' } });
    const weeks = await this.assessWeekRepo.find({ where: { teamId } });

    const failCount = new Map<string, number>();
    for (const w of weeks) {
      const outcomes = (w.state?.outcomes ?? {}) as Record<string, { status?: string }>;
      for (const [uid, outcome] of Object.entries(outcomes)) {
        if (outcome?.status === 'failed') {
          failCount.set(uid, (failCount.get(uid) ?? 0) + 1);
        }
      }
    }

    return {
      enabled: true,
      requiredEnrollYears: assessmentEnrollYears(members.map((m) => m.enrollYear)),
      startWeek: weeks[0]?.weekKey ?? null,
      week: weekKey,
      items: members.map((m) => ({
        memberKey: this.usersService.getMemberKey(m.id),
        failedWeeksCount: failCount.get(m.id) ?? 0,
      })),
    };
  }

  async getAssessmentHistory(teamId: string, userId: string, limit = 20) {
    const member = await this.userRepo.findOne({ where: { id: userId, teamId } });
    if (!member) throw new ForbiddenException('成员不存在');
    const weeks = await this.assessWeekRepo.find({
      where: { teamId },
      order: { weekKey: 'DESC' },
      take: Math.min(Math.max(limit, 1), 100),
    });

    const items: unknown[] = [];
    for (const w of weeks) {
      const outcomes = (w.state?.outcomes ?? {}) as Record<string, Record<string, unknown>>;
      const outcome = outcomes[userId];
      if (outcome && outcome.status === 'failed') {
        items.push({
          weekKey: w.weekKey,
          goalSeconds: outcome.goalSeconds ?? 0,
          recordedDurationSeconds: outcome.rawSeconds ?? 0,
          manualAdjustmentSeconds: outcome.manualSeconds ?? 0,
          entertainmentSeconds: outcome.entertainmentSeconds ?? 0,
          totalDurationSeconds: outcome.comprehensiveSeconds ?? 0,
          shortfallSeconds: Math.max(
            0,
            Number(outcome.goalSeconds ?? 0) - Number(outcome.comprehensiveSeconds ?? 0),
          ),
          settledAt: outcome.settledAt ?? w.updatedAt.toISOString(),
        });
      }
    }

    return {
      member: {
        memberKey: this.usersService.getMemberKey(member.id),
        displayName: member.displayName,
      },
      failedWeeksCount: items.length,
      items,
      nextCursor: null,
    };
  }
}

@Controller()
@UseGuards(PunchAuthGuard)
export class PunchStatsAssessmentController {
  constructor(
    private readonly service: PunchStatsAssessmentService,
    private readonly usersService: PunchUsersService,
  ) {}

  @Get('stats/me/weekly')
  myWeekly(@PunchCurrentUser() user: PunchAuthUser) {
    return this.service.getUserWeeklyHistory(user.teamId, user.userId);
  }

  @Get('stats/team/current-week')
  teamCurrentWeek(@PunchCurrentUser() user: PunchAuthUser) {
    return this.service.getTeamCurrentWeekRanking(user.teamId);
  }

  @Get('stats/member/:memberKey/weekly')
  memberWeekly(@PunchCurrentUser() user: PunchAuthUser, @Param('memberKey') memberKey: string) {
    const uid = this.usersService.resolveMemberKey(memberKey);
    if (!uid) throw new BadRequestException('无效的 memberKey');
    return this.service.getUserWeeklyHistory(user.teamId, uid);
  }

  @Get('assessment/leaderboard')
  leaderboard(@PunchCurrentUser() user: PunchAuthUser) {
    return this.service.getAssessmentLeaderboard(user.teamId);
  }

  @Get('assessment/member-summaries')
  summaries(@PunchCurrentUser() user: PunchAuthUser) {
    return this.service.getAssessmentMemberSummaries(user.teamId);
  }

  @Get('assessment/me/history')
  myHistory(@PunchCurrentUser() user: PunchAuthUser, @Query('limit') limit = '20') {
    return this.service.getAssessmentHistory(user.teamId, user.userId, Number.parseInt(limit, 10) || 20);
  }

  @Get('assessment/members/:memberKey/history')
  memberHistory(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('memberKey') memberKey: string,
    @Query('limit') limit = '20',
  ) {
    const uid = this.usersService.resolveMemberKey(memberKey);
    if (!uid) throw new BadRequestException('无效的 memberKey');
    return this.service.getAssessmentHistory(user.teamId, uid, Number.parseInt(limit, 10) || 20);
  }
}
