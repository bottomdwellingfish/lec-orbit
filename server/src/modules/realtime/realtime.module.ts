import { Global, Module } from '@nestjs/common';
import { RealtimeHub } from './realtime.hub.js';

@Global()
@Module({
  providers: [RealtimeHub],
  exports: [RealtimeHub],
})
export class RealtimeModule {}
