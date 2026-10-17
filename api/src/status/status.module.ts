import { Module } from '@nestjs/common';
import { OracleModule } from '../oracle/oracle.module';
import { StatusService } from './status.service';
import { StatusController } from './status.controller';
import { ReleaseGateService } from './release-gate/release-gate.service';

@Module({
  imports: [OracleModule],
  controllers: [StatusController],
  providers: [StatusService, ReleaseGateService],
  exports: [StatusService, ReleaseGateService],
})
export class StatusModule {}

