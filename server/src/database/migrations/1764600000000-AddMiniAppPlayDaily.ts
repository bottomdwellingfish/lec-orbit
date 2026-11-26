import type { MigrationInterface, QueryRunner } from 'typeorm';

/** 新增工坊作品按日游玩统计表（支持近 14 天趋势折线图与近 35 天游玩热力图）。 */
export class AddMiniAppPlayDaily1764600000000 implements MigrationInterface {
  name = 'AddMiniAppPlayDaily1764600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS mini_app_play_daily (
        app_id TEXT NOT NULL REFERENCES mini_apps(id) ON DELETE CASCADE,
        day_key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        play_count INT NOT NULL DEFAULT 0,
        total_duration_seconds INT NOT NULL DEFAULT 0,
        PRIMARY KEY (app_id, day_key, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mini_app_play_daily_app_day
        ON mini_app_play_daily (app_id, day_key DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS mini_app_play_daily;`);
  }
}
