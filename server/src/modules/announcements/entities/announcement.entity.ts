import { Column, DeleteDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/** 队长发布的富文本公告（支持软删除与置顶）。 */
@Entity({ name: 'announcements' })
@Index('idx_announcements_active_created', ['pinned', 'createdAt'])
export class AnnouncementEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id: string;

  @Column({ name: 'title', type: 'text' })
  title: string;

  @Column({ name: 'content_html', type: 'text' })
  contentHtml: string;

  @Column({ name: 'content_text', type: 'text', default: '' })
  contentText: string;

  @Column({ name: 'pinned', type: 'boolean', default: false })
  pinned: boolean;

  @Column({ name: 'author_id', type: 'text' })
  authorId: string;

  @Column({ name: 'author_name', type: 'text', default: '' })
  authorName: string;

  @Column({ name: 'author_avatar', type: 'text', default: '' })
  authorAvatar: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Index()
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
