import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** 卡牌工坊团队状态快照表（对应原 MongoDB card_games 集合）。 */
@Entity({ name: 'punch_card_games' })
export class PunchCardGameEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Index({ unique: true })
  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Column({ name: 'revision', type: 'int', default: 0 })
  revision: number;

  @Column({ name: 'start_week', type: 'text' })
  startWeek: string;

  @Column({ name: 'state', type: 'jsonb', default: () => "'{}'::jsonb" })
  state: Record<string, unknown>;

  @Column({ name: 'receipts', type: 'jsonb', default: () => "'{}'::jsonb" })
  receipts: Record<string, unknown>;

  @Column({ name: 'pending_write', type: 'jsonb', nullable: true })
  pendingWrite: Record<string, unknown> | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** 卡牌操作回执归档表（对应原 MongoDB card_action_receipts 集合）。 */
@Entity({ name: 'punch_card_action_receipts' })
@Index('idx_punch_card_receipt_unique', ['teamId', 'receiptKey'], { unique: true })
@Index('idx_punch_card_receipt_actor', ['teamId', 'actorId', 'at'])
export class PunchCardActionArchiveEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Column({ name: 'receipt_key', type: 'text' })
  receiptKey: string;

  @Column({ name: 'content_hash', type: 'text' })
  contentHash: string;

  @Column({ name: 'actor_id', type: 'text' })
  actorId: string;

  @Column({ name: 'request_key', type: 'text' })
  requestKey: string;

  @Column({ name: 'hash', type: 'text' })
  hash: string;

  @Column({ name: 'at', type: 'text' })
  at: string;

  @Column({ name: 'result', type: 'jsonb' })
  result: Record<string, unknown>;

  @Column({ name: 'gift', type: 'jsonb', nullable: true })
  gift: Record<string, unknown> | null;

  @Column({ name: 'gift_read_at', type: 'timestamptz', nullable: true })
  giftReadAt: Date | null;

  @Column({ name: 'defenses', type: 'jsonb', nullable: true })
  defenses: unknown[] | null;

  @Column({ name: 'defense_read_by', type: 'jsonb', nullable: true })
  defenseReadBy: string[] | null;

  @Column({ name: 'interactions', type: 'jsonb', nullable: true })
  interactions: unknown[] | null;

  @Column({ name: 'interaction_read_by', type: 'jsonb', nullable: true })
  interactionReadBy: string[] | null;
}

/** 卡牌历史周归档表（对应原 MongoDB card_week_archives 集合）。 */
@Entity({ name: 'punch_card_week_archives' })
@Index('idx_punch_card_week_unique', ['teamId', 'userId', 'weekKey'], { unique: true })
@Index('idx_punch_card_week_team', ['teamId', 'weekKey'])
export class PunchCardWeekArchiveEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Column({ name: 'team_id', type: 'text' })
  teamId: string;

  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'week_key', type: 'text' })
  weekKey: string;

  @Column({ name: 'content_hash', type: 'text' })
  contentHash: string;

  @Column({ name: 'week', type: 'jsonb' })
  week: Record<string, unknown>;
}
