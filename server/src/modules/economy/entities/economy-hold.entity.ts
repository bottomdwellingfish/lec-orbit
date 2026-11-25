import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export type EconomyAsset = 'coin' | 'punch_minutes';
export type EconomyHoldStatus = 'active' | 'captured' | 'released';

/** 资产冻结单（用于托管赌约、悬赏、奖池等场景防双花）。 */
@Entity({ name: 'economy_holds' })
@Index('idx_economy_holds_user_status', ['userId', 'status'])
@Index('idx_economy_holds_order', ['orderId'])
export class EconomyHoldEntity {
  @PrimaryColumn({ name: 'hold_id', type: 'uuid' })
  holdId: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ name: 'app_id', type: 'text' })
  appId: string;

  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'asset', type: 'text' })
  asset: EconomyAsset;

  @Column({ name: 'amount', type: 'int' })
  amount: number;

  @Column({ name: 'week_key', type: 'text' })
  weekKey: string;

  @Column({ name: 'status', type: 'text', default: 'active' })
  status: EconomyHoldStatus;

  @Index()
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Index({ unique: true })
  @Column({ name: 'idempotency_key', type: 'text' })
  idempotencyKey: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
