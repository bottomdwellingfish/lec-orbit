import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** 公告成员已读回执（联合主键确保幂等）。 */
@Entity({ name: 'announcement_receipts' })
@Index('idx_announcement_receipts_user', ['userId', 'readAt'])
export class AnnouncementReceiptEntity {
  @PrimaryColumn({ name: 'announcement_id', type: 'uuid' })
  announcementId: string;

  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'read_at', type: 'timestamptz' })
  readAt: Date;
}
