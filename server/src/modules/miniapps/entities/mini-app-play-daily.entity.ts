import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** 工坊作品每日游玩统计表（用于渲染近 14 天趋势折线图与近 35 天游玩热力图）。 */
@Entity({ name: 'mini_app_play_daily' })
@Index(['appId', 'dayKey'])
export class MiniAppPlayDailyEntity {
  @PrimaryColumn({ name: 'app_id', type: 'text' })
  appId: string;

  @PrimaryColumn({ name: 'day_key', type: 'text' })
  dayKey: string;

  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'play_count', type: 'int', default: 0 })
  playCount: number;

  @Column({ name: 'total_duration_seconds', type: 'int', default: 0 })
  totalDurationSeconds: number;
}
