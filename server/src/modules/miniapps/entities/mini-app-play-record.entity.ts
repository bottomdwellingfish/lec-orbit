import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** 工坊作品游玩记录表（按 app_id + user_id 聚合累计游玩次数与时长，游玩次数不受上限限制）。 */
@Entity({ name: 'mini_app_play_records' })
@Index(['appId', 'lastPlayedAt'])
export class MiniAppPlayRecordEntity {
  @PrimaryColumn({ name: 'app_id', type: 'text' })
  appId: string;

  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'play_count', type: 'int', default: 0 })
  playCount: number;

  @Column({ name: 'total_duration_seconds', type: 'int', default: 0 })
  totalDurationSeconds: number;

  @Column({ name: 'last_session_seconds', type: 'int', default: 0 })
  lastSessionSeconds: number;

  @Column({ name: 'first_played_at', type: 'timestamptz' })
  firstPlayedAt: Date;

  @Column({ name: 'last_played_at', type: 'timestamptz' })
  lastPlayedAt: Date;
}
