import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** 周考核结果结算快照表（对应原 MongoDB assessment_weeks 集合）。 */
@Entity({ name: 'punch_assessment_weeks' })
@Index('idx_punch_assess_week_unique', ['teamId', 'weekKey'], { unique: true })
export class PunchAssessmentWeekEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Column({ name: 'week_key', type: 'text' })
  weekKey: string;

  @Column({ name: 'revision', type: 'int', default: 0 })
  revision: number;

  @Column({ name: 'state', type: 'jsonb' })
  state: Record<string, unknown>;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** 考核成员首次入组时间表（对应原 MongoDB assessment_memberships 集合）。 */
@Entity({ name: 'punch_assessment_memberships' })
@Index('idx_punch_assess_member_unique', ['teamId', 'userId'], { unique: true })
export class PunchAssessmentMembershipEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'registered_at', type: 'timestamptz' })
  registeredAt: Date;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
