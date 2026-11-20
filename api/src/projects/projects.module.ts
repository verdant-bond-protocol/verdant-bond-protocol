import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { IpfsService } from './ipfs.service';
import { AuthModule } from '../auth/auth.module';
import { PrivacyExportService } from '../common/services/privacy-export.service';

@Module({
  imports: [AuthModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, IpfsService, PrivacyExportService],
  exports: [IpfsService, ProjectsService],
})
export class ProjectsModule {}
