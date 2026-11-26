import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { EconomyAsset } from './economy-hold.entity.js';

export type EconomyOrderType = 'escrow_wager' | 'p2p_tip' | 'bounty_escrow' | 'pool_escrow';
export type EconomyOrderStatus =
  | 'pending_accept'
  | 'locked'
  | 'disputed'
  | 'settled'
  | 'refunded'
  | 'cancelled'
  | 'expired';

/** 通用交易 / 托管订单主表（支持赌约、打赏、悬赏、多人奖池）。 */
@Entity({ name: 'economy_orders' })
@Index('idx_economy_orders_app_match', ['appId', 'externalMatchId'])
@Index('idx_economy_orders_status_exp', ['status', 'acceptExpiresAt', 'settleExpiresAt'])
export class EconomyOrderEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id: string;

  @Index()
  @Column({ name: 'app_id', type: 'text' })
  appId: string;

  @Column({ name: 'order_type', type: 'text' })
  orderType: EconomyOrderType;

  @Column({ name: 'external_match_id', type: 'text', default: '' })
  externalMatchId: string;

  @Column({ name: 'title', type: 'text', default: '' })
  title: string;

  @Column({ name: 'asset', type: 'text' })
  asset: EconomyAsset;

  @Column({ name: 'amount', type: 'int' })
  amount: number;

  @Column({ name: 'week_key', type: 'text' })
  weekKey: string;

  @Index()
  @Column({ name: 'status', type: 'text', default: 'pending_accept' })
  status: EconomyOrderStatus;

  @Index()
  @Column({ name: 'creator_user_id', type: 'text' })
  creatorUserId: string;

  @Column({ name: 'summary', type: 'text', default: '' })
  summary: string;

  @Column({ name: 'accept_expires_at', type: 'timestamptz' })
  acceptExpiresAt: Date;

  @Column({ name: 'settle_expires_at', type: 'timestamptz', nullable: true })
  settleExpiresAt: Date | null;

  @Column({ name: 'settled_at', type: 'timestamptz', nullable: true })
  settledAt: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
