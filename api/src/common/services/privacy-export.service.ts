import { Injectable, ForbiddenException } from '@nestjs/common';

export interface ExportableProject {
  id: number;
  name: string;
  status: string;
  methodology: string;
  country: string;
  metadataIpfsHash: string;
  ownerAddress: string;
  totalAreaHa: number;
  carbonSequestrationEstimate: number;
  createdAt: string;
}

@Injectable()
export class PrivacyExportService {
  exportProject(project: ExportableProject, viewerAddress: string) {
    const isOwner = viewerAddress === project.ownerAddress;
    if (!viewerAddress) throw new ForbiddenException('Authenticated wallet required');
    const publicFields = {
      id: project.id,
      name: project.name,
      status: project.status,
      methodology: project.methodology,
      country: project.country,
      totalAreaHa: project.totalAreaHa,
      carbonSequestrationEstimate: project.carbonSequestrationEstimate,
    };
    return isOwner ? { ...publicFields, ownerAddress: project.ownerAddress, metadataIpfsHash: project.metadataIpfsHash, createdAt: project.createdAt } : publicFields;
  }
}
