import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 迁入 LecPunch 全部 20 张 PostgreSQL 业务表（幂等 IF NOT EXISTS）：
 * - 主键均采用 TEXT，直接兼容原 MongoDB 24 位 ObjectId 字符串，确保生产迁移零 ID 重写；
 * - punch_attendance_sessions 建有数据库级部分唯一索引 (user_id) WHERE status = 'active' 防并发双开打卡。
 */
export class AddPunchTables1764100000000 implements MigrationInterface {
  name = 'AddPunchTables1764100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS punch_teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS punch_users (
        id TEXT PRIMARY KEY,
        logto_user_id TEXT NULL,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NULL,
        display_name TEXT NOT NULL,
        team_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        status TEXT NOT NULL DEFAULT 'active',
        enroll_year INT NOT NULL,
        student_id TEXT NULL,
        real_name TEXT NULL,
        avatar_url TEXT NULL,
        admin_message_badge_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        avatar_base64 TEXT NULL,
        avatar_color TEXT NULL,
        avatar_emoji TEXT NULL,
        equipped_title_id TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_punch_users_logto_unique ON punch_users (logto_user_id) WHERE logto_user_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_punch_users_student_unique ON punch_users (student_id) WHERE student_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_punch_users_team_role ON punch_users (team_id, role);

