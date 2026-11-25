import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_CONFIG, loadAppConfig } from './config/env.config.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { StorageModule } from './modules/storage/storage.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { RosterModule } from './modules/roster/roster.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { AnnouncementsModule } from './modules/announcements/announcements.module.js';
import { MiniAppsModule } from './modules/miniapps/miniapps.module.js';
import { EconomyModule } from './modules/economy/economy.module.js';
import { PunchModule } from './modules/punch/punch.module.js';
import { HealthController } from './modules/health/health.controller.js';

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => loadAppConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
class AppConfigModule {}

@Module({
  imports: [
    AppConfigModule,
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuthModule,
    StorageModule,
    RealtimeModule,
    RosterModule,
    NotificationsModule,
    AnnouncementsModule,
    MiniAppsModule,
    EconomyModule,
    PunchModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
