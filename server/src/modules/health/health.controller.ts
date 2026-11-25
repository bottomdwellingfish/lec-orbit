import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('healthz')
  healthz() {
    return {
      status: 'ok',
      service: 'lec-orbit-server',
      runtime: typeof Bun !== 'undefined' ? `bun-${Bun.version}` : `node-${process.version}`,
    };
  }
}
