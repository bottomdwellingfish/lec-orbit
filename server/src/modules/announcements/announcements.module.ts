import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnnouncementEntity } from './entities/announcement.entity.js';
import { AnnouncementReceiptEntity } from './entities/announcement-receipt.entity.js';
import { AnnouncementsService } from './announcements.service.js';
import { AnnouncementsController } from './announcements.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([AnnouncementEntity, AnnouncementReceiptEntity])],
  controllers: [AnnouncementsController],
  providers: [AnnouncementsService],
})
export class AnnouncementsModule {}
