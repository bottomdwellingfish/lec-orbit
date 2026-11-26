import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 新增工坊互动统计与评分防刷两张表：
 * - mini_app_play_records：按作品 + 玩家记录累计游玩次数、时长与最近游玩时间（支持作者查看游玩明细与排行榜）；
 * - mini_app_ratings：按作品 + 玩家记录不叠加的评分机会（0/1）、评分星级/短评与每日防刷计数。
 */
export class AddMiniAppEngagementTables1764500000000 implements MigrationInterface {
  name = 'AddMiniAppEngagementTables1764500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS mini_app_play_records (
        app_id TEXT NOT NULL REFERENCES mini_apps(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        play_count INT NOT NULL DEFAULT 0,
        total_duration_seconds INT NOT NULL DEFAULT 0,
        last_session_seconds INT NOT NULL DEFAULT 0,
        first_played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (app_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mini_app_play_records_app_last
        ON mini_app_play_records (app_id, last_played_at DESC);

      CREATE TABLE IF NOT EXISTS mini_app_ratings (
        app_id TEXT NOT NULL REFERENCES mini_apps(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        score SMALLINT NULL CHECK (score IS NULL OR (score >= 1 AND score <= 5)),
        comment TEXT NOT NULL DEFAULT '',
        rating_chances SMALLINT NOT NULL DEFAULT 0 CHECK (rating_chances >= 0 AND rating_chances <= 1),
        rated_count INT NOT NULL DEFAULT 0,
        last_rated_day TEXT NOT NULL DEFAULT '',
        today_rated_count SMALLINT NOT NULL DEFAULT 0,
        rated_at TIMESTAMPTZ NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (app_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mini_app_ratings_app_score
        ON mini_app_ratings (app_id, score);
      CREATE INDEX IF NOT EXISTS idx_mini_app_ratings_user_day
        ON mini_app_ratings (user_id, last_rated_day);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS mini_app_ratings;
      DROP TABLE IF EXISTS mini_app_play_records;
    `);
  }
}
