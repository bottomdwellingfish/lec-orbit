import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** LecPunch 站内通知表（对应原 MongoDB notifications 集合，避免与 Orbit notifications 表冲突）。 */
@Entity({ name: 'punch_notifications' })
@Index('idx_punch_notif_user_ack_created', ['userId', 'acknowledgedAt', 'createdAt'])
@Index('idx_punch_notif_team_audience', ['teamId', 'audience', 'createdAt'])
export class PunchNotificationEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Index()
  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Index()
  @Column({ name: 'user_id', type: 'text', nullable: true })
  userId: string | null;

  @Column({ name: 'audience', type: 'text', default: 'user' })
  audience: 'user' | 'team_admin' | 'team_members';

  @Column({ name: 'recipient_user_ids', type: 'jsonb', nullable: true })
  recipientUserIds: string[] | null;

  @Index({ unique: true, where: 'delivery_key IS NOT NULL' })
  @Column({ name: 'delivery_key', type: 'text', nullable: true })
  deliveryKey: string | null;

  @Column({ name: 'request_hash', type: 'text', nullable: true })
  requestHash: string | null;

  @Column({ name: 'type', type: 'text' })
  type: 'attendance.record_marked' | 'report.submitted' | 'admin.notice';

  @Column({ name: 'title', type: 'text' })
  title: string;

  @Column({ name: 'message', type: 'text' })
  message: string;

  @Column({ name: 'payload', type: 'jsonb', default: () => "'{}'::jsonb" })
  payload: Record<string, unknown>;

  @Column({ name: 'source_type', type: 'text' })
  sourceType: 'attendance_record' | 'report' | 'admin_notice';

  @Column({ name: 'source_id', type: 'text' })
  sourceId: string;

  @Column({ name: 'created_by', type: 'text' })
  createdBy: string;

  @Column({ name: 'acknowledged_at', type: 'timestamptz', nullable: true })
  acknowledgedAt: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

/** LecPunch 广播通知已读回执表（对应原 MongoDB notification_receipts 集合）。 */
@Entity({ name: 'punch_notification_receipts' })
@Index('idx_punch_notif_receipt_unique', ['notificationId', 'userId'], { unique: true })
export class PunchNotificationReceiptEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Column({ name: 'notification_id', type: 'text' })
  notificationId: string;

  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Column({ name: 'read_at', type: 'timestamptz' })
  readAt: Date;
}

export interface PunchReportImageMeta {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/** 匿名/实名反馈举报表（对应原 MongoDB reports 集合）。 */
@Entity({ name: 'punch_reports' })
@Index('idx_punch_reports_team_created', ['teamId', 'createdAt'])
export class PunchReportEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Index()
  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Index()
  @Column({ name: 'reporter_user_id', type: 'text' })
  reporterUserId: string;

  @Column({ name: 'reporter_username', type: 'text' })
  reporterUsername: string;

  @Column({ name: 'reporter_display_name', type: 'text' })
  reporterDisplayName: string;

  @Column({ name: 'description', type: 'text' })
  description: string;

  @Column({ name: 'images', type: 'jsonb', default: () => "'[]'::jsonb" })
  images: PunchReportImageMeta[];

  @Column({ name: 'images_expire_at', type: 'timestamptz', nullable: true })
  imagesExpireAt: Date | null;

  @Column({ name: 'images_purged_at', type: 'timestamptz', nullable: true })
  imagesPurgedAt: Date | null;

  @Column({ name: 'request_key', type: 'text', nullable: true })
  requestKey: string | null;

  @Column({ name: 'request_hash', type: 'text', nullable: true })
  requestHash: string | null;

  @Column({ name: 'notification_pending', type: 'boolean', default: false })
  notificationPending: boolean;

  @Column({ name: 'processing_status', type: 'text', default: 'open' })
  processingStatus: 'open' | 'processed';

  @Column({ name: 'processing_note', type: 'text', nullable: true })
  processingNote: string | null;

  @Column({ name: 'processed_by', type: 'text', nullable: true })
  processedBy: string | null;

