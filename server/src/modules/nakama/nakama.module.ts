import { Module } from '@nestjs/common';
import { NakamaController } from './nakama.controller.js';
import { NakamaService } from './nakama.service.js';

@Module({
  controllers: [NakamaController],
  providers: [NakamaService],
  exports: [NakamaService],
})
export class NakamaModule {}
