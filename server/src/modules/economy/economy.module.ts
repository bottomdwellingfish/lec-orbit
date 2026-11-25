import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EconomyAccountEntity } from './entities/economy-account.entity.js';
import { EconomyHoldEntity } from './entities/economy-hold.entity.js';
import { EconomyLedgerEntryEntity } from './entities/economy-ledger-entry.entity.js';
import { MiniAppCredentialEntity } from './entities/mini-app-credential.entity.js';
import { EconomyOrderEntity } from './entities/economy-order.entity.js';
import { EconomyOrderParticipantEntity } from './entities/economy-order-participant.entity.js';
import { EconomyLedgerService } from './economy-ledger.service.js';
import { EconomyGatewayService } from './economy-gateway.service.js';
import { EconomyReaperService } from './economy-reaper.service.js';
import { EconomyController } from './economy.controller.js';
import { EconomyAdminController } from './economy-admin.controller.js';
import { EconomyS2SController } from './economy-s2s.controller.js';
import { EconomyInternalController } from './economy-internal.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EconomyAccountEntity,
      EconomyHoldEntity,
      EconomyLedgerEntryEntity,
      MiniAppCredentialEntity,
      EconomyOrderEntity,
      EconomyOrderParticipantEntity,
    ]),
  ],
  controllers: [
    EconomyController,
    EconomyAdminController,
    EconomyS2SController,
    EconomyInternalController,
  ],
  providers: [EconomyLedgerService, EconomyGatewayService, EconomyReaperService],
  exports: [EconomyLedgerService, EconomyGatewayService],
})
export class EconomyModule {}
