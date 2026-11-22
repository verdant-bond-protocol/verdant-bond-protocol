import { Module } from '@nestjs/common';
import { AuditModule } from './audit.module';
import { BondsModule } from '../bonds/bonds.module';
import { BondLifecycleAuditBundleService } from './bond-lifecycle-audit-bundle.service';
import { BondLifecycleAuditController } from './controllers/bond-lifecycle-audit.controller';

@Module({
  imports: [AuditModule, BondsModule],
  controllers: [BondLifecycleAuditController],
  providers: [BondLifecycleAuditBundleService],
  exports: [BondLifecycleAuditBundleService],
})
export class BondLifecycleAuditModule {}