      CREATE TABLE IF NOT EXISTS punch_network_policies (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL UNIQUE,
        allow_any_network BOOLEAN NOT NULL DEFAULT TRUE,
        allowed_public_ips JSONB NOT NULL DEFAULT '[]'::jsonb,
        allowed_cidrs JSONB NOT NULL DEFAULT '[]'::jsonb,
        trust_proxy BOOLEAN NOT NULL DEFAULT FALSE,
        trusted_proxy_hops INT NOT NULL DEFAULT 1,
        wifi_fingerprint_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        wifi_anchors JSONB NOT NULL DEFAULT '[]'::jsonb,
        wifi_min_match_count INT NOT NULL DEFAULT 2,
        wifi_min_rssi INT NOT NULL DEFAULT -82,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS punch_member_eligibilities (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        real_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'allowed',
        note TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (team_id, student_id)
      );
      CREATE INDEX IF NOT EXISTS idx_punch_elig_team_updated ON punch_member_eligibilities (team_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS punch_attendance_sessions (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        check_in_at TIMESTAMPTZ NOT NULL,
        check_out_at TIMESTAMPTZ NULL,
        last_keepalive_at TIMESTAMPTZ NULL,
        last_credited_at TIMESTAMPTZ NULL,
        credited_seconds INT NOT NULL DEFAULT 0,
        paused_at TIMESTAMPTZ NULL,
        pause_reason TEXT NULL,
        segments_count INT NOT NULL DEFAULT 0,
        duration_seconds INT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        invalid_reason TEXT NULL,
        source_ip_at_check_in TEXT NOT NULL,
        source_ip_at_check_out TEXT NULL,
        week_key TEXT NOT NULL,
        weekly_goal_seconds_snapshot INT NULL,
        is_marked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS unique_active_punch_session_per_user
        ON punch_attendance_sessions (user_id) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_punch_att_user_status ON punch_attendance_sessions (user_id, status);
      CREATE INDEX IF NOT EXISTS idx_punch_att_team_week_user ON punch_attendance_sessions (team_id, week_key, user_id);
      CREATE INDEX IF NOT EXISTS idx_punch_att_user_checkin ON punch_attendance_sessions (user_id, check_in_at DESC);
      CREATE INDEX IF NOT EXISTS idx_punch_att_team_checkin ON punch_attendance_sessions (team_id, check_in_at DESC);

      CREATE TABLE IF NOT EXISTS punch_attendance_duration_adjustments (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        week_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        duration_seconds INT NOT NULL,
        signed_duration_seconds INT NOT NULL,
        previous_duration_seconds INT NOT NULL,
        resulting_duration_seconds INT NOT NULL,
        created_by TEXT NOT NULL,
        reason TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_punch_adj_team_user_week
        ON punch_attendance_duration_adjustments (team_id, user_id, week_key, created_at DESC);

      CREATE TABLE IF NOT EXISTS punch_attendance_adjustment_buckets (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        week_key TEXT NOT NULL,
        version INT NOT NULL DEFAULT 0,
        entries JSONB NOT NULL DEFAULT '[]'::jsonb,
        UNIQUE (team_id, user_id, week_key)
      );

      CREATE TABLE IF NOT EXISTS punch_point_ledger_entries (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        week_key TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'attendance',
        source_attendance_session_id TEXT NOT NULL UNIQUE,
        points DOUBLE PRECISION NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_punch_pts_user_team_week
        ON punch_point_ledger_entries (user_id, team_id, week_key);

      CREATE TABLE IF NOT EXISTS punch_card_games (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL UNIQUE,
        revision INT NOT NULL DEFAULT 0,
        start_week TEXT NOT NULL,
        state JSONB NOT NULL DEFAULT '{}'::jsonb,
        receipts JSONB NOT NULL DEFAULT '{}'::jsonb,
        pending_write JSONB NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS punch_card_action_receipts (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        receipt_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        request_key TEXT NOT NULL,
        hash TEXT NOT NULL,
        at TEXT NOT NULL,
        result JSONB NOT NULL,
        gift JSONB NULL,
        gift_read_at TIMESTAMPTZ NULL,
        defenses JSONB NULL,
        defense_read_by JSONB NULL,
        interactions JSONB NULL,
        interaction_read_by JSONB NULL,
        UNIQUE (team_id, receipt_key)
      );
      CREATE INDEX IF NOT EXISTS idx_punch_card_receipt_actor
        ON punch_card_action_receipts (team_id, actor_id, at DESC);

      CREATE TABLE IF NOT EXISTS punch_card_week_archives (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        week_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        week JSONB NOT NULL,
        UNIQUE (team_id, user_id, week_key)
      );
      CREATE INDEX IF NOT EXISTS idx_punch_card_week_team ON punch_card_week_archives (team_id, week_key);

      CREATE TABLE IF NOT EXISTS punch_assessment_weeks (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        week_key TEXT NOT NULL,
        revision INT NOT NULL DEFAULT 0,
        state JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (team_id, week_key)
      );

      CREATE TABLE IF NOT EXISTS punch_assessment_memberships (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        registered_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (team_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS punch_notifications (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        user_id TEXT NULL,
        audience TEXT NOT NULL DEFAULT 'user',
        recipient_user_ids JSONB NULL,
        delivery_key TEXT NULL,
        request_hash TEXT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        acknowledged_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_punch_notif_delivery_unique
        ON punch_notifications (delivery_key) WHERE delivery_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_punch_notif_user_ack_created
        ON punch_notifications (user_id, acknowledged_at, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_punch_notif_team_audience
        ON punch_notifications (team_id, audience, created_at DESC);

      CREATE TABLE IF NOT EXISTS punch_notification_receipts (
        id TEXT PRIMARY KEY,
        notification_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        read_at TIMESTAMPTZ NOT NULL,
        UNIQUE (notification_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS punch_reports (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        reporter_user_id TEXT NOT NULL,
        reporter_username TEXT NOT NULL,
        reporter_display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        images JSONB NOT NULL DEFAULT '[]'::jsonb,
        images_expire_at TIMESTAMPTZ NULL,
        images_purged_at TIMESTAMPTZ NULL,
        request_key TEXT NULL,
        request_hash TEXT NULL,
        notification_pending BOOLEAN NOT NULL DEFAULT FALSE,
        processing_status TEXT NOT NULL DEFAULT 'open',
        processing_note TEXT NULL,
        processed_by TEXT NULL,
        processed_by_display_name TEXT NULL,
        processed_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_punch_reports_req_unique
        ON punch_reports (team_id, reporter_user_id, request_key) WHERE request_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_punch_reports_team_created ON punch_reports (team_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS punch_github_sources (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        repo_url TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT 'main',
        index_path TEXT NOT NULL DEFAULT 'lecpunch/index.json',
        access_mode TEXT NOT NULL DEFAULT 'public',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        site_url TEXT NULL,
        verified_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS punch_weekly_report_references (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        week_key TEXT NOT NULL,
        github_path TEXT NULL,
        raw_url TEXT NULL,
        commit_sha TEXT NULL,
        daily_log_count INT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        generated_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, week_key)
      );

      CREATE TABLE IF NOT EXISTS punch_team_events (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NULL,
        event_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned',
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_punch_team_events_team_at ON punch_team_events (team_id, event_at DESC);

      CREATE TABLE IF NOT EXISTS punch_team_ledger_entries (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        amount_cents INT NOT NULL,
        category TEXT NOT NULL,
        counterparty TEXT NULL,
        note TEXT NULL,
        proof_file_name TEXT NULL,
        proof_file_mime_type TEXT NULL,
        proof_file_base64 TEXT NULL,
        created_by TEXT NOT NULL,
        reversal_of_entry_id TEXT NULL,
        voided_at TIMESTAMPTZ NULL,
        voided_by TEXT NULL,
        void_reason TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_punch_ledger_team_occurred ON punch_team_ledger_entries (team_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_punch_ledger_reversal ON punch_team_ledger_entries (reversal_of_entry_id);

      CREATE TABLE IF NOT EXISTS punch_skin_unlocks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        skin_id TEXT NOT NULL,
        unlocked_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_punch_skin_unlocks_user ON punch_skin_unlocks (user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_punch_skin_unlocks_user_skin ON punch_skin_unlocks (user_id, skin_id);
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS punch_skin_unlocks;
      DROP TABLE IF EXISTS punch_team_ledger_entries;
      DROP TABLE IF EXISTS punch_team_events;
      DROP TABLE IF EXISTS punch_weekly_report_references;
      DROP TABLE IF EXISTS punch_github_sources;
      DROP TABLE IF EXISTS punch_reports;
      DROP TABLE IF EXISTS punch_notification_receipts;
      DROP TABLE IF EXISTS punch_notifications;
      DROP TABLE IF EXISTS punch_assessment_memberships;
      DROP TABLE IF EXISTS punch_assessment_weeks;
      DROP TABLE IF EXISTS punch_card_week_archives;
      DROP TABLE IF EXISTS punch_card_action_receipts;
      DROP TABLE IF EXISTS punch_card_games;
      DROP TABLE IF EXISTS punch_point_ledger_entries;
      DROP TABLE IF EXISTS punch_attendance_adjustment_buckets;
      DROP TABLE IF EXISTS punch_attendance_duration_adjustments;
      DROP TABLE IF EXISTS punch_attendance_sessions;
      DROP TABLE IF EXISTS punch_member_eligibilities;
      DROP TABLE IF EXISTS punch_network_policies;
      DROP TABLE IF EXISTS punch_users;
      DROP TABLE IF EXISTS punch_teams;
    `);
  }
}
