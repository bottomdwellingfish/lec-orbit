import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * 成员统一资产账户表（PostgreSQL 行锁聚合视图，配合不可变流水表双重保障一致性）：
 * - coinBalance: 当前可用乐币（跨周留存，可消费、可打赏、可冻结押注）
 * - frozenCoins: 当前托管单中冻结锁定的乐币
 * - lifetimeEarnedCoins: 历史累计通过真实贡献赚取的乐币（只增不减，P2P 赌约/打赏转移不虚增）
 * - weeklyRecordedMinutes: 当周已同步的真实打卡分钟数（用于 punch_minutes 参与门槛风控）
 */
@Entity({ name: 'economy_accounts' })
export class EconomyAccountEntity {
  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'coin_balance', type: 'int', default: 0 })
  coinBalance: number;

  @Column({ name: 'frozen_coins', type: 'int', default: 0 })
  frozenCoins: number;

  @Column({ name: 'lifetime_earned_coins', type: 'int', default: 0 })
  lifetimeEarnedCoins: number;

  @Column({ name: 'weekly_recorded_minutes', type: 'int', default: 0 })
  weeklyRecordedMinutes: number;

  @Column({ name: 'weekly_recorded_week_key', type: 'text', default: '' })
  weeklyRecordedWeekKey: string;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
