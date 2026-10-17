import { Module } from '@nestjs/common';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { BulkImportService } from '../common/services/bulk-import.service';

@Module({
  controllers: [ImportsController],
  providers: [ImportsService, BulkImportService],
  exports: [ImportsService],
})
export class ImportsModule {}
