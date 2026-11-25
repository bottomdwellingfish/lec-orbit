/**
 * MongoDB -> PostgreSQL 20 张 LecPunch 集合无损转换器、确定性校验指纹与期初乐币结转纯函数。
 * 保持 100% 原始 ObjectId 24 位 hex 字符串作为 PG 主键，避免任何嵌套 JSON 外键改写。
 */
import { createHash } from 'node:crypto';
import { getShanghaiWeekKey } from '../../common/utils/week-key.js';

export type MongoDoc = Record<string, unknown>;

/** 将 MongoDB ObjectId / string 安全归一化为字符串 ID。 */
export function normalizeMongoId(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'object' && 'toHexString' in raw && typeof (raw as { toHexString: unknown }).toHexString === 'function') {
    return (raw as { toHexString: () => string }).toHexString();
  }
  return String(raw).trim();
}

export function toDateOrNull(raw: unknown): Date | null {
  if (raw == null) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toDateOrNow(raw: unknown, fallback = new Date()): Date {
  return toDateOrNull(raw) ?? fallback;
}

export function toStrOrNull(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw);
  return s.length > 0 ? s : null;
}

export function toNum(raw: unknown, fallback = 0): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export interface TableMigrationSpec {
  mongoCollection: string;
  pgTable: string;
  columns: string[];
  jsonbColumns?: string[];
  mapDoc: (doc: MongoDoc) => Record<string, unknown>;
}

