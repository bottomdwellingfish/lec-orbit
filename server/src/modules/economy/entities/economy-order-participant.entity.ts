import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export type ParticipantRole = 'creator' | 'opponent' | 'recipient';
export type ParticipantOutcome = '' | 'win' | 'loss' | 'draw' | 'refund';

/** 交易订单参与者子表（兼容双人对局及未来多人奖池）。 */
@Entity({ name: 'economy_order_participants' })
@Index('idx_economy_order_participants_user', ['userId'])
export class EconomyOrderParticipantEntity {
  @PrimaryColumn({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'role', type: 'text' })
  role: ParticipantRole;

  @Column({ name: 'stake_amount', type: 'int', default: 0 })
  stakeAmount: number;

  @Column({ name: 'hold_id', type: 'uuid', nullable: true })
  holdId: string | null;

  @Column({ name: 'outcome', type: 'text', default: '' })
  outcome: ParticipantOutcome;

  @Column({ name: 'payout_delta', type: 'int', default: 0 })
  payoutDelta: number;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;
}
