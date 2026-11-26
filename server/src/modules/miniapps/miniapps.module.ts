import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FunctionsModule } from '../functions/functions.module.js';
import { OrbitMemberEntity } from '../roster/entities/orbit-member.entity.js';
import { MiniAppEntity } from './entities/mini-app.entity.js';
import { MiniAppVersionEntity } from './entities/mini-app-version.entity.js';
import { MiniAppKvEntity } from './entities/mini-app-kv.entity.js';
import { MiniAppPlayRecordEntity } from './entities/mini-app-play-record.entity.js';
import { MiniAppPlayDailyEntity } from './entities/mini-app-play-daily.entity.js';
import { MiniAppRatingEntity } from './entities/mini-app-rating.entity.js';
import { MiniAppsEngagementService } from './miniapps-engagement.service.js';
import { MiniAppsService } from './miniapps.service.js';
import { MiniAppsController } from './miniapps.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MiniAppEntity,
      MiniAppVersionEntity,
      MiniAppKvEntity,
      MiniAppPlayRecordEntity,
      MiniAppPlayDailyEntity,
      MiniAppRatingEntity,
      OrbitMemberEntity,
    ]),
    FunctionsModule,
  ],
  controllers: [MiniAppsController],
  providers: [MiniAppsService, MiniAppsEngagementService],
  exports: [MiniAppsService, MiniAppsEngagementService],
})
export class MiniAppsModule {}
