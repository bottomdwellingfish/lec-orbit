import type { MigrationInterface, QueryRunner } from 'typeorm';

/** 新增工坊托管云函数（方案 E）所需的 3 张隔离表：函数包、应用全局 KV 与加密环境变量。 */
export class AddMiniAppFunctions1764300000000 implements MigrationInterface {
  name = 'AddMiniAppFunctions1764300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS mini_app_function_bundles (
        version_id UUID PRIMARY KEY,
        app_id TEXT NOT NULL,
        version TEXT NOT NULL,
        routes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        files_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        timeout_ms INT NOT NULL DEFAULT 5000,
        allow_streaming BOOLEAN NOT NULL DEFAULT FALSE,
        sha256 TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_mini_app_fn_bundles_app ON mini_app_function_bundles (app_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS mini_app_global_kv (
        app_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json JSONB NOT NULL DEFAULT 'null'::jsonb,
        size_bytes INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (app_id, key)
      );

      CREATE TABLE IF NOT EXISTS mini_app_secrets (
        app_id TEXT NOT NULL,
        name TEXT NOT NULL,
        value_sealed TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (app_id, name)
      );
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS mini_app_secrets;
      DROP TABLE IF EXISTS mini_app_global_kv;
      DROP TABLE IF EXISTS mini_app_function_bundles;
    `);
  }
}
