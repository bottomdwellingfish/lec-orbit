import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { EconomyAsset } from './economy-hold.entity.js';

export type EconomyLedgerReason =
  | 'attendance'
  | 'fever_bonus'
  | 'wager_win'
  | 'wager_loss'
  | 'tip_in'
  | 'tip_out'
  | 'bounty_in'
  | 'bounty_out'
  | 'card_draw'
  | 'shop_spend'
  | 'burn_fee'
  | 'admin_grant'
  | 'admin_adjust'
  | 'migration_init';

/**
 * 不可变借贷流水表（全平台唯一审计底账）：
 * - 任何余额/时长变动必须追加一条带唯一 idempotency_key 的流水；
 * - 同一次结算/划转共享 tx_group_id，便于零和守恒对账；
 * - counts_toward_lifetime=true 仅用于真实贡献产出，P2P 赌约互刷绝不虚增 lifetimeEarnedCoins。
 */
@Entity({ name: 'economy_ledger_entries' })
@Index('idx_economy_ledger_user_created', ['userId', 'createdAt'])
@Index('idx_economy_ledger_user_week_asset', ['userId', 'weekKey', 'asset'])
@Index('idx_economy_ledger_tx_group', ['txGroupId'])
export class EconomyLedgerEntryEntity {
  @PrimaryColumn({ name: 'entry_id', type: 'uuid' })
  entryId: string;

  @Column({ name: 'tx_group_id', type: 'uuid' })
  txGroupId: string;

  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId: string | null;

  @Column({ name: 'app_id', type: 'text' })
  appId: string;

  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'counterparty_user_id', type: 'text', nullable: true })
  counterpartyUserId: string | null;

  @Column({ name: 'asset', type: 'text' })
  asset: EconomyAsset;

  @Column({ name: 'delta', type: 'int' })
  delta: number;

  @Column({ name: 'counts_toward_lifetime', type: 'boolean', default: false })
  countsTowardLifetime: boolean;

  @Column({ name: 'week_key', type: 'text' })
  weekKey: string;

  @Column({ name: 'reason', type: 'text' })
  reason: EconomyLedgerReason;

  @Column({ name: 'title', type: 'text', default: '' })
  title: string;

  @Index({ unique: true })
  @Column({ name: 'idempotency_key', type: 'text' })
  idempotencyKey: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
