/**
 * 周统计、团队排行榜与周考核服务（PostgreSQL TypeORM 版）：
 * - 原生融合 Economy punch_minutes 交易时长与卡牌工坊娱乐时长（含历史周归档与待触发加速结算）；
 * - 内置 60 秒后台周考核观测与跨周自动结算任务（配置 ASSESSMENT_START_WEEK 后自动生效），
 *   与原 LecPunch AssessmentService 100% 规则等价；
 * - 暴露 /stats/* 与 /assessment/* 全部兼容接口。
 */
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { getShanghaiWeekKey } from '../../common/utils/week-key.js';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import { EconomyLedgerService } from '../economy/economy-ledger.service.js';
import {
  PunchAssessmentMembershipEntity,
  PunchAssessmentWeekEntity,
} from './entities/punch-assessment.entities.js';
import {
  PunchAttendanceSessionEntity,
  PunchDurationAdjustmentEntity,
} from './entities/punch-attendance.entities.js';
import { PunchCardGameEntity } from './entities/punch-cards.entities.js';
import { PunchUserEntity } from './entities/punch-core.entities.js';
import {
  ASSESSMENT_SETTLEMENT_DELAY_MS,
  createAssessmentWeek,
  finalizeAssessmentWeek,
  observeAssessmentWeek,
  validateAssessmentStartWeek,
  type AssessmentMemberSnapshot,
  type AssessmentTotals,
  type AssessmentWeekState,
} from './punch-assessment-engine.js';
import { PunchAuthGuard, PunchCurrentUser, type PunchAuthUser } from './punch-auth.guard.js';
import { PunchCardsService } from './punch-cards.service.js';
import {
  assessmentEnrollYears,
  comprehensiveDurationSeconds,
  isValidEnrollmentYear,
  newObjectIdHex,
  requiresWeeklyAssessment,
  weeklyGoalSeconds,
} from './punch-shared.util.js';
import { addShanghaiDays } from './punch-title-engine.js';
import { PunchTitlesService } from './punch-titles.service.js';
import { PunchUsersService } from './punch-users.service.js';

const OBSERVE_INTERVAL_MS = 60_000;