/** 全部 20 张 LecPunch 集合 -> PostgreSQL 表的无损映射定义。 */
export const PUNCH_TABLE_SPECS: TableMigrationSpec[] = [
  {
    mongoCollection: 'teams',
    pgTable: 'punch_teams',
    columns: ['id', 'name', 'status', 'created_at', 'updated_at'],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      name: String(d.name ?? ''),
      status: String(d.status ?? 'active'),
      created_at: toDateOrNow(d.createdAt),
      updated_at: toDateOrNow(d.updatedAt),
    }),
  },
  {
    mongoCollection: 'users',
    pgTable: 'punch_users',
    columns: [
      'id', 'logto_user_id', 'username', 'password_hash', 'display_name',
      'team_id', 'role', 'status', 'enroll_year', 'student_id', 'real_name',
      'avatar_url', 'admin_message_badge_enabled', 'avatar_base64',
      'avatar_color', 'avatar_emoji', 'equipped_title_id', 'created_at', 'updated_at',
    ],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      logto_user_id: toStrOrNull(d.logtoUserId),
      username: String(d.username ?? ''),
      password_hash: toStrOrNull(d.passwordHash),
      display_name: String(d.displayName ?? d.username ?? ''),
      team_id: normalizeMongoId(d.teamId),
      role: String(d.role ?? 'member'),
      status: String(d.status ?? 'active'),
      enroll_year: Math.trunc(toNum(d.enrollYear, new Date().getUTCFullYear())),
      student_id: toStrOrNull(d.studentId),
      real_name: toStrOrNull(d.realName),
      avatar_url: toStrOrNull(d.avatarUrl),
      admin_message_badge_enabled: d.adminMessageBadgeEnabled !== false,
      avatar_base64: toStrOrNull(d.avatarBase64),
      avatar_color: toStrOrNull(d.avatarColor),
      avatar_emoji: toStrOrNull(d.avatarEmoji),
      equipped_title_id: toStrOrNull(d.equippedTitleId),
      created_at: toDateOrNow(d.createdAt),
      updated_at: toDateOrNow(d.updatedAt),
    }),
  },
  {
    mongoCollection: 'network_policies',
    pgTable: 'punch_network_policies',
    columns: [
      'id', 'team_id', 'allow_any_network', 'allowed_public_ips', 'allowed_cidrs',
      'trust_proxy', 'trusted_proxy_hops', 'wifi_fingerprint_enabled', 'wifi_anchors',
      'wifi_min_match_count', 'wifi_min_rssi', 'created_at', 'updated_at',
    ],
    jsonbColumns: ['allowed_public_ips', 'allowed_cidrs', 'wifi_anchors'],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      team_id: normalizeMongoId(d.teamId),
      allow_any_network: d.allowAnyNetwork !== false,
      allowed_public_ips: Array.isArray(d.allowedPublicIps) ? d.allowedPublicIps : [],
      allowed_cidrs: Array.isArray(d.allowedCidrs) ? d.allowedCidrs : [],
      trust_proxy: Boolean(d.trustProxy),
      trusted_proxy_hops: Math.max(1, Math.trunc(toNum(d.trustedProxyHops, 1))),
      wifi_fingerprint_enabled: Boolean(d.wifiFingerprintEnabled),
      wifi_anchors: Array.isArray(d.wifiAnchors) ? d.wifiAnchors : [],
      wifi_min_match_count: Math.max(1, Math.trunc(toNum(d.wifiMinMatchCount, 2))),
      wifi_min_rssi: Math.trunc(toNum(d.wifiMinRssi, -82)),
      created_at: toDateOrNow(d.createdAt),
      updated_at: toDateOrNow(d.updatedAt),
    }),
  },
  {
    mongoCollection: 'member_eligibilities',
    pgTable: 'punch_member_eligibilities',
    columns: ['id', 'team_id', 'student_id', 'real_name', 'status', 'note', 'created_at', 'updated_at'],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      team_id: normalizeMongoId(d.teamId),
      student_id: String(d.studentId ?? ''),
      real_name: String(d.realName ?? ''),
      status: String(d.status ?? 'allowed'),
      note: toStrOrNull(d.note),
      created_at: toDateOrNow(d.createdAt),
      updated_at: toDateOrNow(d.updatedAt),
    }),
  },
  {
    mongoCollection: 'attendance_sessions',
    pgTable: 'punch_attendance_sessions',
    columns: [
      'id', 'team_id', 'user_id', 'check_in_at', 'check_out_at',
      'last_keepalive_at', 'last_credited_at', 'credited_seconds', 'paused_at',
      'pause_reason', 'segments_count', 'duration_seconds', 'status', 'invalid_reason',
      'source_ip_at_check_in', 'source_ip_at_check_out', 'week_key',
      'weekly_goal_seconds_snapshot', 'is_marked', 'created_at', 'updated_at',
    ],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      team_id: normalizeMongoId(d.teamId),
      user_id: normalizeMongoId(d.userId),
      check_in_at: toDateOrNow(d.checkInAt),
      check_out_at: toDateOrNull(d.checkOutAt),
      last_keepalive_at: toDateOrNull(d.lastKeepaliveAt),
      last_credited_at: toDateOrNull(d.lastCreditedAt),
      credited_seconds: Math.trunc(toNum(d.creditedSeconds, 0)),
      paused_at: toDateOrNull(d.pausedAt),
      pause_reason: toStrOrNull(d.pauseReason),
      segments_count: Math.trunc(toNum(d.segmentsCount, 0)),
      duration_seconds: d.durationSeconds != null ? Math.trunc(toNum(d.durationSeconds, 0)) : null,
      status: String(d.status ?? 'completed'),
      invalid_reason: toStrOrNull(d.invalidReason),
      source_ip_at_check_in: String(d.sourceIpAtCheckIn ?? ''),
      source_ip_at_check_out: toStrOrNull(d.sourceIpAtCheckOut),
      week_key: String(d.weekKey ?? ''),
      weekly_goal_seconds_snapshot:
        d.weeklyGoalSecondsSnapshot != null ? Math.trunc(toNum(d.weeklyGoalSecondsSnapshot)) : null,
      is_marked: Boolean(d.isMarked),
      created_at: toDateOrNow(d.createdAt),
      updated_at: toDateOrNow(d.updatedAt),
    }),
  },
  {
    mongoCollection: 'attendance_duration_adjustments',
    pgTable: 'punch_attendance_duration_adjustments',
    columns: [
      'id', 'team_id', 'user_id', 'username', 'week_key', 'operation',
      'duration_seconds', 'signed_duration_seconds', 'previous_duration_seconds',
      'resulting_duration_seconds', 'created_by', 'reason', 'created_at', 'updated_at',
    ],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      team_id: normalizeMongoId(d.teamId),
      user_id: normalizeMongoId(d.userId),
      username: String(d.username ?? ''),
      week_key: String(d.weekKey ?? ''),
      operation: String(d.operation ?? 'add'),
      duration_seconds: Math.trunc(toNum(d.durationSeconds, 0)),
      signed_duration_seconds: Math.trunc(toNum(d.signedDurationSeconds, 0)),
      previous_duration_seconds: Math.trunc(toNum(d.previousDurationSeconds, 0)),
      resulting_duration_seconds: Math.trunc(toNum(d.resultingDurationSeconds, 0)),
      created_by: normalizeMongoId(d.createdBy),
      reason: toStrOrNull(d.reason),
      created_at: toDateOrNow(d.createdAt),
      updated_at: toDateOrNow(d.updatedAt),
    }),
  },
  {
    mongoCollection: 'attendance_adjustment_buckets',
    pgTable: 'punch_attendance_adjustment_buckets',
    columns: ['id', 'team_id', 'user_id', 'week_key', 'version', 'entries'],
    jsonbColumns: ['entries'],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      team_id: normalizeMongoId(d.teamId),
      user_id: normalizeMongoId(d.userId),
      week_key: String(d.weekKey ?? ''),
      version: Math.trunc(toNum(d.version, 0)),
      entries: Array.isArray(d.entries) ? d.entries : [],
    }),
  },
  {
    mongoCollection: 'point_ledger_entries',
    pgTable: 'punch_point_ledger_entries',
    columns: [
      'id', 'team_id', 'user_id', 'week_key', 'source_type',
      'source_attendance_session_id', 'points', 'created_at', 'updated_at',
    ],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      team_id: normalizeMongoId(d.teamId),
      user_id: normalizeMongoId(d.userId),
      week_key: String(d.weekKey ?? ''),
      source_type: String(d.sourceType ?? 'attendance'),
      source_attendance_session_id: String(d.sourceAttendanceSessionId ?? normalizeMongoId(d._id)),
      points: toNum(d.points, 0),
      created_at: toDateOrNow(d.createdAt),
      updated_at: toDateOrNow(d.updatedAt),
    }),
  },
  {
    mongoCollection: 'card_games',
    pgTable: 'punch_card_games',
    columns: ['id', 'team_id', 'revision', 'start_week', 'state', 'receipts', 'pending_write', 'created_at', 'updated_at'],
    jsonbColumns: ['state', 'receipts', 'pending_write'],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      team_id: normalizeMongoId(d.teamId),
      revision: Math.trunc(toNum(d.revision, 0)),
      start_week: String(d.startWeek ?? ''),
      state: d.state && typeof d.state === 'object' ? d.state : {},
      receipts: d.receipts && typeof d.receipts === 'object' ? d.receipts : {},
      pending_write: d.pendingWrite && typeof d.pendingWrite === 'object' ? d.pendingWrite : null,
      created_at: toDateOrNow(d.createdAt),
      updated_at: toDateOrNow(d.updatedAt),
    }),
  },
  {
    mongoCollection: 'card_action_receipts',
    pgTable: 'punch_card_action_receipts',
    columns: [
      'id', 'team_id', 'receipt_key', 'content_hash', 'actor_id', 'request_key',
      'hash', 'at', 'result', 'gift', 'gift_read_at', 'defenses', 'defense_read_by',
      'interactions', 'interaction_read_by',
    ],
    jsonbColumns: ['result', 'gift', 'defenses', 'defense_read_by', 'interactions', 'interaction_read_by'],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      team_id: normalizeMongoId(d.teamId),
      receipt_key: String(d.receiptKey ?? ''),
      content_hash: String(d.contentHash ?? ''),
      actor_id: normalizeMongoId(d.actorId),
      request_key: String(d.requestKey ?? ''),
      hash: String(d.hash ?? ''),
      at: String(d.at ?? ''),
      result: d.result && typeof d.result === 'object' ? d.result : {},
      gift: d.gift ?? null,
      gift_read_at: toDateOrNull(d.giftReadAt),
      defenses: d.defenses ?? null,
      defense_read_by: d.defenseReadBy ?? null,
      interactions: d.interactions ?? null,
      interaction_read_by: d.interactionReadBy ?? null,
    }),
  },
  {
    mongoCollection: 'card_week_archives',
    pgTable: 'punch_card_week_archives',
    columns: ['id', 'team_id', 'user_id', 'week_key', 'content_hash', 'week'],
    jsonbColumns: ['week'],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      team_id: normalizeMongoId(d.teamId),
      user_id: normalizeMongoId(d.userId),
      week_key: String(d.weekKey ?? ''),
      content_hash: String(d.contentHash ?? ''),
      week: d.week && typeof d.week === 'object' ? d.week : {},
    }),
  },
  {
    mongoCollection: 'assessment_weeks',
    pgTable: 'punch_assessment_weeks',
    columns: ['id', 'team_id', 'week_key', 'revision', 'state', 'created_at', 'updated_at'],
    jsonbColumns: ['state'],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      team_id: normalizeMongoId(d.teamId),
      week_key: String(d.weekKey ?? ''),
      revision: Math.trunc(toNum(d.revision, 0)),
      state: d.state && typeof d.state === 'object' ? d.state : {},
      created_at: toDateOrNow(d.createdAt),
      updated_at: toDateOrNow(d.updatedAt),
    }),
  },
  {
    mongoCollection: 'assessment_memberships',
    pgTable: 'punch_assessment_memberships',
    columns: ['id', 'team_id', 'user_id', 'registered_at', 'created_at', 'updated_at'],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      team_id: normalizeMongoId(d.teamId),
      user_id: normalizeMongoId(d.userId),
      registered_at: toDateOrNow(d.registeredAt),
      created_at: toDateOrNow(d.createdAt),
      updated_at: toDateOrNow(d.updatedAt),
    }),
  },
  {
    mongoCollection: 'notifications',
    pgTable: 'punch_notifications',
    columns: [
      'id', 'team_id', 'user_id', 'audience', 'recipient_user_ids',
      'delivery_key', 'request_hash', 'type', 'title', 'message', 'payload',
      'source_type', 'source_id', 'created_by', 'acknowledged_at', 'created_at',
    ],
    jsonbColumns: ['recipient_user_ids', 'payload'],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      team_id: normalizeMongoId(d.teamId),
      user_id: toStrOrNull(d.userId),
      audience: String(d.audience ?? 'user'),
      recipient_user_ids: Array.isArray(d.recipientUserIds) ? d.recipientUserIds : null,
      delivery_key: toStrOrNull(d.deliveryKey),
      request_hash: toStrOrNull(d.requestHash),
      type: String(d.type ?? 'admin.notice'),
      title: String(d.title ?? ''),
      message: String(d.message ?? ''),
      payload: d.payload && typeof d.payload === 'object' ? d.payload : {},
      source_type: String(d.sourceType ?? 'admin_notice'),
      source_id: String(d.sourceId ?? ''),
      created_by: normalizeMongoId(d.createdBy),
      acknowledged_at: toDateOrNull(d.acknowledgedAt),
      created_at: toDateOrNow(d.createdAt),
    }),
  },
  {
    mongoCollection: 'notification_receipts',
    pgTable: 'punch_notification_receipts',
    columns: ['id', 'notification_id', 'user_id', 'team_id', 'read_at'],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      notification_id: normalizeMongoId(d.notificationId),
      user_id: normalizeMongoId(d.userId),
      team_id: normalizeMongoId(d.teamId),
      read_at: toDateOrNow(d.readAt),
    }),
  },
  {
    mongoCollection: 'reports',
    pgTable: 'punch_reports',
    columns: [
      'id', 'team_id', 'reporter_user_id', 'reporter_username', 'reporter_display_name',
      'description', 'images', 'images_expire_at', 'images_purged_at',
      'request_key', 'request_hash', 'notification_pending', 'processing_status',
      'processing_note', 'processed_by', 'processed_by_display_name', 'processed_at',
      'created_at', 'updated_at',
    ],
    jsonbColumns: ['images'],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      team_id: normalizeMongoId(d.teamId),
      reporter_user_id: normalizeMongoId(d.reporterUserId),
      reporter_username: String(d.reporterUsername ?? ''),
      reporter_display_name: String(d.reporterDisplayName ?? ''),
      description: String(d.description ?? ''),
      images: Array.isArray(d.images) ? d.images : [],
      images_expire_at: toDateOrNull(d.imagesExpireAt),
      images_purged_at: toDateOrNull(d.imagesPurgedAt),
      request_key: toStrOrNull(d.requestKey),
      request_hash: toStrOrNull(d.requestHash),
      notification_pending: Boolean(d.notificationPending),
      processing_status: String(d.processingStatus ?? 'open'),
      processing_note: toStrOrNull(d.processingNote),
      processed_by: toStrOrNull(d.processedBy),
      processed_by_display_name: toStrOrNull(d.processedByDisplayName),
      processed_at: toDateOrNull(d.processedAt),
      created_at: toDateOrNow(d.createdAt),
      updated_at: toDateOrNow(d.updatedAt),
    }),
  },
  {
    mongoCollection: 'github_sources',
    pgTable: 'punch_github_sources',
    columns: [
      'id', 'user_id', 'repo_url', 'branch', 'index_path',
      'access_mode', 'enabled', 'site_url', 'verified_at', 'created_at', 'updated_at',
    ],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      user_id: normalizeMongoId(d.userId),
      repo_url: String(d.repoUrl ?? ''),
      branch: String(d.branch ?? 'main'),
      index_path: String(d.indexPath ?? 'lecpunch/index.json'),
      access_mode: 'public',
      enabled: d.enabled !== false,
      site_url: toStrOrNull(d.siteUrl),
      verified_at: toDateOrNull(d.verifiedAt),
      created_at: toDateOrNow(d.createdAt),
      updated_at: toDateOrNow(d.updatedAt),
    }),
  },
  {
    mongoCollection: 'weekly_report_references',
    pgTable: 'punch_weekly_report_references',
    columns: [
      'id', 'user_id', 'week_key', 'github_path', 'raw_url',
      'commit_sha', 'daily_log_count', 'status', 'generated_at', 'created_at', 'updated_at',
    ],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      user_id: normalizeMongoId(d.userId),
      week_key: String(d.weekKey ?? ''),
      github_path: toStrOrNull(d.githubPath),
      raw_url: toStrOrNull(d.rawUrl),
      commit_sha: toStrOrNull(d.commitSha),
      daily_log_count: Math.trunc(toNum(d.dailyLogCount, 0)),
      status: String(d.status ?? 'pending'),
      generated_at: toDateOrNull(d.generatedAt),
      created_at: toDateOrNow(d.createdAt),
      updated_at: toDateOrNow(d.updatedAt),
    }),
  },
  {
    mongoCollection: 'team_events',
    pgTable: 'punch_team_events',
    columns: [
      'id', 'team_id', 'title', 'description', 'event_at',
      'status', 'created_by', 'updated_by', 'created_at', 'updated_at',
    ],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      team_id: normalizeMongoId(d.teamId),
      title: String(d.title ?? ''),
      description: toStrOrNull(d.description),
      event_at: toDateOrNow(d.eventAt),
      status: String(d.status ?? 'planned'),
      created_by: normalizeMongoId(d.createdBy),
      updated_by: normalizeMongoId(d.updatedBy),
      created_at: toDateOrNow(d.createdAt),
      updated_at: toDateOrNow(d.updatedAt),
    }),
  },
  {
    mongoCollection: 'team_ledger_entries',
    pgTable: 'punch_team_ledger_entries',
    columns: [
      'id', 'team_id', 'occurred_at', 'type', 'status', 'amount_cents',
      'category', 'counterparty', 'note', 'proof_file_name', 'proof_file_mime_type',
      'proof_file_base64', 'created_by', 'reversal_of_entry_id', 'voided_at',
      'voided_by', 'void_reason', 'created_at', 'updated_at',
    ],
    mapDoc: (d) => ({
      id: normalizeMongoId(d._id),
      team_id: normalizeMongoId(d.teamId),
      occurred_at: toDateOrNow(d.occurredAt),
      type: String(d.type ?? 'expense'),
      status: String(d.status ?? 'active'),
      amount_cents: Math.trunc(toNum(d.amountCents, 0)),
      category: String(d.category ?? ''),
      counterparty: toStrOrNull(d.counterparty),
      note: toStrOrNull(d.note),
      proof_file_name: toStrOrNull(d.proofFileName),
      proof_file_mime_type: toStrOrNull(d.proofFileMimeType),
      proof_file_base64: toStrOrNull(d.proofFileBase64),
      created_by: normalizeMongoId(d.createdBy),
      reversal_of_entry_id: toStrOrNull(d.reversalOfEntryId),
      voided_at: toDateOrNull(d.voidedAt),
      voided_by: toStrOrNull(d.voidedBy),
      void_reason: toStrOrNull(d.voidReason),
      created_at: toDateOrNow(d.createdAt),
      updated_at: toDateOrNow(d.updatedAt),
    }),
  },
];

