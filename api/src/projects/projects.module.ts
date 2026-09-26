import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { IpfsService } from './ipfs.service';
import { IpfsHealthService } from './ipfs-health.service';
import { IpfsUploadPolicy } from './ipfs-upload.policy';

@Module({
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    IpfsService,
    IpfsHealthService,
    {
      provide: IpfsUploadPolicy,
      useFactory: () => new IpfsUploadPolicy(),
    },
  ],
  exports: [IpfsService, IpfsHealthService, ProjectsService],
})
export class ProjectsModule {}
