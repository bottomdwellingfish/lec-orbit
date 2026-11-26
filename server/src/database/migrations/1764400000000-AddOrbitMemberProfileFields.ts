import type { MigrationInterface, QueryRunner } from 'typeorm';

/** 为 orbit_members 增加脱敏公开名片字段（入学年份、组织角色列表、GitHub/飞书公开绑定信息）。 */
export class AddOrbitMemberProfileFields1764400000000 implements MigrationInterface {
  name = 'AddOrbitMemberProfileFields1764400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE orbit_members
        ADD COLUMN IF NOT EXISTS enroll_year INTEGER NULL,
        ADD COLUMN IF NOT EXISTS roles_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS social_json JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE orbit_members
        DROP COLUMN IF EXISTS social_json,
        DROP COLUMN IF EXISTS roles_json,
        DROP COLUMN IF EXISTS enroll_year;
    `);
  }
}