/** 对任意 ID 列表生成确定性 SHA256 指纹（排序后计算，用于逐表零丢行核验）。 */
export function computeIdSetSha256(ids: string[]): string {
  const sorted = [...ids].sort();
  return createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
}

export interface InitialCoinGrant {
  punchUserId: string;
  economyUserId: string; // 优先 logtoUserId（与 Orbit ssoSub 一致），未绑定时回退 punchUserId
  username: string;
  initialCoins: number;
  currentWeekRecordedMinutes: number;
  idempotencyKey: string;
}

/**
 * 计算所有历史成员的期初 coin 乐币 1:1 结转清单：
 * initialCoins = max(0, round(sum(point_ledger_entries.points) + trunc(sum(manual_adjustments) / 60)))
 * 并同步计算当前考核周的真实打卡分钟数，确保上线后 punch_minutes 门槛立即可用。
 */
export function computeInitialCoinGrants(input: {
  users: Array<{ id: string; logtoUserId: string | null; username: string }>;
  pointRows: Array<{ userId: string; points: number }>;
  adjustmentRows: Array<{ userId: string; signedDurationSeconds: number }>;
  currentWeekSessions: Array<{ userId: string; status: string; durationSeconds: number | null }>;
  now?: Date;
}): { weekKey: string; grants: InitialCoinGrant[] } {
  const weekKey = getShanghaiWeekKey(input.now ?? new Date());

  const pointsByUser = new Map<string, number>();
  for (const row of input.pointRows) {
    pointsByUser.set(row.userId, (pointsByUser.get(row.userId) ?? 0) + toNum(row.points, 0));
  }

  const adjSecondsByUser = new Map<string, number>();
  for (const row of input.adjustmentRows) {
    adjSecondsByUser.set(
      row.userId,
      (adjSecondsByUser.get(row.userId) ?? 0) + Math.trunc(toNum(row.signedDurationSeconds, 0)),
    );
  }

  const weekRecSecsByUser = new Map<string, number>();
  for (const s of input.currentWeekSessions) {
    if (s.status !== 'completed') continue;
    weekRecSecsByUser.set(
      s.userId,
      (weekRecSecsByUser.get(s.userId) ?? 0) + Math.max(0, Math.trunc(toNum(s.durationSeconds, 0))),
    );
  }

  const grants: InitialCoinGrant[] = [];
  for (const u of input.users) {
    const rawPoints = pointsByUser.get(u.id) ?? 0;
    const adjMinutes = Math.trunc((adjSecondsByUser.get(u.id) ?? 0) / 60);
    const initialCoins = Math.max(0, Math.round(rawPoints + adjMinutes));
    const currentWeekRecordedMinutes = Math.floor((weekRecSecsByUser.get(u.id) ?? 0) / 60);

    grants.push({
      punchUserId: u.id,
      economyUserId: u.logtoUserId?.trim() || u.id,
      username: u.username,
      initialCoins,
      currentWeekRecordedMinutes,
      idempotencyKey: `migration:init-coin:${u.id}`,
    });
  }

  return { weekKey, grants };
}
