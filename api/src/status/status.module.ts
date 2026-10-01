import { Module } from '@nestjs/common';
import { OracleModule } from '../oracle/oracle.module';
import { StatusService } from './status.service';
import { StatusController } from './status.controller';

@Module({
  imports: [OracleModule],
  controllers: [StatusController],
  providers: [StatusService],
})
export class StatusModule {}
