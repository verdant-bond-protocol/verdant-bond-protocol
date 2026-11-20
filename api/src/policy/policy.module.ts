import { Module } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { PolicySimulationService } from './policy-simulation.service';
import { PolicyConfigChangeService } from './policy-config-change.service';
import { PolicyConfigController } from './policy-config.controller';
import { ConfigModule } from '../config/config.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [ConfigModule, AuditModule],
  controllers: [PolicyConfigController],
  providers: [PolicyService, PolicySimulationService, PolicyConfigChangeService],
  exports: [PolicyService, PolicySimulationService, PolicyConfigChangeService],
})
export class PolicyModule {}
