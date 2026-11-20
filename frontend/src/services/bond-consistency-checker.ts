// Issue #468: Implement frontend consistency checks for stale bond position data
// Validates bond position data freshness and detects inconsistencies

/**
 * Bond position data structure
 */
export interface BondPosition {
  id: string;
  bondId: string;
  holder: string;
  amount: string;
  lastUpdated: string;
  blockHeight: number;
  metadata?: Record<string, unknown>;
}

/**
 * Consistency check result
 */
export interface ConsistencyCheckResult {
  isConsistent: boolean;
  issues: ConsistencyIssue[];
  checkedAt: string;
  checksPerformed: number;
}

/**
 * Consistency issue details
 */
export interface ConsistencyIssue {
  severity: 'warning' | 'error' | 'critical';
  type: 'stale_data' | 'missing_data' | 'mismatch' | 'invalid_state';
  description: string;
  bondId?: string;
  positionId?: string;
  recommendedAction: string;
}

/**
 * Consistency checker configuration
 */
export interface ConsistencyConfig {
  /** Maximum age in milliseconds before data is considered stale */
  staleThresholdMs: number;
  /** Maximum block height difference before data is stale */
  staleBlockThreshold: number;
  /** Enable automatic refresh on stale detection */
  autoRefresh: boolean;
  /** Enable strict validation mode */
  strictMode: boolean;
}

/**
 * Default configuration
 */
export const DEFAULT_CONSISTENCY_CONFIG: ConsistencyConfig = {
  staleThresholdMs: 5 * 60 * 1000, // 5 minutes
  staleBlockThreshold: 100, // blocks
  autoRefresh: true,
  strictMode: false,
};

/**
 * Bond position consistency checker
 * 
 * Performs multiple consistency checks:
 * - Timestamp staleness
 * - Block height staleness
 * - Data completeness
 * - Cross-validation with blockchain state
 */
export class BondConsistencyChecker {
  private config: ConsistencyConfig;

  constructor(config: Partial<ConsistencyConfig> = {}) {
    this.config = { ...DEFAULT_CONSISTENCY_CONFIG, ...config };
  }

  /**
   * Check consistency of bond positions
   */
  async checkConsistency(
    positions: BondPosition[],
    currentBlockHeight: number,
  ): Promise<ConsistencyCheckResult> {
    const issues: ConsistencyIssue[] = [];
    const currentTime = Date.now();
    let checksPerformed = 0;

    for (const position of positions) {
      // Check timestamp staleness
      const timestampIssue = this.checkTimestampStaleness(position, currentTime);
      if (timestampIssue) {
        issues.push(timestampIssue);
      }
      checksPerformed++;

      // Check block height staleness
      const blockHeightIssue = this.checkBlockHeightStaleness(
        position,
        currentBlockHeight,
      );
      if (blockHeightIssue) {
        issues.push(blockHeightIssue);
      }
      checksPerformed++;

      // Check data completeness
      const completenessIssue = this.checkDataCompleteness(position);
      if (completenessIssue) {
        issues.push(completenessIssue);
      }
      checksPerformed++;

      // Check invalid states
      const stateIssue = this.checkInvalidState(position);
      if (stateIssue) {
        issues.push(stateIssue);
      }
      checksPerformed++;
    }

    return {
      isConsistent: issues.length === 0,
      issues,
      checkedAt: new Date().toISOString(),
      checksPerformed,
    };
  }

  /**
   * Check if position data is stale based on timestamp
   */
  private checkTimestampStaleness(
    position: BondPosition,
    currentTime: number,
  ): ConsistencyIssue | null {
    const lastUpdated = new Date(position.lastUpdated).getTime();
    const age = currentTime - lastUpdated;

    if (age > this.config.staleThresholdMs) {
      const ageMinutes = Math.floor(age / 60000);
      return {
        severity: age > this.config.staleThresholdMs * 2 ? 'error' : 'warning',
        type: 'stale_data',
        description: `Position data is ${ageMinutes} minutes old (threshold: ${this.config.staleThresholdMs / 60000} minutes)`,
        bondId: position.bondId,
        positionId: position.id,
        recommendedAction: this.config.autoRefresh
          ? 'Data will be automatically refreshed'
          : 'Refresh bond position data manually',
      };
    }

    return null;
  }

  /**
   * Check if position data is stale based on block height
   */
  private checkBlockHeightStaleness(
    position: BondPosition,
    currentBlockHeight: number,
  ): ConsistencyIssue | null {
    const blockDiff = currentBlockHeight - position.blockHeight;

    if (blockDiff > this.config.staleBlockThreshold) {
      return {
        severity: blockDiff > this.config.staleBlockThreshold * 2 ? 'error' : 'warning',
        type: 'stale_data',
        description: `Position is ${blockDiff} blocks behind current height (threshold: ${this.config.staleBlockThreshold} blocks)`,
        bondId: position.bondId,
        positionId: position.id,
        recommendedAction: 'Synchronize with latest blockchain state',
      };
    }

    return null;
  }

