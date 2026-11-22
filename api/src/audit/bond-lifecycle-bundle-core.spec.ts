import {
  BOND_LIFECYCLE_BUNDLE_SCHEMA_VERSION,
  BondLifecycleBundle,
  BuildBondLifecycleBundleInput,
  buildBondLifecycleBundle,
  canonicalize,
  verifyBondLifecycleBundle,
} from './bond-lifecycle-bundle-core';

const DIGEST = 'a'.repeat(64);
const AS_OF = '2026-11-22T00:00:00.000Z';

function event(stage: any, path: any, action: string, overrides: Record<string, unknown> = {}) {
  return {
    stage,
    path,
    action,
    outcome: path === 'failure' ? 'rejected' : 'applied',
    dedupeKey: action,
    actorDigest: DIGEST,
    ...overrides,
  } as any;
}

function input(overrides: Partial<BuildBondLifecycleBundleInput> = {}): BuildBondLifecycleBundleInput {
  const defaults: BuildBondLifecycleBundleInput = {
    bondId: 7,
    caseId: 'AUD-640',
    asOf: AS_OF,
    generatedByDigest: DIGEST,
    events: [
      event('issue', 'normal', 'issued'),
      event('subscribe', 'normal', 'subscribed'),
      event('coupon', 'normal', 'coupon-distributed'),
      event('redeem', 'normal', 'redeemed'),
      event('redeem', 'failure', 'underfunded'),
      event('redeem', 'retry', 'reconciled'),
      event('issue', 'authorization', 'admin-only'),
    ],
    financialState: {
      totalSupplyMinor: '1000',
      totalSubscribedMinor: '1000',
      holderBalancesMinor: ['600', '400'],
      redemptionAmountsMinor: ['1000'],
      faceValueMinor: '2',
    },
    sourceChain: {
      entityType: 'bond',
      entityId: '7',
      chainHead: DIGEST,
      verification: { ok: true, checkedEntries: 7, failures: [] },
    },
  };
  return { ...defaults, ...overrides } as BuildBondLifecycleBundleInput;
}

describe('bond lifecycle audit bundles (#640)', () => {
  it('canonicalizes objects recursively', () => {
    expect(JSON.stringify(canonicalize({ b: 1, a: { d: 2, c: 3 } }))).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('produces byte-identical bundles from equivalent inputs', () => {
    const first = buildBondLifecycleBundle(input());
    const reversed = input();
    reversed.events = [...reversed.events].reverse();
    const second = buildBondLifecycleBundle(reversed);
    expect(second).toEqual(first);
    expect(first.schemaVersion).toBe(BOND_LIFECYCLE_BUNDLE_SCHEMA_VERSION);
  });

  it('covers all stages and all four operational paths', () => {
    const bundle = buildBondLifecycleBundle(input());
    expect(Object.values(bundle.stages).every((coverage) => coverage.count > 0)).toBe(true);
    expect(Object.values(bundle.paths).every((coverage) => coverage.count > 0)).toBe(true);
    expect(verifyBondLifecycleBundle(bundle)).toEqual({ ok: true, problems: [] });
  });

  it('detects a bundle edited after export', () => {
    const bundle = buildBondLifecycleBundle(input());
    const tampered: BondLifecycleBundle = JSON.parse(JSON.stringify(bundle));
    tampered.financialInvariants[0].detail = 'edited';
    const result = verifyBondLifecycleBundle(tampered);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('bundle digest mismatch');
  });

  it('detects a broken event chain', () => {
    const bundle = buildBondLifecycleBundle(input());
    const tampered: BondLifecycleBundle = JSON.parse(JSON.stringify(bundle));
    tampered.lifecycle.events[2].previousEventId = 'f'.repeat(64);
    expect(verifyBondLifecycleBundle(tampered).problems.join('\n')).toContain('does not link');
  });

  it('flags a failed source chain verification', () => {
    const source = input().sourceChain;
    source.verification.ok = false;
    const bundle = buildBondLifecycleBundle(input({ sourceChain: source }));
    expect(verifyBondLifecycleBundle(bundle).problems).toContain('source chain failed verification at export time');
  });

  it('reports missing paths instead of silently passing', () => {
    const events = input().events.filter((item) => item.path !== 'authorization');
    const bundle = buildBondLifecycleBundle(input({ events }));
    expect(verifyBondLifecycleBundle(bundle).problems).toContain('missing lifecycle path: authorization');
  });

  it('rejects broken financial invariants', () => {
    const financialState = input().financialState;
    financialState.holderBalancesMinor = ['500'];
    const bundle = buildBondLifecycleBundle(input({ financialState }));
    expect(verifyBondLifecycleBundle(bundle).problems.join('\n')).toContain('INV-02');
  });

  it('rejects an applied failure-path event', () => {
    const events = input().events.map((item) =>
      item.path === 'failure' ? { ...item, outcome: 'applied' as const } : item,
    );
    const bundle = buildBondLifecycleBundle(input({ events }));
    expect(verifyBondLifecycleBundle(bundle).problems.join('\n')).toContain('INV-05');
  });

  it('rejects an obvious unredacted secret', () => {
    const events = input().events.map((item) =>
      item.action === 'issued' ? { ...item, detail: 'alice@example.com' } : item,
    );
    const bundle = buildBondLifecycleBundle(input({ events }));
    expect(verifyBondLifecycleBundle(bundle).problems.join('\n')).toContain('possible unredacted value');
  });
});
