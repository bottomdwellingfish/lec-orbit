import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EconomyModule } from '../economy/economy.module.js';
import { MiniAppEntity } from '../miniapps/entities/mini-app.entity.js';
import { MiniAppVersionEntity } from '../miniapps/entities/mini-app-version.entity.js';
import {
  MiniAppFunctionBundleEntity,
  MiniAppGlobalKvEntity,
  MiniAppSecretEntity,
} from './entities/functions.entities.js';
import { FunctionsController } from './functions.controller.js';
import {
  FunctionsBridgeController,
  FunctionsInternalBundleController,
} from './functions-internal.controller.js';
import { FunctionsService } from './functions.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MiniAppEntity,
      MiniAppVersionEntity,
      MiniAppFunctionBundleEntity,
      MiniAppGlobalKvEntity,
      MiniAppSecretEntity,
    ]),
    EconomyModule,
  ],
  controllers: [
    FunctionsController,
    FunctionsInternalBundleController,
    FunctionsBridgeController,
  ],
  providers: [FunctionsService],
  exports: [FunctionsService],
})
export class FunctionsModule {}