@Injectable()
export class PunchStatsAssessmentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PunchStatsAssessmentService.name);
  private readonly settings: ReturnType<typeof validateAssessmentStartWeek>;
  private timer?: ReturnType<typeof setInterval>;
  private observing = false;

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
    @InjectRepository(PunchAssessmentMembershipEntity)
    private readonly assessMemberRepo: Repository<PunchAssessmentMembershipEntity>,
    private readonly usersService: PunchUsersService,
    private readonly economyLedger: EconomyLedgerService,
    private readonly titlesService: PunchTitlesService,
    private readonly cardsService: PunchCardsService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    this.settings = validateAssessmentStartWeek(this.cfg.assessmentStartWeek);
  }

  async onModuleInit(): Promise<void> {
    if (!this.settings.startWeek || this.cfg.nodeEnv === 'test') return;
    await this.observeSafely();
    this.timer = setInterval(() => {
      void this.observeSafely();
    }, OBSERVE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async observeSafely(): Promise<void> {
    if (this.observing) return;
    this.observing = true;
    try {
      await this.observeNow();
    } catch (err) {
      this.logger.error(`考核观测未完成，不结算失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.observing = false;
    }
  }

  /** 执行全团队周考核观测，并对已结束满 5 小时的历史考核周执行自动结算。 */
  async observeNow(now = Date.now()): Promise<void> {
    const { startWeek, enabledAt } = this.settings;
    const currentWeek = getShanghaiWeekKey(new Date(now));
    if (!startWeek || enabledAt === null || currentWeek < startWeek) return;

    const teamRows = (await this.userRepo
      .createQueryBuilder('u')
      .select('DISTINCT u.team_id', 'teamId')
      .getRawMany()) as Array<{ teamId: string }>;

    for (const row of teamRows) {
      const teamId = row.teamId;
      if (!teamId || !/^[a-f\d]{24}$/i.test(teamId)) continue;
      try {
        await this.observeTeam(teamId, now, startWeek, enabledAt, currentWeek);
      } catch (err) {
        this.logger.error(
          `团队 ${teamId} 周考核观测失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async observedRequiredYears(
    teamId: string,
    enrollYears: Array<number | null | undefined>,
    throughWeek: string,
  ): Promise<number[]> {
    const refYear = Number(throughWeek.slice(0, 4));
    const rows = await this.assessWeekRepo.find({ where: { teamId } });
    const persisted: number[] = [];
    for (const row of rows) {
      if (row.weekKey > throughWeek) continue;
      const years = (row.state as { requiredEnrollYears?: unknown[] } | null)?.requiredEnrollYears;
      if (Array.isArray(years)) {
        for (const y of years) {
          if (isValidEnrollmentYear(y, refYear)) persisted.push(y);
        }
      }
    }
    return assessmentEnrollYears(enrollYears, persisted, refYear);
  }

  private async updateWeekState(
    teamId: string,
    weekKey: string,
    mutate: (state: AssessmentWeekState) => AssessmentWeekState,
  ): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const snapshot = await this.assessWeekRepo.findOne({ where: { teamId, weekKey } });
      if (!snapshot) return;
      const currentState = snapshot.state as unknown as AssessmentWeekState;
      const nextState = mutate(currentState);
      if (JSON.stringify(nextState) === JSON.stringify(currentState)) return;
      const res = await this.assessWeekRepo
        .createQueryBuilder()
        .update(PunchAssessmentWeekEntity)
        .set({
          state: nextState as unknown as never,
          revision: snapshot.revision + 1,
          updatedAt: new Date(),
        })
        .where('team_id = :teamId AND week_key = :weekKey AND revision = :rev', {
          teamId,
          weekKey,
          rev: snapshot.revision,
        })
        .execute();
      if ((res.affected ?? 0) === 1) return;
    }
    throw new Error('考核观测并发冲突，保留上次可信快照');
  }

  private async computeWeekTotals(
    teamId: string,
    weekKey: string,
    userIds: string[],
  ): Promise<Record<string, AssessmentTotals>> {
    if (userIds.length === 0) return {};
    const [members, sessions, adjRows, cardEnt, tradeSummary] = await Promise.all([
      this.userRepo.find({ where: { teamId, id: In(userIds) } }),
      this.sessionRepo.find({
        where: { teamId, weekKey, status: 'completed', userId: In(userIds) },
        select: { userId: true, durationSeconds: true },
      }),
      this.adjRepo.query(
        `SELECT user_id AS "userId", COALESCE(SUM(signed_duration_seconds), 0)::int AS secs
         FROM punch_attendance_duration_adjustments
         WHERE team_id = $1 AND week_key = $2 AND user_id = ANY($3::text[])
         GROUP BY user_id`,
        [teamId, weekKey, userIds],
      ) as Promise<Array<{ userId: string; secs: number }>>,
      this.cardsService.getTeamWeekEntertainment(teamId, weekKey),
      this.economyLedger.getWeeklyTradeMinutesSummary(weekKey),
    ]);

    const rawByUser = new Map<string, number>();
    for (const s of sessions) {
      if (
        typeof s.durationSeconds !== 'number' ||
        !Number.isSafeInteger(s.durationSeconds) ||
        s.durationSeconds < 0 ||
        s.durationSeconds >= 18_000
      ) {
        continue;
      }
      rawByUser.set(s.userId, (rawByUser.get(s.userId) ?? 0) + s.durationSeconds);
    }

    const adjByUser = new Map(adjRows.map((a) => [a.userId, Number(a.secs ?? 0)]));
    const memberById = new Map(members.map((m) => [m.id, m]));
    const tradeMap = new Map(tradeSummary.items.map((t) => [t.userId, t.tradeMinutes]));

    const result: Record<string, AssessmentTotals> = {};
    for (const uid of userIds) {
      const m = memberById.get(uid);
      const tradeMin = tradeMap.get(m?.logtoUserId || uid) ?? 0;
      const entSecs = (cardEnt[uid] ?? 0) + (tradeSummary.affectsAssessment ? tradeMin * 60 : 0);
      result[uid] = {
        rawSeconds: rawByUser.get(uid) ?? 0,
        manualSeconds: adjByUser.get(uid) ?? 0,
        entertainmentSeconds: entSecs,
      };
    }
    return result;
  }

  private async observeTeam(
    teamId: string,
    now: number,
    startWeek: string,
    enabledAt: number,
    currentWeek: string,
  ): Promise<void> {
    const members = await this.userRepo.find({ where: { teamId } });
    if (members.length === 0) return;

    const requiredYears = await this.observedRequiredYears(
      teamId,
      members.map((m) => m.enrollYear),
      currentWeek,
    );

    const nowDate = new Date(now);
    for (const member of members) {
      if (member.status !== 'active') continue;
      await this.assessMemberRepo
        .createQueryBuilder()
        .insert()
        .into(PunchAssessmentMembershipEntity)
        .values({
          id: newObjectIdHex(),
          teamId,
          userId: member.id,
          registeredAt: nowDate,
          createdAt: nowDate,
          updatedAt: nowDate,
        })
        .orIgnore()
        .execute();
    }

    const admissions = await this.assessMemberRepo.find({ where: { teamId } });
    const admittedAt = new Map(admissions.map((a) => [a.userId, a.registeredAt.getTime()]));

    const snapshots: AssessmentMemberSnapshot[] = members.map((m) => ({
      userId: m.id,
      enrollYear: m.enrollYear,
      goalSeconds: Number.isInteger(m.enrollYear) ? weeklyGoalSeconds(m.enrollYear) : null,
      createdAt: m.createdAt ? m.createdAt.getTime() : null,
      joinedAt: admittedAt.get(m.id) ?? null,
      status: m.status === 'active' || m.status === 'disabled' ? m.status : 'unknown',
    }));

    const initialWeek = createAssessmentWeek(currentWeek, now, snapshots, enabledAt, requiredYears);
    await this.assessWeekRepo
      .createQueryBuilder()
      .insert()
      .into(PunchAssessmentWeekEntity)
      .values({
        id: newObjectIdHex(),
        teamId,
        weekKey: currentWeek,
        revision: 0,
        state: initialWeek as unknown as never,
        createdAt: nowDate,
        updatedAt: nowDate,
      })
      .orIgnore()
      .execute();

    await this.updateWeekState(teamId, currentWeek, (state) =>
      observeAssessmentWeek(state, now, snapshots, requiredYears),
    );

    const pastWeeks = await this.assessWeekRepo
      .createQueryBuilder('w')
      .where('w.team_id = :teamId AND w.week_key < :cur AND w.week_key >= :start', {
        teamId,
        cur: currentWeek,
        start: startWeek,
      })
      .getMany();

    for (const week of pastWeeks) {
      const state = week.state as unknown as AssessmentWeekState;
      if (now < state.endsAt + ASSESSMENT_SETTLEMENT_DELAY_MS) continue;
      const rosterIds = Object.keys(state.roster ?? {});
      if (
        rosterIds.every(
          (id) => state.outcomes?.[id] && state.outcomes[id].status !== 'pending',
        )
      ) {
        continue;
      }

      const preliminary = finalizeAssessmentWeek(observeAssessmentWeek(state, now, []), now, {});
      const needsTotals = Object.values(preliminary.outcomes).some(
        (o) => o.status === 'pending' && o.reason === 'invalid_totals',
      );
      const totals = needsTotals ? await this.computeWeekTotals(teamId, week.weekKey, rosterIds) : {};
      await this.updateWeekState(teamId, week.weekKey, (cur) =>
        finalizeAssessmentWeek(observeAssessmentWeek(cur, now, []), now, totals),
      );
    }
  }

  private async loadCardInventoryCounts(teamId: string): Promise<Map<string, number>> {
    const game = await this.cardGameRepo.findOne({ where: { teamId } });
    const result = new Map<string, number>();
    const members = (game?.state?.members ?? {}) as Record<
      string,
      { inventory?: Record<string, number> }
    >;
    for (const [uid, m] of Object.entries(members)) {
      const count = Object.values(m.inventory ?? {}).reduce(
        (sum, qty) => sum + (Number.isFinite(qty) ? qty : 0),
        0,
      );
      result.set(uid, count);
    }
    return result;
  }

  /** 读取个人历史周统计（合并历史卡牌归档、手动调时周、本周以及作废次数统计）。 */
  async getUserWeeklyHistory(teamId: string, userId: string, limit = 24) {
    const member = await this.userRepo.findOne({ where: { id: userId, teamId } });
    if (!member) throw new ForbiddenException('成员不存在');

    const currentWeek = getShanghaiWeekKey(new Date());

    const [sessionRows, adjRows, cardEntHistory] = await Promise.all([
      this.sessionRepo.query(
        `SELECT week_key AS "weekKey",
                COALESCE(SUM(CASE WHEN status = 'completed' AND duration_seconds >= 0 AND duration_seconds < 18000 THEN duration_seconds ELSE 0 END), 0)::int AS "recordedDurationSeconds",
                COUNT(*)::int AS "sessionsCount",
                MAX(weekly_goal_seconds_snapshot)::int AS "goalSnapshot"
         FROM punch_attendance_sessions
         WHERE team_id = $1 AND user_id = $2 AND status <> 'active'
         GROUP BY week_key`,
        [teamId, userId],
      ) as Promise<
        Array<{
          weekKey: string;
          recordedDurationSeconds: number;
          sessionsCount: number;
          goalSnapshot: number | null;
        }>
      >,
      this.adjRepo.query(
        `SELECT week_key AS "weekKey",
                COALESCE(SUM(signed_duration_seconds), 0)::int AS "manualSeconds",
                COUNT(*)::int AS "adjustmentsCount"
         FROM punch_attendance_duration_adjustments
         WHERE team_id = $1 AND user_id = $2
         GROUP BY week_key`,
        [teamId, userId],
      ) as Promise<Array<{ weekKey: string; manualSeconds: number; adjustmentsCount: number }>>,
      this.cardsService.getMemberEntertainmentHistory(teamId, userId),
    ]);

    const rowsByWeek = new Map(sessionRows.map((r) => [r.weekKey, r]));
    const adjMap = new Map(adjRows.map((a) => [a.weekKey, a]));

    for (const wk of [...adjMap.keys(), ...Object.keys(cardEntHistory), currentWeek]) {
      if (!rowsByWeek.has(wk)) {
        rowsByWeek.set(wk, {
          weekKey: wk,
          recordedDurationSeconds: 0,
          sessionsCount: 0,
          goalSnapshot: null,
        });
      }
    }

    const sortedWeeks = [...rowsByWeek.values()]
      .sort((a, b) => b.weekKey.localeCompare(a.weekKey))
      .slice(0, Math.min(Math.max(limit, 1), 52));

    const economyUid = member.logtoUserId || member.id;
    const tradeSummaries = await Promise.all(
      sortedWeeks.map((r) => this.economyLedger.getWeeklyTradeMinutesSummary(r.weekKey)),
    );

    return sortedWeeks.map((r, idx) => {
      const adj = adjMap.get(r.weekKey);
      const tradeSummary = tradeSummaries[idx];
      const tradeMin =
        tradeSummary.items.find((i) => i.userId === economyUid)?.tradeMinutes ?? 0;
      const cardSec = cardEntHistory[r.weekKey] ?? 0;
      const entertainmentSeconds =
        cardSec + (tradeSummary.affectsAssessment ? tradeMin * 60 : 0);

      const recorded = Number(r.recordedDurationSeconds ?? 0);
      const manual = Number(adj?.manualSeconds ?? 0);
      const total = comprehensiveDurationSeconds(recorded, manual, entertainmentSeconds);
      const goal = r.goalSnapshot ?? weeklyGoalSeconds(member.enrollYear);

      return {
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
      };
    });
  }

  /** 读取团队本周排行（支持可选 enrollYear 筛选，完整挂载 avatarBase64、titles 与卡牌娱乐时长）。 */
  async getTeamCurrentWeekRanking(teamId: string, enrollYear?: number) {
    const weekKey = getShanghaiWeekKey(new Date());
    const memberWhere =
      enrollYear !== undefined
        ? { teamId, status: 'active' as const, enrollYear }
        : { teamId, status: 'active' as const };

    const [members, recRows, adjRows, cardEnt, cardCounts, tradeSummary, titlesByUserId] =
      await Promise.all([
        this.userRepo.find({ where: memberWhere }),
        this.sessionRepo.query(
          `SELECT user_id AS "userId",
                  COALESCE(SUM(CASE WHEN status = 'completed' AND duration_seconds >= 0 AND duration_seconds < 18000 THEN duration_seconds ELSE 0 END), 0)::int AS "recordedSeconds",
                  COUNT(*)::int AS "sessionsCount"
           FROM punch_attendance_sessions
           WHERE team_id = $1 AND week_key = $2 AND status <> 'active'
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
        this.cardsService.getTeamWeekEntertainment(teamId, weekKey),
        this.loadCardInventoryCounts(teamId),
        this.economyLedger.getWeeklyTradeMinutesSummary(weekKey),
        this.titlesService.getTeamDisplayTitlesByUserId(teamId).catch(() => undefined),
      ]);

    const recMap = new Map(recRows.map((r) => [r.userId, r]));
    const adjMap = new Map(adjRows.map((a) => [a.userId, a]));
    const tradeMap = new Map(tradeSummary.items.map((t) => [t.userId, t.tradeMinutes]));

    const items = members
      .map((m) => {
        const rec = recMap.get(m.id);
        const adj = adjMap.get(m.id);
        const tradeMin = tradeMap.get(m.logtoUserId || m.id) ?? 0;

        const recorded = Number(rec?.recordedSeconds ?? 0);
        const manual = Number(adj?.manualSeconds ?? 0);
        const cardSec = cardEnt[m.id] ?? 0;
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
          avatarBase64: m.avatarBase64 ?? undefined,
          avatarColor: m.avatarColor ?? undefined,
          avatarEmoji: m.avatarEmoji ?? undefined,
          equippedTitleId: m.equippedTitleId ?? undefined,
          titles: titlesByUserId?.get(m.id) ?? [],
          cardCount: cardCounts.get(m.id) ?? 0,
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

  private async getFailedCountsByUser(teamId: string): Promise<Map<string, number>> {
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
    return failCount;
  }

  async getAssessmentMemberSummaries(teamId: string) {
    const weekKey = getShanghaiWeekKey(new Date());
    const [members, failCount] = await Promise.all([
      this.userRepo.find({ where: { teamId, status: 'active' } }),
      this.getFailedCountsByUser(teamId),
    ]);
    const requiredEnrollYears = await this.observedRequiredYears(
      teamId,
      members.map((m) => m.enrollYear),
      weekKey,
    );

    return {
      enabled: Boolean(this.settings.startWeek),
      requiredEnrollYears,
      startWeek: this.settings.startWeek,
      week: weekKey,
      items: members.map((m) => ({
        memberKey: this.usersService.getMemberKey(m.id),
        failedWeeksCount: failCount.get(m.id) ?? 0,
      })),
    };
  }

  async getAssessmentLeaderboard(user: PunchAuthUser) {
    const [summary, ranking, failCount, members] = await Promise.all([
      this.getAssessmentMemberSummaries(user.teamId),
      this.getTeamCurrentWeekRanking(user.teamId, user.enrollYear),
      this.getFailedCountsByUser(user.teamId),
      this.userRepo.find({ where: { teamId: user.teamId, status: 'active', enrollYear: user.enrollYear } }),
    ]);

    const userIdByKey = new Map(members.map((m) => [this.usersService.getMemberKey(m.id), m.id]));
    const filtered = ranking.items.filter((i) =>
      requiresWeeklyAssessment(i.enrollYear, summary.requiredEnrollYears),
    );

    let prevTotal: number | undefined;
    let rank = 0;
    const items = filtered.map((row, idx) => {
      if (prevTotal !== row.totalDurationSeconds) rank = idx + 1;
      prevTotal = row.totalDurationSeconds;
      const uid = userIdByKey.get(row.memberKey) ?? '';
      return {
        ...row,
        rank,
        failedWeeksCount: failCount.get(uid) ?? 0,
      };
    });

    return {
      enabled: Boolean(this.settings.startWeek),
      startWeek: this.settings.startWeek,
      week: ranking.weekKey,
      requiredEnrollYears: summary.requiredEnrollYears,
      settlementNote: this.settings.startWeek
        ? '从启用后首次登记参与；首次登记当周免考，因此最早下一个完整周产生结果。停用成员豁免，缺少完整观测保持待核实，周结束五小时后结算。'
        : '历史考核尚未启用，不记录未完成周；等待确认起算周。',
      items,
    };
  }

  async getAssessmentHistory(teamId: string, userId: string, before?: string, limit = 20) {
    const member = await this.userRepo.findOne({ where: { id: userId, teamId } });
    if (!member) throw new NotFoundException('成员不存在');
    if (before) {
      try {
        validateAssessmentStartWeek(before);
      } catch {
        throw new BadRequestException('before 必须为北京时间周一 yyyy-MM-dd');
      }
    }
    const safeLimit = Math.min(Math.max(limit, 1), 100);

    const qb = this.assessWeekRepo
      .createQueryBuilder('w')
      .where('w.team_id = :teamId', { teamId })
      .orderBy('w.week_key', 'DESC');
    if (before) {
      qb.andWhere('w.week_key < :before', { before });
    }
    const allWeeks = await qb.getMany();
    const failedCounts = await this.getFailedCountsByUser(teamId);

    const matched: Array<{
      weekKey: string;
      weekEnd: string;
      assessmentDate: string;
      goalSeconds: number;
      recordedDurationSeconds: number;
      manualAdjustmentSeconds: number;
      entertainmentSeconds: number;
      totalDurationSeconds: number;
      shortfallSeconds: number;
      settledAt: string;
    }> = [];

    for (const w of allWeeks) {
      const state = w.state as unknown as AssessmentWeekState;
      const outcome = state?.outcomes?.[userId];
      if (outcome && outcome.status === 'failed') {
        const goal = Number(outcome.goalSeconds ?? 0);
        const comp = Number(outcome.comprehensiveSeconds ?? 0);
        matched.push({
          weekKey: w.weekKey,
          weekEnd: new Date(state.endsAt).toISOString(),
          assessmentDate: addShanghaiDays(w.weekKey, 6),
          goalSeconds: goal,
          recordedDurationSeconds: Number(outcome.rawSeconds ?? 0),
          manualAdjustmentSeconds: Number(outcome.manualSeconds ?? 0),
          entertainmentSeconds: Number(outcome.entertainmentSeconds ?? 0),
          totalDurationSeconds: comp,
          shortfallSeconds: Math.max(0, goal - comp),
          settledAt: outcome.settledAt
            ? new Date(outcome.settledAt).toISOString()
            : w.updatedAt.toISOString(),
        });
      }
    }

    const pageItems = matched.slice(0, safeLimit);
    return {
      member: {
        memberKey: this.usersService.getMemberKey(member.id),
        displayName: member.displayName,
      },
      failedWeeksCount: failedCounts.get(member.id) ?? 0,
      items: pageItems,
      nextCursor: matched.length > safeLimit ? pageItems[pageItems.length - 1].weekKey : null,
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
  myWeekly(@PunchCurrentUser() user: PunchAuthUser, @Query('limit') limit?: string) {
    return this.service.getUserWeeklyHistory(
      user.teamId,
      user.userId,
      limit ? Number.parseInt(limit, 10) || 24 : 24,
    );
  }

  @Get('stats/team/current-week')
  teamCurrentWeek(
    @PunchCurrentUser() user: PunchAuthUser,
    @Query('enrollYear') rawEnrollYear?: string,
  ) {
    const enrollYear =
      rawEnrollYear !== undefined && rawEnrollYear.trim() !== ''
        ? Number.parseInt(rawEnrollYear, 10)
        : undefined;
    if (enrollYear !== undefined && !Number.isInteger(enrollYear)) {
      throw new BadRequestException('enrollYear 必须为整数');
    }
    return this.service.getTeamCurrentWeekRanking(user.teamId, enrollYear);
  }

  @Get('stats/member/:memberKey/weekly')
  memberWeekly(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('memberKey') memberKey: string,
    @Query('limit') limit?: string,
  ) {
    const uid = this.usersService.resolveMemberKey(memberKey);
    if (!uid) throw new BadRequestException('无效的 memberKey');
    return this.service.getUserWeeklyHistory(
      user.teamId,
      uid,
      limit ? Number.parseInt(limit, 10) || 24 : 24,
    );
  }

  @Get('assessment/leaderboard')
  leaderboard(@PunchCurrentUser() user: PunchAuthUser) {
    return this.service.getAssessmentLeaderboard(user);
  }

  @Get('assessment/member-summaries')
  summaries(@PunchCurrentUser() user: PunchAuthUser) {
    return this.service.getAssessmentMemberSummaries(user.teamId);
  }

  @Get('assessment/me/history')
  myHistory(
    @PunchCurrentUser() user: PunchAuthUser,
    @Query('before') before?: string,
    @Query('limit') limit = '20',
  ) {
    return this.service.getAssessmentHistory(
      user.teamId,
      user.userId,
      before?.trim() || undefined,
      Number.parseInt(limit, 10) || 20,
    );
  }

  @Get('assessment/members/:memberKey/history')
  memberHistory(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('memberKey') memberKey: string,
    @Query('before') before?: string,
    @Query('limit') limit = '20',
  ) {
    const uid = this.usersService.resolveMemberKey(memberKey);
    if (!uid) throw new BadRequestException('无效的 memberKey');
    return this.service.getAssessmentHistory(
      user.teamId,
      uid,
      before?.trim() || undefined,
      Number.parseInt(limit, 10) || 20,
    );
  }
}
