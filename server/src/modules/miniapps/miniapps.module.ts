import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FunctionsModule } from '../functions/functions.module.js';
import { MiniAppEntity } from './entities/mini-app.entity.js';
import { MiniAppVersionEntity } from './entities/mini-app-version.entity.js';
import { MiniAppKvEntity } from './entities/mini-app-kv.entity.js';
import { MiniAppsService } from './miniapps.service.js';
import { MiniAppsController } from './miniapps.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([MiniAppEntity, MiniAppVersionEntity, MiniAppKvEntity]),
    FunctionsModule,
  ],
  controllers: [MiniAppsController],
  providers: [MiniAppsService],
  exports: [MiniAppsService],
})
export class MiniAppsModule {}
