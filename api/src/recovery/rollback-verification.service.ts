import { Injectable, Logger } from '@nestjs/common';
import { RecoveryService, DEFAULT_STUCK_AFTER_MS } from './recovery.service';

export type RollbackVerificationStatus = 'CLEAN' | 'PARTIAL_REPAIR_REQUIRED' | 'CRITICAL_MISMATCH';

export interface RecordRepairAdvice {
  recordId: string;
  component: string;
  issueType: string;
  description: string;
  suggestedAction: string;
}

export interface RollbackVerificationReport {
  overallStatus: RollbackVerificationStatus;
  isReadOnly: boolean;
  timestamp: string;
  checkedComponents: string[];
  recordsRequiringRepair: RecordRepairAdvice[];
  summaryText: string;
}

export interface RollbackVerificationInput {
  targetVersion: string;
  bondRecords?: Array<{ id: number; status: string; totalIssued: bigint; holderCount: number }>;
  jobRecords?: Array<{ id: string; type: string; status: string; lastStepId: string; interruptedMs: number }>;
  externalRefRecords?: Array<{ id: string; url: string; verified: boolean }>;
}

@Injectable()
export class RollbackVerificationService {
  private readonly logger = new Logger(RollbackVerificationService.name);

  constructor(private readonly recoveryService?: RecoveryService) {}

  verifyRollback(input: RollbackVerificationInput): RollbackVerificationReport {
    const checkedComponents = ['user_facing_state', 'background_jobs', 'external_references', 'partial_operations'];
    const recordsRequiringRepair: RecordRepairAdvice[] = [];

    // 1. User-facing state verification
    if (input.bondRecords) {
      for (const bond of input.bondRecords) {
        if (bond.status === 'INVALID_STATE' || bond.totalIssued < BigInt(0)) {
          recordsRequiringRepair.push({
            recordId: `bond_${bond.id}`,
            component: 'user_facing_state',
            issueType: 'CORRUPTED_BOND_STATE',
            description: `Bond ${bond.id} has invalid status '${bond.status}' or negative total issued (${bond.totalIssued}).`,
            suggestedAction: `Run repair script 'npm run reindex-holders' to recalculate holder distribution for bond ${bond.id}.`,
          });
        }
      }
    }

    // 2. Background jobs & pending operation verification
    if (input.jobRecords) {
      for (const job of input.jobRecords) {
        if (job.status === 'INTERRUPTED' || job.interruptedMs > DEFAULT_STUCK_AFTER_MS) {
          recordsRequiringRepair.push({
            recordId: `job_${job.id}`,
            component: 'background_jobs',
            issueType: 'INTERRUPTED_JOB',
            description: `Background operation ${job.id} (${job.type}) was interrupted at step ${job.lastStepId} for ${Math.round(job.interruptedMs / 1000)}s.`,
            suggestedAction: `Resume operation via 'RecoveryService.resume("${job.id}")' or mark abandoned if stale.`,
          });
        }
      }
    }

    // Also check active RecoveryService diagnostics if injected
    if (this.recoveryService) {
      const diagnostics = this.recoveryService.getDiagnostics();
      for (const diag of diagnostics) {
        if (!recordsRequiringRepair.some((r) => r.recordId === `job_${diag.operationId}`)) {
          recordsRequiringRepair.push({
            recordId: `job_${diag.operationId}`,
            component: 'background_jobs',
            issueType: 'STUCK_RECOVERY_OPERATION',
            description: `Recovery operation ${diag.operationId} sitting in state ${diag.status} at step ${diag.stepId}.`,
            suggestedAction: `Inspect recovery runbook or resume using operationId '${diag.operationId}'.`,
          });
        }
      }
    }

    // 3. External reference & IPFS verification
    if (input.externalRefRecords) {
      for (const ref of input.externalRefRecords) {
        if (!ref.verified) {
          recordsRequiringRepair.push({
            recordId: `ext_ref_${ref.id}`,
            component: 'external_references',
            issueType: 'UNVERIFIED_REFERENCE',
            description: `External reference ${ref.id} (${ref.url}) could not be verified post-rollback.`,
            suggestedAction: `Re-pin IPFS reference or update gateway configuration.`,
          });
        }
      }
    }

    // Determine overall status
    let overallStatus: RollbackVerificationStatus = 'CLEAN';
    if (recordsRequiringRepair.some((r) => r.issueType === 'CORRUPTED_BOND_STATE')) {
      overallStatus = 'CRITICAL_MISMATCH';
    } else if (recordsRequiringRepair.length > 0) {
      overallStatus = 'PARTIAL_REPAIR_REQUIRED';
    }

    const summaryText = overallStatus === 'CLEAN'
      ? `Rollback verification to version ${input.targetVersion} completed cleanly. All user states, background jobs, and external references are consistent.`
      : `Rollback verification to version ${input.targetVersion} detected ${recordsRequiringRepair.length} record(s) requiring maintenance (${overallStatus}).`;

    this.logger.log(`Rollback verification result: ${overallStatus} (${recordsRequiringRepair.length} repair actions required)`);

    return {
      overallStatus,
      isReadOnly: true, // Read-only by default
      timestamp: new Date().toISOString(),
      checkedComponents,
      recordsRequiringRepair,
      summaryText,
    };
  }
}
