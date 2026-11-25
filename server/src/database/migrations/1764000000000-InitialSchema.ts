import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 初始 PostgreSQL 迁移：
 * 1. 幂等兼容原 Orbit Go 服务端已有的 8 张表（CREATE TABLE IF NOT EXISTS）；
 * 2. 新建 Economy（coin 乐币与 punch_minutes 打卡时长交易底层）的 6 张核心表及索引。
 */
export class InitialSchema1764000000000 implements MigrationInterface {
  name = 'InitialSchema1764000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS orbit_members (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL DEFAULT '',
        avatar TEXT NOT NULL DEFAULT '',
        is_captain BOOLEAN NOT NULL DEFAULT FALSE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_orbit_members_is_active ON orbit_members (is_active);

      CREATE TABLE IF NOT EXISTS announcements (
        id UUID PRIMARY KEY,
        title TEXT NOT NULL,
        content_html TEXT NOT NULL,
        content_text TEXT NOT NULL DEFAULT '',
        pinned BOOLEAN NOT NULL DEFAULT FALSE,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL DEFAULT '',
        author_avatar TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        deleted_at TIMESTAMPTZ NULL
      );
      CREATE INDEX IF NOT EXISTS idx_announcements_active_created ON announcements (pinned, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_announcements_deleted_at ON announcements (deleted_at);

      CREATE TABLE IF NOT EXISTS announcement_receipts (
        announcement_id UUID NOT NULL,
        user_id TEXT NOT NULL,
        read_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (announcement_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_announcement_receipts_user ON announcement_receipts (user_id, read_at DESC);

      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY,
        source_app TEXT NOT NULL,
        event_type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        target_user_id TEXT NULL,
        action_status TEXT NULL,
        action_note TEXT NULL,
        action_by TEXT NULL,
        action_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_source_app ON notifications (source_app);
      CREATE INDEX IF NOT EXISTS idx_notifications_target_created ON notifications (target_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications (created_at DESC);

      CREATE TABLE IF NOT EXISTS notification_reads (
        notification_id UUID NOT NULL,
        user_id TEXT NOT NULL,
        read_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (notification_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS mini_apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        engine TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        icon_url TEXT NOT NULL DEFAULT '',
        tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        owner_id TEXT NOT NULL,
        owner_name TEXT NOT NULL DEFAULT '',
        owner_avatar TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        active_version_id UUID NULL,
        featured_rank INT NOT NULL DEFAULT 0,
        play_count BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mini_apps_type ON mini_apps (type);
      CREATE INDEX IF NOT EXISTS idx_mini_apps_engine ON mini_apps (engine);
      CREATE INDEX IF NOT EXISTS idx_mini_apps_owner_id ON mini_apps (owner_id);
      CREATE INDEX IF NOT EXISTS idx_mini_apps_status ON mini_apps (status);

      CREATE TABLE IF NOT EXISTS mini_app_versions (
        id UUID PRIMARY KEY,
        app_id TEXT NOT NULL,
        version TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'preview',
        status TEXT NOT NULL DEFAULT 'pending',
        source_type TEXT NOT NULL DEFAULT 'rustfs',
        bundle_url TEXT NOT NULL,
        bundle_key TEXT NOT NULL DEFAULT '',
        bundle_sha256 TEXT NOT NULL,
        bundle_size BIGINT NOT NULL DEFAULT 0,
        manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        changelog TEXT NOT NULL DEFAULT '',
        uploader_id TEXT NOT NULL,
        reviewer_id TEXT NULL,
        review_note TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        reviewed_at TIMESTAMPTZ NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mini_app_versions_app_created ON mini_app_versions (app_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mini_app_versions_status ON mini_app_versions (status);

      CREATE TABLE IF NOT EXISTS mini_app_kv (
        app_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json JSONB NOT NULL DEFAULT 'null'::jsonb,
        size_bytes INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (app_id, user_id, key)
      );

      CREATE TABLE IF NOT EXISTS economy_accounts (
        user_id TEXT PRIMARY KEY,
        coin_balance INT NOT NULL DEFAULT 0,
        frozen_coins INT NOT NULL DEFAULT 0,
        lifetime_earned_coins INT NOT NULL DEFAULT 0,
        weekly_recorded_minutes INT NOT NULL DEFAULT 0,
        weekly_recorded_week_key TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS economy_holds (
        hold_id UUID PRIMARY KEY,
        order_id UUID NOT NULL,
        app_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount INT NOT NULL,
        week_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        expires_at TIMESTAMPTZ NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_economy_holds_user_status ON economy_holds (user_id, status);
      CREATE INDEX IF NOT EXISTS idx_economy_holds_order ON economy_holds (order_id);
      CREATE INDEX IF NOT EXISTS idx_economy_holds_expires_at ON economy_holds (expires_at);

      CREATE TABLE IF NOT EXISTS economy_ledger_entries (
        entry_id UUID PRIMARY KEY,
        tx_group_id UUID NOT NULL,
        order_id UUID NULL,
        app_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        counterparty_user_id TEXT NULL,
        asset TEXT NOT NULL,
        delta INT NOT NULL,
        counts_toward_lifetime BOOLEAN NOT NULL DEFAULT FALSE,
        week_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_economy_ledger_user_created ON economy_ledger_entries (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_economy_ledger_user_week_asset ON economy_ledger_entries (user_id, week_key, asset);
      CREATE INDEX IF NOT EXISTS idx_economy_ledger_tx_group ON economy_ledger_entries (tx_group_id);

      CREATE TABLE IF NOT EXISTS mini_app_credentials (
        app_id TEXT PRIMARY KEY,
        secret_sealed TEXT NOT NULL,
        secret_prefix TEXT NOT NULL,
        allowed_assets JSONB NOT NULL DEFAULT '[]'::jsonb,
        max_coin_per_order INT NOT NULL DEFAULT 50,
        max_punch_per_order INT NOT NULL DEFAULT 30,
        daily_order_limit INT NOT NULL DEFAULT 200,
        status TEXT NOT NULL DEFAULT 'active',
        rotated_at TIMESTAMPTZ NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS economy_orders (
        id UUID PRIMARY KEY,
        app_id TEXT NOT NULL,
        order_type TEXT NOT NULL,
        external_match_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        asset TEXT NOT NULL,
        amount INT NOT NULL,
        week_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending_accept',
        creator_user_id TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        accept_expires_at TIMESTAMPTZ NOT NULL,
        settle_expires_at TIMESTAMPTZ NULL,
        settled_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_economy_orders_app_id ON economy_orders (app_id);
      CREATE INDEX IF NOT EXISTS idx_economy_orders_status ON economy_orders (status);
      CREATE INDEX IF NOT EXISTS idx_economy_orders_creator ON economy_orders (creator_user_id);
      CREATE INDEX IF NOT EXISTS idx_economy_orders_app_match ON economy_orders (app_id, external_match_id);
      CREATE INDEX IF NOT EXISTS idx_economy_orders_status_exp ON economy_orders (status, accept_expires_at, settle_expires_at);

      CREATE TABLE IF NOT EXISTS economy_order_participants (
        order_id UUID NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        stake_amount INT NOT NULL DEFAULT 0,
        hold_id UUID NULL,
        outcome TEXT NOT NULL DEFAULT '',
        payout_delta INT NOT NULL DEFAULT 0,
        accepted_at TIMESTAMPTZ NULL,
        PRIMARY KEY (order_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_economy_order_participants_user ON economy_order_participants (user_id);
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS economy_order_participants;
      DROP TABLE IF EXISTS economy_orders;
      DROP TABLE IF EXISTS mini_app_credentials;
      DROP TABLE IF EXISTS economy_ledger_entries;
      DROP TABLE IF EXISTS economy_holds;
      DROP TABLE IF EXISTS economy_accounts;
    `);
  }
}
