import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMiniAppVersionIconUrl1764200000000 implements MigrationInterface {
  name = 'AddMiniAppVersionIconUrl1764200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE mini_app_versions ADD COLUMN IF NOT EXISTS icon_url TEXT');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE mini_app_versions DROP COLUMN IF EXISTS icon_url');
  }
}
