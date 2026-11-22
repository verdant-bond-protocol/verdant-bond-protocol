import { createHash } from 'crypto';

export const BOND_LIFECYCLE_BUNDLE_SCHEMA_VERSION = 1;
export const BOND_LIFECYCLE_STAGES = ['issue', 'subscribe', 'coupon', 'redeem'] as const;
export const BOND_LIFECYCLE_PATHS = ['normal', 'failure', 'retry', 'authorization'] as const;
export const BOND_LIFECYCLE_OUTCOMES = ['applied', 'rejected', 'observed'] as const;

export type BondLifecycleStage = (typeof BOND_LIFECYCLE_STAGES)[number];
export type BondLifecyclePath = (typeof BOND_LIFECYCLE_PATHS)[number];
export type BondLifecycleOutcome = (typeof BOND_LIFECYCLE_OUTCOMES)[number];

export interface LifecycleEvidenceEvent {
  stage: BondLifecycleStage;
  path: BondLifecyclePath;
  action: string;
  outcome: BondLifecycleOutcome;
  dedupeKey: string;
  actorDigest: string;
  detail?: string;
  amountMinorUnits?: string;
  auditSequence?: number;
  auditHash?: string;
}

export interface BondLifecycleFinancialState {
  totalSupplyMinor: string;
  totalSubscribedMinor: string;
  holderBalancesMinor: string[];
  redemptionAmountsMinor: string[];
  faceValueMinor: string;
}

export interface BondLifecycleSourceChain {
  entityType: string;
  entityId: string;
  chainHead: string | null;
  verification: {
    ok: boolean;
    checkedEntries: number;
    failures: Array<{ index: number; reason: string }>;
  };
}

export interface BondLifecycleRawExportEvidence {
  checksum: string;
  counts: {
    lifecycleEvents: number;
    holders: number;
    couponDistributions: number;
    retirements: number;
  };
}

export interface BuildBondLifecycleBundleInput {
  bondId: string | number;
  caseId: string;
  asOf: string;
  generatedByDigest: string;
  events: LifecycleEvidenceEvent[];
  financialState: BondLifecycleFinancialState;
  sourceChain: BondLifecycleSourceChain;
  rawExport?: BondLifecycleRawExportEvidence;
  redactions?: Array<{ path: string; rule: string }>;
}

export interface BondLifecycleBundleEvent extends LifecycleEvidenceEvent {
  index: number;
  previousEventId: string | null;
  eventId: string;
}

export interface LifecycleCoverage {
  count: number;
  eventIds: string[];
}

export interface BondLifecycleInvariant {
  id: string;
  ok: boolean;
  detail: string;
}

export interface BondLifecycleBundle {
  schemaVersion: number;
  bundleId: string;
  caseId: string;
  bondId: string;
  asOf: string;
  generatedByDigest: string;
  sourceChain: BondLifecycleSourceChain;
  rawExport: BondLifecycleRawExportEvidence | null;
  lifecycle: {
    chainHead: string | null;
    events: BondLifecycleBundleEvent[];
  };
  stages: Record<BondLifecycleStage, LifecycleCoverage>;
  paths: Record<BondLifecyclePath, LifecycleCoverage>;
  financialInvariants: BondLifecycleInvariant[];
  redactions: Array<{ path: string; rule: string }>;
  digest: string;
}

export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = canonicalize(source[key]);
  }
  return sorted;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function digestOf(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isMinor(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value) && value.length <= 64;
}

function readMinor(value: unknown, label: string): bigint {
  if (!isMinor(value)) throw new Error(`${label} must be a base-10 minor-unit string`);
  const parsed = BigInt(value);
  if (parsed > (1n << 127n) - 1n) throw new Error(`${label} exceeds i128 range`);
  return parsed;
}

