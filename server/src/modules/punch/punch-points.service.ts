/**
 * 考勤积分与乐币铸币联动服务：
 * - 实现狂热打卡时段判定（同团队同时在岗达到 12 人，整次有效签退享 +10% 乐币加成）；
 * - 签退同步写入 punch_point_ledger_entries 审计表，并进程内调用 EconomyLedgerService.mintCoins()
 *   实时发放 coin 乐币与更新成员本周真实打卡分钟数（供 punch_minutes 赌约风控门槛使用）；
 * - GET /points/me 保持向下兼容老字段，同时返回全新规范的 wallet 乐币余额结构。
 */
import { BadRequestException, Controller, Get, Injectable, Query, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EconomyLedgerService } from '../economy/economy-ledger.service.js';
import {
  PunchAttendanceSessionEntity,
  PunchDurationAdjustmentEntity,
  PunchPointLedgerEntity,
} from './entities/punch-attendance.entities.js';
import { PunchUserEntity } from './entities/punch-core.entities.js';
import { PunchAuthGuard, PunchCurrentUser, type PunchAuthUser } from './punch-auth.guard.js';
import {
  ATTENDANCE_MAX_SECONDS,
  FEVER_ACTIVE_THRESHOLD,
  mondayKeyToIsoWeek,
  newObjectIdHex,
  parseIsoWeekToMondayKey,
} from './punch-shared.util.js';

export interface SessionWindowLike {
  checkInAt: Date;
  checkOutAt: Date | null;
}

/**
 * 扫描线算法：判定目标打卡窗口 [start, end] 内是否与「同团队 >= threshold 人同时在岗」的狂热时段存在重叠。
 */
export function hasFeverOverlap(
  window: { start: Date; end: Date },
  teamSessions: SessionWindowLike[],
  threshold = FEVER_ACTIVE_THRESHOLD,
): boolean {
  const startMs = window.start.getTime();
  const endMs = window.end.getTime();
  if (endMs <= startMs) return false;
  const maxMs = ATTENDANCE_MAX_SECONDS * 1000;

  const deltas = new Map<number, number>();
  for (const s of teamSessions) {
    const sIn = s.checkInAt.getTime();
    const sOut = s.checkOutAt ? s.checkOutAt.getTime() : endMs;
    const from = Math.max(startMs, sIn);
    const until = Math.min(endMs, sOut, sIn + maxMs);
    if (from >= until) continue;
    deltas.set(from, (deltas.get(from) ?? 0) + 1);
    deltas.set(until, (deltas.get(until) ?? 0) - 1);
  }

  let active = 0;
  for (const [, delta] of [...deltas.entries()].sort(([a], [b]) => a - b)) {
    active += delta;
    if (active >= threshold) return true;
  }
  return false;
}

@Injectable()
export class PunchPointsService {
  constructor(
    @InjectRepository(PunchPointLedgerEntity)
    private readonly pointRepo: Repository<PunchPointLedgerEntity>,
    @InjectRepository(PunchAttendanceSessionEntity)
    private readonly sessionRepo: Repository<PunchAttendanceSessionEntity>,
    @InjectRepository(PunchDurationAdjustmentEntity)
    private readonly adjRepo: Repository<PunchDurationAdjustmentEntity>,
    @InjectRepository(PunchUserEntity)
    private readonly userRepo: Repository<PunchUserEntity>,
    private readonly economyLedger: EconomyLedgerService,
  ) {}

