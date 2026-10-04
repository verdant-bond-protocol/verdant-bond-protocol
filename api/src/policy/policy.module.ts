import { Module } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { PolicySimulationService } from './policy-simulation.service';
import { ConfigModule } from '../config/config.module';

@Module({
  imports: [ConfigModule],
  providers: [PolicyService, PolicySimulationService],
  exports: [PolicyService, PolicySimulationService],
})
export class PolicyModule {}
