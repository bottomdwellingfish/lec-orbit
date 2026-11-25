import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * 考勤打卡会话表（对应原 MongoDB attendance_sessions 集合）：
 * 数据库级部分唯一索引 (user_id) WHERE status = 'active' 彻底杜绝并发双开打卡。
 */
@Entity({ name: 'punch_attendance_sessions' })
@Index('idx_punch_att_user_status', ['userId', 'status'])
@Index('idx_punch_att_team_week_user', ['teamId', 'weekKey', 'userId'])
@Index('idx_punch_att_user_checkin', ['userId', 'checkInAt'])
@Index('idx_punch_att_team_checkin', ['teamId', 'checkInAt'])
export class PunchAttendanceSessionEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Index()
  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'check_in_at', type: 'timestamptz' })
  checkInAt: Date;

  @Column({ name: 'check_out_at', type: 'timestamptz', nullable: true })
  checkOutAt: Date | null;

  @Column({ name: 'last_keepalive_at', type: 'timestamptz', nullable: true })
  lastKeepaliveAt: Date | null;

  @Column({ name: 'last_credited_at', type: 'timestamptz', nullable: true })
  lastCreditedAt: Date | null;

  @Column({ name: 'credited_seconds', type: 'int', default: 0 })
  creditedSeconds: number;

  @Column({ name: 'paused_at', type: 'timestamptz', nullable: true })
  pausedAt: Date | null;

  @Column({ name: 'pause_reason', type: 'text', nullable: true })
  pauseReason: string | null;

  @Column({ name: 'segments_count', type: 'int', default: 0 })
  segmentsCount: number;

  @Column({ name: 'duration_seconds', type: 'int', nullable: true })
  durationSeconds: number | null;

  @Column({ name: 'status', type: 'text', default: 'active' })
  status: 'active' | 'completed' | 'invalidated';

  @Column({ name: 'invalid_reason', type: 'text', nullable: true })
  invalidReason: string | null;

  @Column({ name: 'source_ip_at_check_in', type: 'text' })
  sourceIpAtCheckIn: string;

  @Column({ name: 'source_ip_at_check_out', type: 'text', nullable: true })
  sourceIpAtCheckOut: string | null;

  @Index()
  @Column({ name: 'week_key', type: 'text' })
  weekKey: string;

  @Column({ name: 'weekly_goal_seconds_snapshot', type: 'int', nullable: true })
  weeklyGoalSecondsSnapshot: number | null;

  @Column({ name: 'is_marked', type: 'boolean', default: false })
  isMarked: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** 管理员手动时长调整历史表（对应原 MongoDB attendance_duration_adjustments 集合）。 */
@Entity({ name: 'punch_attendance_duration_adjustments' })
@Index('idx_punch_adj_team_user_week', ['teamId', 'userId', 'weekKey', 'createdAt'])
export class PunchDurationAdjustmentEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Index()
  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Index()
  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'username', type: 'text' })
  username: string;

  @Index()
  @Column({ name: 'week_key', type: 'text' })
  weekKey: string;

  @Column({ name: 'operation', type: 'text' })
  operation: 'add' | 'subtract';

  @Column({ name: 'duration_seconds', type: 'int' })
  durationSeconds: number;

  @Column({ name: 'signed_duration_seconds', type: 'int' })
  signedDurationSeconds: number;

  @Column({ name: 'previous_duration_seconds', type: 'int' })
  previousDurationSeconds: number;

  @Column({ name: 'resulting_duration_seconds', type: 'int' })
  resultingDurationSeconds: number;

  @Column({ name: 'created_by', type: 'text' })
  createdBy: string;

  @Column({ name: 'reason', type: 'text', nullable: true })
  reason: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

export interface AdjustmentBucketEntry {
  id: string;
  requestKey: string;
  requestHash: string;
  username: string;
  operation: 'add' | 'subtract';
  durationSeconds: number;
  signedDurationSeconds: number;
  previousDurationSeconds: number;
  resultingDurationSeconds: number;
  reason?: string;
  createdBy: string;
  createdAt: string | Date;
}

/** 管理员手动调时乐观锁分桶表（对应原 MongoDB attendance_adjustment_buckets 集合）。 */
@Entity({ name: 'punch_attendance_adjustment_buckets' })
@Index('idx_punch_adj_bucket_unique', ['teamId', 'userId', 'weekKey'], { unique: true })
export class PunchAdjustmentBucketEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'week_key', type: 'text' })
  weekKey: string;

  @Column({ name: 'version', type: 'int', default: 0 })
  version: number;

  @Column({ name: 'entries', type: 'jsonb', default: () => "'[]'::jsonb" })
  entries: AdjustmentBucketEntry[];
}

/** 考勤会话积分审计表（对应原 MongoDB point_ledger_entries 集合，与新 economy_ledger_entries 并行审计）。 */
@Entity({ name: 'punch_point_ledger_entries' })
@Index('idx_punch_pts_user_team_week', ['userId', 'teamId', 'weekKey'])
export class PunchPointLedgerEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Index()
  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Index()
  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  @Index()
  @Column({ name: 'week_key', type: 'text' })
  weekKey: string;

  @Column({ name: 'source_type', type: 'text', default: 'attendance' })
  sourceType: 'attendance' | 'skin_unlock';

  @Index({ unique: true })
  @Column({ name: 'source_attendance_session_id', type: 'text' })
  sourceAttendanceSessionId: string;

  @Column({ name: 'points', type: 'double precision', default: 0 })
  points: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
