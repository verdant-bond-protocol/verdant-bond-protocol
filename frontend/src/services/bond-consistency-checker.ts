// Issue #468 & Issue #630: Frontend consistency checks & stale position detection with refresh guidance
// Validates bond position data freshness, detects inconsistencies, and provides actionable refresh guidance

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
  lastConfirmedLedgerSeq?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Staleness status categories for frontend positions (#630)
 */
export type PositionStalenessStatus =
  | 'FRESH'
  | 'STALE_TIME'
  | 'STALE_LEDGER'
  | 'PENDING_CONFLICT'
  | 'UNVERIFIED'
  | 'UNAUTHENTICATED'
  | 'UNAUTHORIZED'
  | 'INVALID_AMOUNT';

/**
 * Actionable refresh guidance for stale frontend positions (#630)
 */
export interface PositionRefreshGuidance {
  positionId: string;
  bondId: string;
  holder: string;
  status: PositionStalenessStatus;
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  suggestedAction:
    | 'none'
    | 'manual_refresh'
    | 'auto_retry'
    | 'reconnect_wallet'
    | 'switch_account'
    | 'await_finality';
  actionLabel: string;
  canAutoRefresh: boolean;
  ageMs: number;
  ledgerLag: number;
  retryDelayMs?: number;
}

/**
 * Evaluation context passed to stale position detector
 */
export interface PositionEvaluationContext {
  currentTime?: number;
  currentBlockHeight: number;
  connectedWalletAddress?: string | null;
  pendingTransactions?: Array<{
    bondId: string;
    hash: string;
    submittedAt: number;
    finalized: boolean;
  }>;
  retryAttempt?: number;
}

/**
 * Consistency check result
 */
export interface ConsistencyCheckResult {
  isConsistent: boolean;
  issues: ConsistencyIssue[];
  guidanceList: PositionRefreshGuidance[];
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
  /** Maximum retry attempts for automatic refresh */
  maxRetries: number;
  /** Base delay in milliseconds for exponential backoff */
  retryBaseDelayMs: number;
  /** Maximum delay cap in milliseconds */
  retryMaxDelayMs: number;
}

/**
 * Default configuration
 */
export const DEFAULT_CONSISTENCY_CONFIG: ConsistencyConfig = {
  staleThresholdMs: 5 * 60 * 1000, // 5 minutes
  staleBlockThreshold: 100, // blocks (~500 seconds on Stellar)
  autoRefresh: true,
  strictMode: false,
  maxRetries: 3,
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 8000,
};

/**
 * Bond position consistency checker and stale position evaluator (#630)
 *
 * Provides:
 * - Deterministic time and ledger staleness detection (O(1) time per position, O(N) overall)
 * - Actionable refresh guidance with severity ranking
 * - Authorization validation against connected wallet
 * - Pending transaction conflict tracking
 * - Exponential backoff retry calculations
 */
export class BondConsistencyChecker {
  private config: ConsistencyConfig;

  constructor(config: Partial<ConsistencyConfig> = {}) {
    this.config = { ...DEFAULT_CONSISTENCY_CONFIG, ...config };
  }

  /**
   * Evaluates a single position and produces structured refresh guidance (#630)
   *
   * Time Complexity: O(1)
   * Space Complexity: O(1)
   */
  evaluateGuidance(
    position: BondPosition,
    context: PositionEvaluationContext,
  ): PositionRefreshGuidance {
    const currentTime = context.currentTime ?? Date.now();
    const lastUpdated = new Date(position.lastUpdated).getTime();
    const ageMs = Math.max(0, currentTime - lastUpdated);
    const ledgerLag = Math.max(0, context.currentBlockHeight - position.blockHeight);

    // 1. Authorization check: Connected wallet verification
    if (context.connectedWalletAddress === null || context.connectedWalletAddress === undefined) {
      return {
        positionId: position.id,
        bondId: position.bondId,
        holder: position.holder,
        status: 'UNAUTHENTICATED',
        severity: 'warning',
        message: 'Wallet disconnected. Reconnect wallet to verify ownership and refresh position.',
        suggestedAction: 'reconnect_wallet',
        actionLabel: 'Connect Wallet',
        canAutoRefresh: false,
        ageMs,
        ledgerLag,
      };
    }

    if (context.connectedWalletAddress.toLowerCase() !== position.holder.toLowerCase()) {
      return {
        positionId: position.id,
        bondId: position.bondId,
        holder: position.holder,
        status: 'UNAUTHORIZED',
        severity: 'error',
        message: `Connected wallet (${context.connectedWalletAddress.slice(0, 6)}...${context.connectedWalletAddress.slice(-4)}) does not match position holder. Viewing in read-only mode.`,
        suggestedAction: 'switch_account',
        actionLabel: 'Switch Account',
        canAutoRefresh: false,
        ageMs,
        ledgerLag,
      };
    }

    // 2. Invalid state check (financial amount corruption or clock skew)
    const amountVal = parseFloat(position.amount);
    if (isNaN(amountVal) || amountVal < 0) {
      return {
        positionId: position.id,
        bondId: position.bondId,
        holder: position.holder,
        status: 'INVALID_AMOUNT',
        severity: 'critical',
        message: `Corrupted position balance (${position.amount}). Refresh required from blockchain state.`,
        suggestedAction: 'manual_refresh',
        actionLabel: 'Force Re-sync',
        canAutoRefresh: false,
        ageMs,
        ledgerLag,
      };
    }

    // 3. Pending transaction conflict
    if (context.pendingTransactions && context.pendingTransactions.length > 0) {
      const pending = context.pendingTransactions.find(
        (tx) => tx.bondId === position.bondId && !tx.finalized,
      );
      if (pending) {
        return {
          positionId: position.id,
          bondId: position.bondId,
          holder: position.holder,
          status: 'PENDING_CONFLICT',
          severity: 'info',
          message: 'Recent transaction submitted. Awaiting Stellar ledger finality before updating position.',
          suggestedAction: 'await_finality',
          actionLabel: 'Awaiting Finality',
          canAutoRefresh: true,
          ageMs,
          ledgerLag,
        };
      }
    }

    // 4. Ledger height staleness
    if (ledgerLag > this.config.staleBlockThreshold) {
      const isCritical = ledgerLag > this.config.staleBlockThreshold * 2;
      const retryAttempt = context.retryAttempt ?? 1;
      const retryDelayMs = this.calculateBackoff(retryAttempt);

      return {
        positionId: position.id,
        bondId: position.bondId,
        holder: position.holder,
        status: 'STALE_LEDGER',
        severity: isCritical ? 'error' : 'warning',
        message: `Position is ${ledgerLag} ledgers behind network state (threshold: ${this.config.staleBlockThreshold}).`,
        suggestedAction: this.config.autoRefresh && retryAttempt <= this.config.maxRetries ? 'auto_retry' : 'manual_refresh',
        actionLabel: 'Refresh Position',
        canAutoRefresh: this.config.autoRefresh && retryAttempt <= this.config.maxRetries,
        ageMs,
        ledgerLag,
        retryDelayMs,
      };
    }

    // 5. Timestamp staleness
    if (ageMs > this.config.staleThresholdMs) {
      const isCritical = ageMs > this.config.staleThresholdMs * 2;
      const ageMinutes = Math.floor(ageMs / 60000);
      const retryAttempt = context.retryAttempt ?? 1;
      const retryDelayMs = this.calculateBackoff(retryAttempt);

      return {
        positionId: position.id,
        bondId: position.bondId,
        holder: position.holder,
        status: 'STALE_TIME',
        severity: isCritical ? 'error' : 'warning',
        message: `Position snapshot is ${ageMinutes} minutes old (threshold: ${this.config.staleThresholdMs / 60000}m).`,
        suggestedAction: this.config.autoRefresh && retryAttempt <= this.config.maxRetries ? 'auto_retry' : 'manual_refresh',
        actionLabel: 'Refresh Data',
        canAutoRefresh: this.config.autoRefresh && retryAttempt <= this.config.maxRetries,
        ageMs,
        ledgerLag,
        retryDelayMs,
      };
    }

    // 6. Fresh position
    return {
      positionId: position.id,
      bondId: position.bondId,
      holder: position.holder,
      status: 'FRESH',
      severity: 'info',
      message: 'Position is up to date with the latest Stellar ledger state.',
      suggestedAction: 'none',
      actionLabel: 'Up to Date',
      canAutoRefresh: false,
      ageMs,
      ledgerLag,
    };
  }

  /**
   * Check consistency of bond positions and return detailed issue report + guidance
   */
  async checkConsistency(
    positions: BondPosition[],
    currentBlockHeight: number,
    connectedWalletAddress?: string | null,
  ): Promise<ConsistencyCheckResult> {
    const issues: ConsistencyIssue[] = [];
    const guidanceList: PositionRefreshGuidance[] = [];
    const currentTime = Date.now();
    let checksPerformed = 0;

    for (const position of positions) {
      // 1. Guidance evaluation (#630)
      const guidance = this.evaluateGuidance(position, {
        currentTime,
        currentBlockHeight,
        connectedWalletAddress,
      });
      guidanceList.push(guidance);

      // 2. Timestamp staleness
      const timestampIssue = this.checkTimestampStaleness(position, currentTime);
      if (timestampIssue) {
        issues.push(timestampIssue);
      }
      checksPerformed++;

      // 3. Block height staleness
      const blockHeightIssue = this.checkBlockHeightStaleness(
        position,
        currentBlockHeight,
      );
      if (blockHeightIssue) {
        issues.push(blockHeightIssue);
      }
      checksPerformed++;

      // 4. Data completeness
      const completenessIssue = this.checkDataCompleteness(position);
      if (completenessIssue) {
        issues.push(completenessIssue);
      }
      checksPerformed++;

      // 5. Invalid states
      const stateIssue = this.checkInvalidState(position);
      if (stateIssue) {
        issues.push(stateIssue);
      }
      checksPerformed++;
    }

    return {
      isConsistent: issues.length === 0 && guidanceList.every((g) => g.status === 'FRESH'),
      issues,
      guidanceList,
      checkedAt: new Date().toISOString(),
      checksPerformed,
    };
  }

  /**
   * Calculates exponential backoff retry delay in milliseconds with ceiling
   */
  calculateBackoff(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    const delay = this.config.retryBaseDelayMs * Math.pow(2, exponent);
    return Math.min(delay, this.config.retryMaxDelayMs);
  }

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

  private checkInvalidState(position: BondPosition): ConsistencyIssue | null {
    try {
      const amount = parseFloat(position.amount);
      if (isNaN(amount) || amount < 0) {
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

    const lastUpdated = new Date(position.lastUpdated).getTime();
    const now = Date.now();
    if (lastUpdated > now + 60000) {
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

  groupIssuesBySeverity(issues: ConsistencyIssue[]): Map<string, ConsistencyIssue[]> {
    const grouped = new Map<string, ConsistencyIssue[]>();
    for (const issue of issues) {
      const existing = grouped.get(issue.severity) || [];
      existing.push(issue);
      grouped.set(issue.severity, existing);
    }
    return grouped;
  }

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
 * Auto-refresh manager for stale positions with retry support and authorization protection (#630)
 */
export class PositionAutoRefreshManager {
  private checker: BondConsistencyChecker;
  private checkIntervalMs: number;
  private refreshCallbacks: Map<string, () => Promise<void>> = new Map();
  private retryAttempts: Map<string, number> = new Map();
  private intervalId?: NodeJS.Timeout;

  constructor(
    checker: BondConsistencyChecker,
    checkIntervalMs: number = 60000,
  ) {
    this.checker = checker;
    this.checkIntervalMs = checkIntervalMs;
  }

  registerRefreshCallback(bondId: string, callback: () => Promise<void>): void {
    this.refreshCallbacks.set(bondId, callback);
  }

  start(
    getPositions: () => BondPosition[],
    getCurrentBlockHeight: () => Promise<number>,
    getConnectedWallet?: () => string | null,
  ): void {
    if (this.intervalId) {
      return;
    }

    this.intervalId = setInterval(async () => {
      try {
        const positions = getPositions();
        const currentBlockHeight = await getCurrentBlockHeight();
        const connectedWallet = getConnectedWallet ? getConnectedWallet() : null;

        const result = await this.checker.checkConsistency(
          positions,
          currentBlockHeight,
          connectedWallet,
        );

        if (!result.isConsistent) {
          for (const guidance of result.guidanceList) {
            if (guidance.canAutoRefresh && guidance.suggestedAction === 'auto_retry') {
              const currentAttempt = (this.retryAttempts.get(guidance.bondId) ?? 0) + 1;
              this.retryAttempts.set(guidance.bondId, currentAttempt);

              const callback = this.refreshCallbacks.get(guidance.bondId);
              if (callback) {
                await callback();
                this.retryAttempts.delete(guidance.bondId);
              }
            }
          }
        }
      } catch (error) {
        console.error('Auto-refresh consistency check failed:', error);
      }
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  clear(): void {
    this.refreshCallbacks.clear();
    this.retryAttempts.clear();
  }
}
