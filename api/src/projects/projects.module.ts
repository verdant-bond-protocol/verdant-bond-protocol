import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { IpfsService } from './ipfs.service';
import { IpfsHealthService } from './ipfs-health.service';
import { IpfsUploadPolicy } from './ipfs-upload.policy';
import { IpfsDocumentCacheService } from './ipfs-document-cache.service';
import { IpfsAvailabilityService } from './ipfs-availability.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    IpfsService,
    IpfsHealthService,
    IpfsDocumentCacheService,
    IpfsAvailabilityService,
    {
      provide: IpfsUploadPolicy,
      useFactory: () => new IpfsUploadPolicy(),
    },
  ],
  exports: [
    IpfsService,
    IpfsHealthService,
    ProjectsService,
    IpfsDocumentCacheService,
    IpfsAvailabilityService,
  ],
})
export class ProjectsModule {}