function requireIso(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 40) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  let parsed: Date;
  try {
    parsed = new Date(value);
  } catch {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

function normalizeEvent(value: LifecycleEvidenceEvent, label: string): LifecycleEvidenceEvent {
  if (!value || typeof value !== 'object') throw new Error(`${label} must be an object`);
  if (!BOND_LIFECYCLE_STAGES.includes(value.stage)) throw new Error(`${label}.stage is unsupported`);
  if (!BOND_LIFECYCLE_PATHS.includes(value.path)) throw new Error(`${label}.path is unsupported`);
  if (!BOND_LIFECYCLE_OUTCOMES.includes(value.outcome)) throw new Error(`${label}.outcome is unsupported`);
  if (typeof value.action !== 'string' || !value.action.trim() || value.action.length > 200) {
    throw new Error(`${label}.action must be a non-empty string of at most 200 characters`);
  }
  if (typeof value.dedupeKey !== 'string' || !value.dedupeKey.trim() || value.dedupeKey.length > 200) {
    throw new Error(`${label}.dedupeKey must be a non-empty string of at most 200 characters`);
  }
  if (!isHex64(value.actorDigest)) throw new Error(`${label}.actorDigest must be a sha256 hex digest`);
  if (value.detail !== undefined && (typeof value.detail !== 'string' || value.detail.length > 500)) {
    throw new Error(`${label}.detail must be a string of at most 500 characters`);
  }
  if (value.amountMinorUnits !== undefined) readMinor(value.amountMinorUnits, `${label}.amountMinorUnits`);
  if (
    value.auditSequence !== undefined &&
    (!Number.isInteger(value.auditSequence) || value.auditSequence < 0)
  ) {
    throw new Error(`${label}.auditSequence must be a non-negative integer`);
  }
  if (value.auditHash !== undefined && !isHex64(value.auditHash)) {
    throw new Error(`${label}.auditHash must be a sha256 hex digest`);
  }

  const normalized: LifecycleEvidenceEvent = {
    stage: value.stage,
    path: value.path,
    action: value.action,
    outcome: value.outcome,
    dedupeKey: value.dedupeKey,
    actorDigest: value.actorDigest,
  };
  if (value.detail !== undefined) normalized.detail = value.detail;
  if (value.amountMinorUnits !== undefined) normalized.amountMinorUnits = value.amountMinorUnits;
  if (value.auditSequence !== undefined) normalized.auditSequence = value.auditSequence;
  if (value.auditHash !== undefined) normalized.auditHash = value.auditHash;
  return normalized;
}

function validateSourceChain(value: BondLifecycleSourceChain): void {
  if (!value || typeof value !== 'object') throw new Error('sourceChain must be an object');
  if (typeof value.entityType !== 'string' || !value.entityType.trim()) {
    throw new Error('sourceChain.entityType is required');
  }
  if (typeof value.entityId !== 'string' || !value.entityId.trim()) {
    throw new Error('sourceChain.entityId is required');
  }
  if (value.chainHead !== null && !isHex64(value.chainHead)) {
    throw new Error('sourceChain.chainHead must be null or a sha256 hex digest');
  }
  if (!value.verification || typeof value.verification.ok !== 'boolean') {
    throw new Error('sourceChain.verification.ok must be a boolean');
  }
  if (!Number.isInteger(value.verification.checkedEntries) || value.verification.checkedEntries < 0) {
    throw new Error('sourceChain.verification.checkedEntries must be a non-negative integer');
  }
  if (!Array.isArray(value.verification.failures)) {
    throw new Error('sourceChain.verification.failures must be an array');
  }
  for (const failure of value.verification.failures) {
    if (!failure || typeof failure.reason !== 'string' || !Number.isInteger(failure.index)) {
      throw new Error('sourceChain.verification.failures are malformed');
    }
  }
}

function validateRawExport(value: BondLifecycleRawExportEvidence): void {
  if (!value || typeof value !== 'object') throw new Error('rawExport must be an object');
  if (!isHex64(value.checksum)) throw new Error('rawExport.checksum must be a sha256 hex digest');
  if (!value.counts || typeof value.counts !== 'object') throw new Error('rawExport.counts must be an object');
  for (const key of ['lifecycleEvents', 'holders', 'couponDistributions', 'retirements'] as const) {
    if (!Number.isInteger(value.counts[key]) || value.counts[key] < 0) {
      throw new Error(`rawExport.counts.${key} must be a non-negative integer`);
    }
  }
}

function validateRedactions(value: Array<{ path: string; rule: string }>): void {
  if (!Array.isArray(value)) throw new Error('redactions must be an array');
  for (const item of value) {
    if (!item || typeof item.path !== 'string' || !item.path || typeof item.rule !== 'string' || !item.rule) {
      throw new Error('redactions entries need a path and a rule');
    }
  }
}

function coverageFor<T extends string>(
  keys: readonly T[],
  events: BondLifecycleBundleEvent[],
  select: (event: BondLifecycleBundleEvent) => T,
): Record<T, LifecycleCoverage> {
  const result = {} as Record<T, LifecycleCoverage>;
  for (const key of keys) result[key] = { count: 0, eventIds: [] };
  for (const event of events) {
    const bucket = result[select(event)];
    bucket.count += 1;
    bucket.eventIds.push(event.eventId);
  }
  return result;
}

function evaluateInvariants(
  input: BuildBondLifecycleBundleInput,
  chain: BondLifecycleBundleEvent[],
): BondLifecycleInvariant[] {
  const state = input.financialState;
  if (!state || typeof state !== 'object') throw new Error('financialState must be an object');
  const supply = readMinor(state.totalSupplyMinor, 'financialState.totalSupplyMinor');
  const subscribed = readMinor(state.totalSubscribedMinor, 'financialState.totalSubscribedMinor');
  const faceValue = readMinor(state.faceValueMinor, 'financialState.faceValueMinor');
  if (!Array.isArray(state.holderBalancesMinor)) throw new Error('financialState.holderBalancesMinor must be an array');
  if (!Array.isArray(state.redemptionAmountsMinor)) throw new Error('financialState.redemptionAmountsMinor must be an array');

  const balances = state.holderBalancesMinor.map((value, i) =>
    readMinor(value, `financialState.holderBalancesMinor[${i}]`),
  );
  const redemptions = state.redemptionAmountsMinor.map((value, i) =>
    readMinor(value, `financialState.redemptionAmountsMinor[${i}]`),
  );
  const balanceSum = balances.reduce((sum, value) => sum + value, 0n);
  const redemptionSum = redemptions.reduce((sum, value) => sum + value, 0n);
  const appliedFailure = chain.some((event) => event.path === 'failure' && event.outcome === 'applied');
  const appliedRetryKeys = chain
    .filter((event) => event.path === 'retry' && event.outcome === 'applied')
    .map((event) => event.dedupeKey);
  const duplicateRetryKeys = appliedRetryKeys.filter((key, i) => appliedRetryKeys.indexOf(key) !== i);

  return [
    {
      id: 'INV-01',
      ok: subscribed <= supply,
      detail: `totalSubscribed=${subscribed.toString()} totalSupply=${supply.toString()}`,
    },
    {
      id: 'INV-02',
      ok: balanceSum === subscribed,
      detail: `sum(holderBalances)=${balanceSum.toString()} totalSubscribed=${subscribed.toString()}`,
    },
    {
      id: 'INV-03',
      ok: redemptionSum <= supply,
      detail: `sum(redemptions)=${redemptionSum.toString()} totalSupply=${supply.toString()}`,
    },
    {
      id: 'INV-04',
      ok: faceValue > 0n,
      detail: `faceValue=${faceValue.toString()}`,
    },
    {
      id: 'INV-05',
      ok: !appliedFailure,
      detail: 'failure-path events must be rejected or observed',
    },
    {
      id: 'INV-06',
      ok: duplicateRetryKeys.length === 0,
      detail: `duplicate applied retry keys=${duplicateRetryKeys.length}`,
    },
  ];
}

function deriveBundleId(
  bondId: string,
  caseId: string,
  asOf: string,
  chainHead: string | null,
  sourceChainHead: string | null,
): string {
  return `blb-${digestOf({ bondId, caseId, asOf, chainHead, sourceChainHead })}`;
}

export function buildBondLifecycleBundle(input: BuildBondLifecycleBundleInput): BondLifecycleBundle {
  if (!input || typeof input !== 'object') throw new Error('bundle input must be an object');
  const bondId = String(input.bondId ?? '');
  if (!/^\d+$/.test(bondId)) throw new Error('bondId must be a non-negative integer');
  if (typeof input.caseId !== 'string' || !input.caseId.trim()) throw new Error('caseId is required');
  if (input.caseId.length > 200) throw new Error('caseId is too long');
  const caseId = input.caseId;
  const asOf = requireIso(input.asOf, 'asOf');
  if (!isHex64(input.generatedByDigest)) throw new Error('generatedByDigest must be a sha256 hex digest');
  if (!Array.isArray(input.events)) throw new Error('events must be an array');
  validateSourceChain(input.sourceChain);
  if (input.rawExport !== undefined) validateRawExport(input.rawExport);
  validateRedactions(input.redactions ?? []);

  const sorted = input.events
    .map((event, i) => normalizeEvent(event, `events[${i}]`))
    .sort((left, right) => {
      const a = stableStringify(left);
      const b = stableStringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });

  let previousEventId: string | null = null;
  const chain: BondLifecycleBundleEvent[] = sorted.map((event, index) => {
    const fields = { ...event, index, previousEventId };
    const eventId = digestOf({ bondId, caseId, asOf, ...fields });
    previousEventId = eventId;
    return { ...fields, eventId };
  });

  const chainHead = chain.length ? chain[chain.length - 1].eventId : null;
  const body: Omit<BondLifecycleBundle, 'digest'> = {
    schemaVersion: BOND_LIFECYCLE_BUNDLE_SCHEMA_VERSION,
    bundleId: deriveBundleId(bondId, caseId, asOf, chainHead, input.sourceChain.chainHead),
    caseId,
    bondId,
    asOf,
    generatedByDigest: input.generatedByDigest,
    sourceChain: {
      entityType: input.sourceChain.entityType,
      entityId: input.sourceChain.entityId,
      chainHead: input.sourceChain.chainHead,
      verification: {
        ok: input.sourceChain.verification.ok,
        checkedEntries: input.sourceChain.verification.checkedEntries,
        failures: input.sourceChain.verification.failures.map((failure) => ({
          index: failure.index,
          reason: failure.reason,
        })),
      },
    },
    rawExport: input.rawExport ?? null,
    lifecycle: { chainHead, events: chain },
    stages: coverageFor(BOND_LIFECYCLE_STAGES, chain, (event) => event.stage),
    paths: coverageFor(BOND_LIFECYCLE_PATHS, chain, (event) => event.path),
    financialInvariants: evaluateInvariants(input, chain),
    redactions: [...(input.redactions ?? [])].map((item) => ({ path: item.path, rule: item.rule })),
  };

  return { ...body, digest: digestOf(body) };
}

const LEAK_PATTERNS = [
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/,
  /^S[2-7A-Z]{55}$/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function findLeaks(value: unknown, path: string, found: string[]): void {
  if (typeof value === 'string') {
    if (LEAK_PATTERNS.some((pattern) => pattern.test(value))) found.push(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => findLeaks(item, `${path}[${i}]`, found));
    return;
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) findLeaks(source[key], `${path}.${key}`, found);
  }
}

export function verifyBondLifecycleBundle(bundle: BondLifecycleBundle): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!bundle || typeof bundle !== 'object') return { ok: false, problems: ['bundle must be an object'] };

  if (bundle.schemaVersion !== BOND_LIFECYCLE_BUNDLE_SCHEMA_VERSION) {
    problems.push(`unsupported schemaVersion ${bundle.schemaVersion}`);
  }
  const { digest, ...body } = bundle as BondLifecycleBundle;
  if (!isHex64(digest) || digestOf(body) !== digest) problems.push('bundle digest mismatch');
  if (typeof bundle.bondId !== 'string' || !/^\d+$/.test(bundle.bondId)) problems.push('bondId is malformed');
  if (typeof bundle.caseId !== 'string' || !bundle.caseId.trim()) problems.push('caseId is missing');
  try {
    requireIso(bundle.asOf, 'asOf');
  } catch {
    problems.push('asOf is malformed');
  }
  if (!isHex64(bundle.generatedByDigest)) problems.push('generatedByDigest is malformed');

  const expectedBundleId = deriveBundleId(
    bundle.bondId,
    bundle.caseId,
    bundle.asOf,
    bundle.lifecycle?.chainHead ?? null,
    bundle.sourceChain?.chainHead ?? null,
  );
  if (bundle.bundleId !== expectedBundleId) problems.push('bundleId mismatch');

  const chain = Array.isArray(bundle.lifecycle?.events) ? bundle.lifecycle.events : [];
  let previous: string | null = null;
  chain.forEach((event, index) => {
    if (event.index !== index) problems.push(`events[${index}].index is not contiguous`);
    if (event.previousEventId !== previous) problems.push(`events[${index}].previousEventId does not link`);
    let normalized: LifecycleEvidenceEvent;
    try {
      normalized = normalizeEvent(event, `events[${index}]`);
    } catch {
      problems.push(`events[${index}] is malformed`);
      return;
    }
    const expected = digestOf({
      bondId: bundle.bondId,
      caseId: bundle.caseId,
      asOf: bundle.asOf,
      index,
      previousEventId: previous,
      ...normalized,
    });
    if (event.eventId !== expected) problems.push(`events[${index}].eventId mismatch`);
    previous = event.eventId;
  });
  if ((chain[chain.length - 1]?.eventId ?? null) !== (bundle.lifecycle?.chainHead ?? null)) {
    problems.push('lifecycle.chainHead does not match the last event');
  }

  for (const stage of BOND_LIFECYCLE_STAGES) {
    if (!bundle.stages?.[stage]?.count) problems.push(`missing lifecycle stage: ${stage}`);
  }
  for (const path of BOND_LIFECYCLE_PATHS) {
    if (!bundle.paths?.[path]?.count) problems.push(`missing lifecycle path: ${path}`);
  }
  for (const invariant of bundle.financialInvariants ?? []) {
    if (!invariant.ok) problems.push(`financial invariant failed: ${invariant.id} (${invariant.detail})`);
  }
  if (!bundle.sourceChain?.verification?.ok) problems.push('source chain failed verification at export time');
  if (bundle.rawExport && !isHex64(bundle.rawExport.checksum)) problems.push('rawExport.checksum is malformed');

  try {
    validateRedactions(bundle.redactions ?? []);
  } catch {
    problems.push('redactions are malformed');
  }
  const leaks: string[] = [];
  findLeaks(bundle, '$', leaks);
  for (const leak of leaks) problems.push(`possible unredacted value at ${leak}`);

  return { ok: problems.length === 0, problems };
}
