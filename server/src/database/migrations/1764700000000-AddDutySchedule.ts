import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDutySchedule1764700000000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`CREATE TABLE orbit_duty_schedule (
      id smallint PRIMARY KEY CHECK (id = 1), anchor date NOT NULL, groups_json jsonb NOT NULL
    )`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query('DROP TABLE orbit_duty_schedule');
  }
}
