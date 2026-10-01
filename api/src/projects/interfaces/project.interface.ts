export enum ProjectStatusEnum {
  Pending = 'Pending',
  Approved = 'Approved',
  Rejected = 'Rejected',
  Inactive = 'Inactive',
}

export interface ProjectResponse {
  id: number;
  name: string;
  status: ProjectStatusEnum;
  methodology: string;
  country: string;
  metadataIpfsHash: string;
  ownerAddress: string;
  totalAreaHa: number;
  carbonSequestrationEstimate: number;
  createdAt: string;
  /** Only present on the response to a just-submitted registration; absent on reads. */
  transactionHash?: string;
}

export interface DocumentUploadResponse {
  projectId: number;
  documentHashes: string[];
  gatewayUrls: string[];
}

export type ProvenanceEventType = 'registration' | 'review' | 'report' | 'bond' | 'document';

export interface ProvenanceEvent {
  type: ProvenanceEventType;
  occurredAt: string | null;
  title: string;
  status: 'complete' | 'pending' | 'stale';
  reference?: string;
  evidenceUrl?: string;
}

export interface ProjectProvenanceResponse {
  projectId: number;
  events: ProvenanceEvent[];
}

/** Tamper-evident certification version (issue #213). Each version is an
 * immutable record pointing at a distinct IPFS object; versions are only
 * ever appended, never overwritten. */
export type CertificationKind =
  | 'performance-report'
  | 'third-party-certification'
  | 'document';

export interface CertificationVersion {
  version: number;
  cid: string;
  previousCid: string | null;
  kind: CertificationKind;
  uploadedAt: string;
}

export interface CouponCertification {
  bondId: number;
  periodIndex: number;
  reportId: number;
  /** Exact CID of the certification/report evidence active at coupon time. */
  certificationCid: string;
  gatewayUrl: string;
  /** Matching entry in the project certification history, if recorded. */
  certificationVersion: number | null;
  recordedAt: string;
}
