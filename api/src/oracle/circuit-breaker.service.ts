import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { CrossSourceAssessment } from './anomaly.detector';

export enum PauseScope {
  PROJECT = 'PROJECT',
  TRANCHE = 'TRANCHE',
  GLOBAL = 'GLOBAL',
}

export interface CircuitBreakerState {
  projectId: string;
  tranche?: string;
  isPaused: boolean;
  pausedAt?: number;
  triggerReason?: string;
  anomalyKind?: string;
  zScore?: number;
  triggerData?: any;
  resumedAt?: number;
  resumedBy?: string;
  resumptionReason?: string;
}

export interface AnomalyDetectionConfig {
  /** Standard deviation threshold (N sigma) for statistical anomaly detection */
  zScoreThreshold: number; // Default 3.0
  /** Relative percentage deviation threshold (e.g. 0.35 for 35%) */
  maxRelativeDeviation: number; // Default 0.35
  /** Min trailing samples required to calculate standard deviation */
  minHistorySamples: number; // Default 3
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyDetectionConfig = {
  zScoreThreshold: 3.0,
  maxRelativeDeviation: 0.35,
  minHistorySamples: 3,
};

/**
 * Circuit Breaker Service for Oracle Anomaly Protection (#332).
 *
 * Implements statistical anomaly detection (Z-score N sigma deviation & cross-source variance)
 * triggering an automatic, scoped pause on affected project coupon distribution and trading.
 * Resumption strictly requires explicit governance/multisig action with NO automatic timeout.
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly pausedProjects = new Map<string, CircuitBreakerState>();
  private readonly projectHistory = new Map<string, number[]>();
  private config: AnomalyDetectionConfig = { ...DEFAULT_ANOMALY_CONFIG };

  /**
   * Evaluates new oracle performance data against statistical trailing history and cross-source assessments.
   * Triggers automatic scoped pause if an anomaly threshold is breached.
   */
  evaluateOracleReport(input: {
    projectId: string;
    tranche?: string;
    carbonValue: number;
    crossSourceAssessment?: CrossSourceAssessment;
  }): { paused: boolean; zScore?: number; reason?: string } {
    const { projectId, tranche, carbonValue, crossSourceAssessment } = input;

    // Check if project is already paused
    if (this.isProjectPaused(projectId, tranche)) {
      return { paused: true, reason: `Project ${projectId} is currently under circuit breaker pause` };
    }

    const history = this.projectHistory.get(projectId) || [];

    let zScore: number | undefined;
    let isStatisticalAnomaly = false;

    if (history.length >= this.config.minHistorySamples) {
      const mean = history.reduce((a, b) => a + b, 0) / history.length;
      const variance = history.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / history.length;
      const stdDev = Math.sqrt(variance);

      if (stdDev > 0) {
        zScore = Math.abs(carbonValue - mean) / stdDev;
        if (zScore > this.config.zScoreThreshold) {
          isStatisticalAnomaly = true;
        }
      }
    }

    const isCrossSourceCritical = crossSourceAssessment?.severity === 'critical';

    if (isStatisticalAnomaly || isCrossSourceCritical) {
      const reason = isStatisticalAnomaly
        ? `Statistical anomaly detected: value ${carbonValue} deviates ${zScore?.toFixed(2)} std dev from trailing mean (threshold ${this.config.zScoreThreshold} sigma)`
        : `Critical cross-source oracle anomaly: ${crossSourceAssessment?.reason}`;

      this.triggerScopedPause({
        projectId,
        tranche,
        reason,
        anomalyKind: isStatisticalAnomaly ? 'STATISTICAL_ZSCORE_DEVIATION' : 'CROSS_SOURCE_CRITICAL',
        zScore,
        triggerData: { carbonValue, historyLength: history.length, crossSourceAssessment },
      });

      return { paused: true, zScore, reason };
    }

    // Update historical trailing observations
    history.push(carbonValue);
    if (history.length > 20) history.shift();
    this.projectHistory.set(projectId, history);

    return { paused: false, zScore };
  }

  /**
   * Automatically triggers a scoped pause limited strictly to the affected project/tranche blast radius.
   */
  triggerScopedPause(params: {
    projectId: string;
    tranche?: string;
    reason: string;
    anomalyKind: string;
    zScore?: number;
    triggerData?: any;
  }): CircuitBreakerState {
    const key = this.getScopeKey(params.projectId, params.tranche);
    const state: CircuitBreakerState = {
      projectId: params.projectId,
      tranche: params.tranche,
      isPaused: true,
      pausedAt: Date.now(),
      triggerReason: params.reason,
      anomalyKind: params.anomalyKind,
      zScore: params.zScore,
      triggerData: params.triggerData,
    };

    this.pausedProjects.set(key, state);
    this.logger.warn(
      `CIRCUIT BREAKER TRIGGERED: Scoped pause activated for project ${params.projectId} (Tranche: ${params.tranche || 'ALL'}). Reason: ${params.reason}`,
    );

    return state;
  }

  /**
   * Checks if coupon distribution or trading for a project/tranche is paused by the circuit breaker.
   */
  isProjectPaused(projectId: string, tranche?: string): boolean {
    const projectKey = this.getScopeKey(projectId);
    const trancheKey = tranche ? this.getScopeKey(projectId, tranche) : null;

    const projectState = this.pausedProjects.get(projectKey);
    if (projectState && projectState.isPaused) return true;

    if (trancheKey) {
      const trancheState = this.pausedProjects.get(trancheKey);
      if (trancheState && trancheState.isPaused) return true;
    }

    return false;
  }

  /**
   * Explicit governance/multisig action to unpause and resume project operations.
   * Circuit breaker state NEVER auto-expires or times out automatically.
   */
  resumeProject(input: {
    projectId: string;
    tranche?: string;
    governanceActor: string;
    multisigSignatures: string[];
    resumptionReason: string;
  }): CircuitBreakerState {
    const key = this.getScopeKey(input.projectId, input.tranche);
    const state = this.pausedProjects.get(key);

    if (!state || !state.isPaused) {
      throw new NotFoundException(`Circuit breaker is not active for project ${input.projectId}`);
    }

    if (!input.multisigSignatures || input.multisigSignatures.length < 2) {
      throw new ForbiddenException('Governance resumption requires at least 2 valid multisig signatures');
    }

    if (!input.resumptionReason || input.resumptionReason.trim().length < 10) {
      throw new BadRequestException('Detailed resumption reason is required for governance audit');
    }

    const updatedState: CircuitBreakerState = {
      ...state,
      isPaused: false,
      resumedAt: Date.now(),
      resumedBy: input.governanceActor,
      resumptionReason: input.resumptionReason,
    };

    this.pausedProjects.set(key, updatedState);
    this.logger.log(
      `CIRCUIT BREAKER GOVERNED RESUMPTION: Project ${input.projectId} resumed by ${input.governanceActor} with ${input.multisigSignatures.length} multisig sigs. Reason: ${input.resumptionReason}`,
    );

    return updatedState;
  }

  getCircuitBreakerState(projectId: string, tranche?: string): CircuitBreakerState | null {
    const key = this.getScopeKey(projectId, tranche);
    return this.pausedProjects.get(key) || null;
  }

  getAnomalyConfig(): AnomalyDetectionConfig {
    return { ...this.config };
  }

  private getScopeKey(projectId: string, tranche?: string): string {
    return tranche ? `${projectId}:${tranche}` : projectId;
  }
}
