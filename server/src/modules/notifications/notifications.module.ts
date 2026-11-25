import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationEntity } from './entities/notification.entity.js';
import { NotificationReadEntity } from './entities/notification-read.entity.js';
import { DocBridgeService } from './docbridge.service.js';
import { NotificationsService } from './notifications.service.js';
import { NotificationsController } from './notifications.controller.js';
import { InternalEventsController } from './internal-events.controller.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([NotificationEntity, NotificationReadEntity])],
  controllers: [NotificationsController, InternalEventsController],
  providers: [DocBridgeService, NotificationsService],
  exports: [NotificationsService, DocBridgeService],
})
export class NotificationsModule {}
