import { Module } from '@nestjs/common';
import { PartialFailureService } from './partial-failure.service';
import { PartialFailureController } from './partial-failure.controller';

@Module({
  controllers: [PartialFailureController],
  providers: [PartialFailureService],
  exports: [PartialFailureService],
})
export class FailuresModule {}