  @Column({ name: 'processed_by_display_name', type: 'text', nullable: true })
  processedByDisplayName: string | null;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** GitHub 周报数据源绑定表（对应原 MongoDB github_sources 集合）。 */
@Entity({ name: 'punch_github_sources' })
export class PunchGitHubSourceEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Index({ unique: true })
  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'repo_url', type: 'text' })
  repoUrl: string;

  @Column({ name: 'branch', type: 'text', default: 'main' })
  branch: string;

  @Column({ name: 'index_path', type: 'text', default: 'lecpunch/index.json' })
  indexPath: string;

  @Column({ name: 'access_mode', type: 'text', default: 'public' })
  accessMode: 'public';

  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled: boolean;

  @Column({ name: 'site_url', type: 'text', nullable: true })
  siteUrl: string | null;

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** 成员周报提交记录表（对应原 MongoDB weekly_report_references 集合）。 */
@Entity({ name: 'punch_weekly_report_references' })
@Index('idx_punch_weekly_report_unique', ['userId', 'weekKey'], { unique: true })
export class PunchWeeklyReportRefEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Index()
  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  @Index()
  @Column({ name: 'week_key', type: 'text' })
  weekKey: string;

  @Column({ name: 'github_path', type: 'text', nullable: true })
  githubPath: string | null;

  @Column({ name: 'raw_url', type: 'text', nullable: true })
  rawUrl: string | null;

  @Column({ name: 'commit_sha', type: 'text', nullable: true })
  commitSha: string | null;

  @Column({ name: 'daily_log_count', type: 'int', default: 0 })
  dailyLogCount: number;

  @Column({ name: 'status', type: 'text', default: 'pending' })
  status: 'generated' | 'missing' | 'pending';

  @Column({ name: 'generated_at', type: 'timestamptz', nullable: true })
  generatedAt: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** 团队活动日程表（对应原 MongoDB team_events 集合）。 */
@Entity({ name: 'punch_team_events' })
@Index('idx_punch_team_events_team_at', ['teamId', 'eventAt'])
export class PunchTeamEventEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Index()
  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Column({ name: 'title', type: 'text' })
  title: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'event_at', type: 'timestamptz' })
  eventAt: Date;

  @Column({ name: 'status', type: 'text', default: 'planned' })
  status: 'planned' | 'done' | 'cancelled';

  @Column({ name: 'created_by', type: 'text' })
  createdBy: string;

  @Column({ name: 'updated_by', type: 'text' })
  updatedBy: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** 团队财务账本表（对应原 MongoDB team_ledger_entries 集合）。 */
@Entity({ name: 'punch_team_ledger_entries' })
@Index('idx_punch_ledger_team_occurred', ['teamId', 'occurredAt'])
export class PunchTeamLedgerEntryEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Index()
  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @Column({ name: 'type', type: 'text' })
  type: 'income' | 'expense';

  @Column({ name: 'status', type: 'text', default: 'active' })
  status: 'active' | 'voided';

  @Column({ name: 'amount_cents', type: 'int' })
  amountCents: number;

  @Column({ name: 'category', type: 'text' })
  category: string;

  @Column({ name: 'counterparty', type: 'text', nullable: true })
  counterparty: string | null;

  @Column({ name: 'note', type: 'text', nullable: true })
  note: string | null;

  @Column({ name: 'proof_file_name', type: 'text', nullable: true })
  proofFileName: string | null;

  @Column({ name: 'proof_file_mime_type', type: 'text', nullable: true })
  proofFileMimeType: string | null;

  @Column({ name: 'proof_file_base64', type: 'text', nullable: true })
  proofFileBase64: string | null;

  @Column({ name: 'created_by', type: 'text' })
  createdBy: string;

  @Index()
  @Column({ name: 'reversal_of_entry_id', type: 'text', nullable: true })
  reversalOfEntryId: string | null;

  @Column({ name: 'voided_at', type: 'timestamptz', nullable: true })
  voidedAt: Date | null;

  @Column({ name: 'voided_by', type: 'text', nullable: true })
  voidedBy: string | null;

  @Column({ name: 'void_reason', type: 'text', nullable: true })
  voidReason: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** 皮肤解锁记录表（对应原 MongoDB skin_unlocks 集合）。 */
@Entity({ name: 'punch_skin_unlocks' })
@Index('idx_punch_skin_unlocks_user_skin', ['userId', 'skinId'], { unique: true })
export class PunchSkinUnlockEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Index()
  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'skin_id', type: 'text' })
  skinId: string;

  @Column({ name: 'unlocked_at', type: 'timestamptz' })
  unlockedAt: Date;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
