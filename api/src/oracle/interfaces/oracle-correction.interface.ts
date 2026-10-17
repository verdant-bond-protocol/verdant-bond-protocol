export interface HistoricalCorrectionRecord {
  correctionId: string;
  reportId: number;
  projectId: string;
  originalCarbonSequestered: string;
  correctedCarbonSequestered: string;
  carbonDelta: string;
  originalBiodiversityScore?: number;
  correctedBiodiversityScore?: number;
  correctionEvidenceHash: string;
  reason: string;
  actorAddress: string;
  submittedAt: string;
  idempotencyKey?: string;
  auditSequence?: number;
  ledgerSequence?: number;
  trueUpSubmitted: boolean;
  bondAdjustments?: {
    bondId: number;
    periodIndex: number;
    trueUpAmount: string;
  }[];
}

export interface HistoricalCorrectionResponse {
  success: boolean;
  correction: HistoricalCorrectionRecord;
  reconciled: boolean;
  message: string;
}
