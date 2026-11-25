import { Global, Module } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { SsoAuthGuard } from '../../common/guards/sso-auth.guard.js';
import { CaptainGuard } from '../../common/guards/captain.guard.js';
import { InternalTokenGuard } from '../../common/guards/internal-token.guard.js';

@Global()
@Module({
  providers: [AuthService, SsoAuthGuard, CaptainGuard, InternalTokenGuard],
  exports: [AuthService, SsoAuthGuard, CaptainGuard, InternalTokenGuard],
})
export class AuthModule {}
