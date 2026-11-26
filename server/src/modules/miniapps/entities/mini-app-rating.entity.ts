import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * 工坊作品评分与评分机会表（每 app_id + user_id 唯一）：
 * - 完成一次「启动并结束」游玩后，ratingChances 置为 1（封顶 1，绝不叠加）；
 * - 提交评分后 ratingChances 归 0，并校验东八区自然日评分限额（防刷）。
 */
@Entity({ name: 'mini_app_ratings' })
@Index(['appId', 'score'])
@Index(['userId', 'lastRatedDay'])
export class MiniAppRatingEntity {
  @PrimaryColumn({ name: 'app_id', type: 'text' })
  appId: string;

  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'score', type: 'smallint', nullable: true })
  score: number | null;

  @Column({ name: 'comment', type: 'text', default: '' })
  comment: string;

  @Column({ name: 'rating_chances', type: 'smallint', default: 0 })
  ratingChances: number;

  @Column({ name: 'rated_count', type: 'int', default: 0 })
  ratedCount: number;

  @Column({ name: 'last_rated_day', type: 'text', default: '' })
  lastRatedDay: string;

  @Column({ name: 'today_rated_count', type: 'smallint', default: 0 })
  todayRatedCount: number;

  @Column({ name: 'rated_at', type: 'timestamptz', nullable: true })
  ratedAt: Date | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
