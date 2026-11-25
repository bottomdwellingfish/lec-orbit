import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { EconomyAsset } from './economy-hold.entity.js';

export type CredentialStatus = 'active' | 'revoked';

/**
 * 工坊应用专属 S2S 交易凭证与独立风控限额（一应用一密钥）：
 * - 只有队长审核并通过本表签发密钥的应用，才允许触发 S2S 结算回调；
 * - 支持一键吊销（revoked）秒级熔断。
 */
@Entity({ name: 'mini_app_credentials' })
export class MiniAppCredentialEntity {
  @PrimaryColumn({ name: 'app_id', type: 'text' })
  appId: string;

  @Column({ name: 'secret_sealed', type: 'text' })
  secretSealed: string;

  @Column({ name: 'secret_prefix', type: 'text' })
  secretPrefix: string;

  @Column({ name: 'allowed_assets', type: 'jsonb', default: () => "'[]'::jsonb" })
  allowedAssets: EconomyAsset[];

  @Column({ name: 'max_coin_per_order', type: 'int', default: 50 })
  maxCoinPerOrder: number;

  @Column({ name: 'max_punch_per_order', type: 'int', default: 30 })
  maxPunchPerOrder: number;

  @Column({ name: 'daily_order_limit', type: 'int', default: 200 })
  dailyOrderLimit: number;

  @Column({ name: 'status', type: 'text', default: 'active' })
  status: CredentialStatus;

  @Column({ name: 'rotated_at', type: 'timestamptz' })
  rotatedAt: Date;

  @Column({ name: 'created_by', type: 'text' })
  createdBy: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