  /** 签退同步考勤积分，并进程内向统一 Economy 账本铸造等额 coin 乐币。 */
  async syncAttendancePointsAndMintCoins(input: {
    teamId: string;
    userId: string;
    ssoSub?: string;
    attendanceSessionId: string;
    weekKey: string;
    durationSeconds: number;
    isValid: boolean;
    window?: { start: Date; end: Date };
  }): Promise<{ points: number; mintedCoins: number; isFever: boolean }> {
    const basePoints = input.isValid ? Math.floor(Math.max(0, input.durationSeconds) / 60) : 0;
    let points = basePoints;
    let isFever = false;

    if (basePoints > 0 && input.window) {
      const maxMs = ATTENDANCE_MAX_SECONDS * 1000;
      const lowerBound = new Date(input.window.start.getTime() - maxMs);
      const teamSessions = await this.sessionRepo
        .createQueryBuilder('s')
        .select(['s.checkInAt', 's.checkOutAt'])
        .where('s.team_id = :teamId', { teamId: input.teamId })
        .andWhere('s.check_in_at > :lower AND s.check_in_at < :end', {
          lower: lowerBound,
          end: input.window.end,
        })
        .andWhere('(s.check_out_at > :start OR s.check_out_at IS NULL)', {
          start: input.window.start,
        })
        .getMany();

      isFever = hasFeverOverlap(input.window, teamSessions);
      if (isFever) {
        points = (basePoints * 11) / 10;
      }
    }

    const now = new Date();
    await this.pointRepo.query(
      `INSERT INTO punch_point_ledger_entries (id, team_id, user_id, week_key, source_type, source_attendance_session_id, points, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'attendance', $5, $6, $7, $7)
       ON CONFLICT (source_attendance_session_id) DO UPDATE SET
         points = EXCLUDED.points,
         updated_at = EXCLUDED.updated_at`,
      [newObjectIdHex(), input.teamId, input.userId, input.weekKey, input.attendanceSessionId, points, now],
    );

    // 计算当周累计真实打卡分钟数，同步到 EconomyAccount 供 punch_minutes 参与门槛风控实时校验
    const [weekRecRow] = (await this.sessionRepo.query(
      `SELECT COALESCE(SUM(duration_seconds), 0)::int AS secs
       FROM punch_attendance_sessions
       WHERE team_id = $1 AND user_id = $2 AND week_key = $3 AND status = 'completed'`,
      [input.teamId, input.userId, input.weekKey],
    )) as [{ secs: number }];
    const weeklyRecordedMinutes = Math.floor(Number(weekRecRow?.secs ?? 0) / 60);

    const mintedCoins = Math.round(points);
    if (mintedCoins > 0) {
      let economyUserId = input.ssoSub?.trim() || '';
      if (!economyUserId) {
        const u = await this.userRepo.findOne({
          where: { id: input.userId },
          select: { id: true, logtoUserId: true },
        });
        economyUserId = u?.logtoUserId || input.userId;
      }

      await this.economyLedger.mintCoins({
        userId: economyUserId,
        amount: mintedCoins,
        reason: isFever ? 'fever_bonus' : 'attendance',
        title: isFever
          ? `狂热打卡签退奖励（${basePoints} 分钟 +10%）`
          : `专注打卡签退奖励（${basePoints} 分钟）`,
        idempotencyKey: `punch:attendance:${input.attendanceSessionId}`,
        appId: 'lec-punch',
        weekKey: input.weekKey,
        weeklyRecordedMinutes,
      });
    }

    return { points, mintedCoins, isFever };
  }

  /** 读取成员考勤积分审计摘要 + 统一乐币钱包摘要（向下兼容旧版 GET /points/me）。 */
  async getMyPoints(user: PunchAuthUser, requestedWeek?: string) {
    const mondayKey = parseIsoWeekToMondayKey(requestedWeek);
    if (!mondayKey) {
      throw new BadRequestException({
        code: 'POINTS_WEEK_INVALID',
        message: 'week 必须为有效的 ISO 周（如 2026-W47）或 YYYY-MM-DD',
      });
    }

    const economyUserId = user.ssoSub || user.userId;
    const [[weekRow], [manualWeekRow], wallet, weeklyCoinFlow] = await Promise.all([
      this.pointRepo.query(
        `SELECT COALESCE(SUM(points), 0)::double precision AS total
         FROM punch_point_ledger_entries WHERE team_id = $1 AND user_id = $2 AND week_key = $3`,
        [user.teamId, user.userId, mondayKey],
      ) as Promise<[{ total: number }]>,
      this.adjRepo.query(
        `SELECT COALESCE(SUM(signed_duration_seconds), 0)::int AS secs
         FROM punch_attendance_duration_adjustments WHERE team_id = $1 AND user_id = $2 AND week_key = $3`,
        [user.teamId, user.userId, mondayKey],
      ) as Promise<[{ secs: number }]>,
      this.economyLedger.getWalletSummary(economyUserId),
      this.economyLedger.getWeeklyCoinFlow(economyUserId, mondayKey),
    ]);

    const weekPoints = Math.max(
      0,
      Math.round(Number(weekRow?.total ?? 0) + Math.trunc(Number(manualWeekRow?.secs ?? 0) / 60)),
    );

    return {
      ledgerScope: 'unified-coin-v2' as const,
      // 唯一真相源为统一 coin 乐币余额（余额归零时绝不错误回退历史积分）
      totalPoints: wallet.coinBalance,
      week: mondayKeyToIsoWeek(mondayKey),
      weekPoints,
      drawPoints: {
        weekKey: mondayKey,
        rule: 'unified-coin-v2' as const,
        earned: weeklyCoinFlow.earnedCoins,
        bonus: 0,
        spent: weeklyCoinFlow.spentCoins,
        balance: wallet.coinBalance,
      },
      accrualRate: { focusedMinutes: 1, points: 1 },
      wallet,
      calculatedAt: new Date().toISOString(),
    };
  }
}

@Controller('points')
@UseGuards(PunchAuthGuard)
export class PunchPointsController {
  constructor(private readonly pointsService: PunchPointsService) {}

  @Get('me')
  getMine(@PunchCurrentUser() user: PunchAuthUser, @Query('week') week?: string) {
    return this.pointsService.getMyPoints(user, week);
  }
}
