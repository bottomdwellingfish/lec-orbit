import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_CONFIG, type AppConfig } from '../config/env.config.js';
import { buildTypeOrmOptions } from './data-source.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => buildTypeOrmOptions(cfg),
    }),
  ],
})
export class DatabaseModule {}
