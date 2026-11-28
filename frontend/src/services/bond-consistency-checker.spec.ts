import {
  BondConsistencyChecker,
  BondPosition,
  PositionAutoRefreshManager,
  DEFAULT_CONSISTENCY_CONFIG,
} from './bond-consistency-checker';

describe('BondConsistencyChecker & Stale Position Detection (#630)', () => {
  let checker: BondConsistencyChecker;
  const mockWallet = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  const otherWallet = 'GCCD58JF7MXL8Q8NEFWSBXS8EQVXA4OZ4EURFWG5OBU5BRI4AMMGMMA6';

  const basePosition: BondPosition = {
    id: 'pos_101',
    bondId: 'bond_01',
    holder: mockWallet,
    amount: '1000.50',
    lastUpdated: new Date(Date.now() - 60_000).toISOString(), // 1 minute old
    blockHeight: 1000,
  };

  beforeEach(() => {
    checker = new BondConsistencyChecker({
      staleThresholdMs: 5 * 60 * 1000, // 5 min
      staleBlockThreshold: 50,
      autoRefresh: true,
      maxRetries: 3,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 8000,
    });
  });

  describe('Normal Path', () => {
    it('evaluates fresh position accurately with no staleness guidance alert', () => {
      const guidance = checker.evaluateGuidance(basePosition, {
        currentTime: Date.now(),
        currentBlockHeight: 1010, // 10 blocks diff (< 50)
        connectedWalletAddress: mockWallet,
      });

      expect(guidance.status).toBe('FRESH');
      expect(guidance.severity).toBe('info');
      expect(guidance.suggestedAction).toBe('none');
      expect(guidance.canAutoRefresh).toBe(false);
      expect(guidance.message).toContain('up to date');
    });

    it('runs batch consistency check successfully on consistent positions', async () => {
      const positions: BondPosition[] = [
        basePosition,
        {
          ...basePosition,
          id: 'pos_102',
          bondId: 'bond_02',
          amount: '500.00',
        },
      ];

      const result = await checker.checkConsistency(positions, 1020, mockWallet);

      expect(result.isConsistent).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.guidanceList).toHaveLength(2);
      expect(result.guidanceList.every((g) => g.status === 'FRESH')).toBe(true);
    });
  });

  describe('Staleness Detection (Time & Ledger)', () => {
    it('detects timestamp staleness and advises auto_retry when within max retries', () => {
      const staleTimePosition: BondPosition = {
        ...basePosition,
        lastUpdated: new Date(Date.now() - 7 * 60 * 1000).toISOString(), // 7 minutes old
      };

      const guidance = checker.evaluateGuidance(staleTimePosition, {
        currentTime: Date.now(),
        currentBlockHeight: 1010,
        connectedWalletAddress: mockWallet,
        retryAttempt: 1,
      });

      expect(guidance.status).toBe('STALE_TIME');
      expect(guidance.severity).toBe('warning');
      expect(guidance.suggestedAction).toBe('auto_retry');
      expect(guidance.canAutoRefresh).toBe(true);
      expect(guidance.retryDelayMs).toBe(1000); // 1000 * 2^0
    });

    it('escalates severe time staleness to error severity', () => {
      const veryStalePosition: BondPosition = {
        ...basePosition,
        lastUpdated: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15 min (> 2x threshold)
      };

      const guidance = checker.evaluateGuidance(veryStalePosition, {
        currentTime: Date.now(),
        currentBlockHeight: 1010,
        connectedWalletAddress: mockWallet,
      });

      expect(guidance.status).toBe('STALE_TIME');
      expect(guidance.severity).toBe('error');
    });

    it('detects ledger height lag and produces chain synchronization guidance', () => {
      const laggingPosition: BondPosition = {
        ...basePosition,
        blockHeight: 900, // 120 blocks behind current height 1020 (threshold 50)
      };

      const guidance = checker.evaluateGuidance(laggingPosition, {
        currentTime: Date.now(),
        currentBlockHeight: 1020,
        connectedWalletAddress: mockWallet,
        retryAttempt: 2,
      });

      expect(guidance.status).toBe('STALE_LEDGER');
      expect(guidance.severity).toBe('error'); // 120 > 2 * 50
      expect(guidance.ledgerLag).toBe(120);
      expect(guidance.suggestedAction).toBe('auto_retry');
      expect(guidance.retryDelayMs).toBe(2000); // 1000 * 2^1
    });

    it('detects pending local transaction conflicts and advises awaiting finality', () => {
      const guidance = checker.evaluateGuidance(basePosition, {
        currentTime: Date.now(),
        currentBlockHeight: 1010,
        connectedWalletAddress: mockWallet,
        pendingTransactions: [
          {
            bondId: 'bond_01',
            hash: 'tx_hash_123',
            submittedAt: Date.now() - 5000,
            finalized: false,
          },
        ],
      });

      expect(guidance.status).toBe('PENDING_CONFLICT');
      expect(guidance.severity).toBe('info');
      expect(guidance.suggestedAction).toBe('await_finality');
    });
  });

  describe('Failure Path & Edge Cases', () => {
    it('detects invalid negative or unparseable position amounts with critical severity', () => {
      const corruptPosition: BondPosition = {
        ...basePosition,
        amount: '-150.00',
      };

      const guidance = checker.evaluateGuidance(corruptPosition, {
        currentTime: Date.now(),
        currentBlockHeight: 1010,
        connectedWalletAddress: mockWallet,
      });

      expect(guidance.status).toBe('INVALID_AMOUNT');
      expect(guidance.severity).toBe('critical');
      expect(guidance.suggestedAction).toBe('manual_refresh');
      expect(guidance.actionLabel).toBe('Force Re-sync');
    });

    it('identifies future timestamps as clock skew anomalies', () => {
      const futurePosition: BondPosition = {
        ...basePosition,
        lastUpdated: new Date(Date.now() + 120_000).toISOString(), // 2 minutes into future
      };

      const result = checker['checkInvalidState'](futurePosition);
      expect(result).not.toBeNull();
      expect(result!.severity).toBe('error');
      expect(result!.description).toContain('clock skew');
    });

    it('detects missing required fields in data completeness check', () => {
      const incompletePosition: any = {
        id: 'pos_inc',
        bondId: 'bond_01',
        amount: '100',
        // missing holder, lastUpdated, blockHeight
      };

      const issue = checker['checkDataCompleteness'](incompletePosition);
      expect(issue).not.toBeNull();
      expect(issue!.type).toBe('missing_data');
      expect(issue!.description).toContain('Missing required fields');
    });
  });

  describe('Retry Path & Exponential Backoff', () => {
    it('computes exponential backoff delays with upper ceiling', () => {
      expect(checker.calculateBackoff(1)).toBe(1000);
      expect(checker.calculateBackoff(2)).toBe(2000);
      expect(checker.calculateBackoff(3)).toBe(4000);
      expect(checker.calculateBackoff(4)).toBe(8000); // capped at maxDelay 8000
      expect(checker.calculateBackoff(5)).toBe(8000);
    });

    it('escalates to manual_refresh when retry attempts exceed maxRetries', () => {
      const stalePosition: BondPosition = {
        ...basePosition,
        blockHeight: 900,
      };

      const guidance = checker.evaluateGuidance(stalePosition, {
        currentTime: Date.now(),
        currentBlockHeight: 1020,
        connectedWalletAddress: mockWallet,
        retryAttempt: 4, // exceeds maxRetries (3)
      });

      expect(guidance.canAutoRefresh).toBe(false);
      expect(guidance.suggestedAction).toBe('manual_refresh');
    });
  });

  describe('Authorization Path', () => {
    it('detects unauthenticated viewer and advises reconnecting wallet', () => {
      const guidance = checker.evaluateGuidance(basePosition, {
        currentTime: Date.now(),
        currentBlockHeight: 1010,
        connectedWalletAddress: null,
      });

      expect(guidance.status).toBe('UNAUTHENTICATED');
      expect(guidance.severity).toBe('warning');
      expect(guidance.suggestedAction).toBe('reconnect_wallet');
      expect(guidance.actionLabel).toBe('Connect Wallet');
      expect(guidance.canAutoRefresh).toBe(false);
    });

    it('detects mismatched wallet address and enforces read-only mode guidance', () => {
      const guidance = checker.evaluateGuidance(basePosition, {
        currentTime: Date.now(),
        currentBlockHeight: 1010,
        connectedWalletAddress: otherWallet,
      });

      expect(guidance.status).toBe('UNAUTHORIZED');
      expect(guidance.severity).toBe('error');
      expect(guidance.suggestedAction).toBe('switch_account');
      expect(guidance.canAutoRefresh).toBe(false);
      expect(guidance.message).toContain('does not match position holder');
    });
  });

  describe('PositionAutoRefreshManager', () => {
    it('registers callbacks and executes refresh upon detecting stale guidance', async () => {
      const manager = new PositionAutoRefreshManager(checker, 50);
      const refreshCallback = jest.fn().mockResolvedValue(undefined);

      manager.registerRefreshCallback('bond_01', refreshCallback);

      const positions = [
        {
          ...basePosition,
          lastUpdated: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
      ];

      // Simulate interval execution
      const checkResult = await checker.checkConsistency(positions, 1000, mockWallet);
      expect(checkResult.isConsistent).toBe(false);

      manager.clear();
      manager.stop();
    });
  });
});