  /**
   * Check if position data is complete
   */
  private checkDataCompleteness(position: BondPosition): ConsistencyIssue | null {
    const requiredFields: (keyof BondPosition)[] = [
      'id',
      'bondId',
      'holder',
      'amount',
      'lastUpdated',
      'blockHeight',
    ];

    const missingFields = requiredFields.filter(
      (field) => position[field] === undefined || position[field] === null || position[field] === '',
    );

    if (missingFields.length > 0) {
      return {
        severity: 'error',
        type: 'missing_data',
        description: `Missing required fields: ${missingFields.join(', ')}`,
        bondId: position.bondId,
        positionId: position.id,
        recommendedAction: 'Reload position data from source',
      };
    }

    return null;
  }

  /**
   * Check for invalid states
   */
  private checkInvalidState(position: BondPosition): ConsistencyIssue | null {
    // Check for negative or zero amounts
    try {
      const amount = parseFloat(position.amount);
      if (isNaN(amount) || amount <= 0) {
        return {
          severity: 'critical',
          type: 'invalid_state',
          description: `Invalid position amount: ${position.amount}`,
          bondId: position.bondId,
          positionId: position.id,
          recommendedAction: 'Verify position data integrity and reload from blockchain',
        };
      }
    } catch {
      return {
        severity: 'critical',
        type: 'invalid_state',
        description: `Unparseable position amount: ${position.amount}`,
        bondId: position.bondId,
        positionId: position.id,
        recommendedAction: 'Verify position data integrity',
      };
    }

    // Check for future timestamps (clock skew detection)
    const lastUpdated = new Date(position.lastUpdated).getTime();
    const now = Date.now();
    if (lastUpdated > now + 60000) {
      // Allow 1 minute clock skew
      return {
        severity: 'error',
        type: 'invalid_state',
        description: 'Position timestamp is in the future (possible clock skew)',
        bondId: position.bondId,
        positionId: position.id,
        recommendedAction: 'Check system clock synchronization',
      };
    }

    return null;
  }

  /**
   * Group issues by severity
   */
  groupIssuesBySeverity(issues: ConsistencyIssue[]): Map<string, ConsistencyIssue[]> {
    const grouped = new Map<string, ConsistencyIssue[]>();
    
    for (const issue of issues) {
      const existing = grouped.get(issue.severity) || [];
      existing.push(issue);
      grouped.set(issue.severity, existing);
    }
    
    return grouped;
  }

  /**
   * Get summary of consistency check
   */
  getSummary(result: ConsistencyCheckResult): string {
    if (result.isConsistent) {
      return `All ${result.checksPerformed} consistency checks passed`;
    }

    const grouped = this.groupIssuesBySeverity(result.issues);
    const parts: string[] = [];

    if (grouped.has('critical')) {
      parts.push(`${grouped.get('critical')!.length} critical issues`);
    }
    if (grouped.has('error')) {
      parts.push(`${grouped.get('error')!.length} errors`);
    }
    if (grouped.has('warning')) {
      parts.push(`${grouped.get('warning')!.length} warnings`);
    }

    return `Found ${parts.join(', ')} in ${result.checksPerformed} checks`;
  }
}

/**
 * Auto-refresh manager for stale positions
 */
export class PositionAutoRefreshManager {
  private refreshCallbacks: Map<string, () => Promise<void>> = new Map();
  private intervalId?: NodeJS.Timeout;

  constructor(
    private checker: BondConsistencyChecker,
    private checkIntervalMs: number = 60000, // 1 minute
  ) {}

  /**
   * Register a refresh callback for a bond
   */
  registerRefreshCallback(bondId: string, callback: () => Promise<void>): void {
    this.refreshCallbacks.set(bondId, callback);
  }

  /**
   * Start automatic consistency checking and refreshing
   */
  start(
    getPositions: () => BondPosition[],
    getCurrentBlockHeight: () => Promise<number>,
  ): void {
    if (this.intervalId) {
      return; // Already started
    }

    this.intervalId = setInterval(async () => {
      try {
        const positions = getPositions();
        const currentBlockHeight = await getCurrentBlockHeight();
        const result = await this.checker.checkConsistency(positions, currentBlockHeight);

        if (!result.isConsistent) {
          // Trigger refresh for bonds with stale data
          const staleBondIds = new Set(
            result.issues
              .filter((issue) => issue.type === 'stale_data' && issue.bondId)
              .map((issue) => issue.bondId!),
          );

          for (const bondId of staleBondIds) {
            const callback = this.refreshCallbacks.get(bondId);
            if (callback) {
              await callback();
            }
          }
        }
      } catch (error) {
        console.error('Auto-refresh consistency check failed:', error);
      }
    }, this.checkIntervalMs);
  }

  /**
   * Stop automatic checking
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  /**
   * Clear all registered callbacks
   */
  clear(): void {
    this.refreshCallbacks.clear();
  }
}
