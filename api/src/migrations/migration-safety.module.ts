import { Module } from '@nestjs/common';
import { MigrationSafetyService } from './migration-safety.service';
import { MigrationSafetyController } from './migration-safety.controller';

@Module({
  controllers: [MigrationSafetyController],
  providers: [MigrationSafetyService],
  exports: [MigrationSafetyService],
})
export class MigrationSafetyModule {}
