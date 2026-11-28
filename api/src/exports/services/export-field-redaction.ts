import type { ExportRole } from '../interfaces/export.interface';

/**
 * Field redaction for permission-aware exports (#506).
 *
 * The pipeline (#357/#382) decides *which* fields a role may not see. This
 * module decides *how* they are hidden:
 *
 *   - `strip` mode (default, unchanged behaviour): the field is removed.
 *   - `mask` mode (opt-in): the field stays in the record so every role gets
 *     the same column set — CSV/BI consumers do not break, and "redacted" is
 *     distinguishable from "absent". Identifiers keep their last 4 characters
 *     (`*****6789`) when long enough; everything else becomes `[REDACTED]`.
 *
 * Secrets (keys, seeds, password hashes, nonces, raw KYC documents) are
 * stripped in every mode: even their presence or length must not leak.
 *
 * Every redaction is counted in a manifest (path → strategy, count) returned
 * with the export so reviewers can audit what was withheld. Redaction is
 * deterministic — no randomness or clock — so a retried export produces
 * byte-identical output and an identical manifest.
 */

export type ExportRedactionMode = 'strip' | 'mask';
export type FieldRedactionStrategy = 'strip' | 'mask' | 'partial';

export const EXPORT_REDACTION_MODES: readonly ExportRedactionMode[] = ['strip', 'mask'];
export const REDACTION_POLICY_VERSION = '1';
export const REDACTED_PLACEHOLDER = '[REDACTED]';

/** Minimum length before the last 4 characters may be shown. */
const PARTIAL_MIN_LENGTH = 8;
const PARTIAL_VISIBLE = 4;

/** Never emitted in any form, in any mode. Lower-cased. */
const ALWAYS_STRIP = new Set(['signingkey', 'signingseed', 'privatekey', 'passwordhash', 'nonce', 'rawkycdocument']);

/** Identifiers where a suffix helps reconcile records without exposing them. Lower-cased. */
const PARTIAL_FIELDS = new Set(['ssn', 'nationalid', 'passportnumber', 'taxid']);

/** `__proto__` would rewrite the copy's prototype instead of copying a field (#382). */
const PROTOTYPE_KEY = '__proto__';

export interface RedactionManifestEntry {
  strategy: FieldRedactionStrategy;
  count: number;
}

export interface RedactionManifest {
  policyVersion: string;
  mode: ExportRedactionMode;
  role: ExportRole;
  /** Keyed by normalised path, e.g. `data.holders[].taxId`. */
  fields: Record<string, RedactionManifestEntry>;
  totalRedactions: number;
}

export function isExportRedactionMode(value: unknown): value is ExportRedactionMode {
  return EXPORT_REDACTION_MODES.includes(value as ExportRedactionMode);
}

export function createRedactionManifest(role: ExportRole, mode: ExportRedactionMode): RedactionManifest {
  return { policyVersion: REDACTION_POLICY_VERSION, mode, role, fields: {}, totalRedactions: 0 };
}

/** Strategy for a forbidden field (lower-cased name) under `mode`. */
export function strategyFor(fieldLower: string, mode: ExportRedactionMode): FieldRedactionStrategy {
  if (mode === 'strip' || ALWAYS_STRIP.has(fieldLower)) return 'strip';
  return PARTIAL_FIELDS.has(fieldLower) ? 'partial' : 'mask';
}

/** `123-45-6789` → `*******6789`; short or non-string values are fully masked. */
export function partialMask(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return REDACTED_PLACEHOLDER;
  const text = String(value);
  if (text.length < PARTIAL_MIN_LENGTH) return REDACTED_PLACEHOLDER;
  return '*'.repeat(text.length - PARTIAL_VISIBLE) + text.slice(-PARTIAL_VISIBLE);
}

function record(manifest: RedactionManifest | undefined, path: string, strategy: FieldRedactionStrategy): void {
  if (!manifest) return;
  const entry = (manifest.fields[path] ??= { strategy, count: 0 });
  entry.count += 1;
  manifest.totalRedactions += 1;
}

/**
 * Copy `value` with every forbidden key (case-insensitive, any depth)
 * redacted per `mode`, and `__proto__` always dropped. A forbidden key's
 * whole subtree is redacted as one value. O(n) in the number of nodes.
 */
export function redactExportValue(
  value: unknown,
  forbiddenKeys: ReadonlySet<string>,
  mode: ExportRedactionMode,
  manifest?: RedactionManifest,
  path = 'data',
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactExportValue(item, forbiddenKeys, mode, manifest, `${path}[]`));
  }
  if (value === null || typeof value !== 'object' || value instanceof Date) {
    return value;
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === PROTOTYPE_KEY) continue;
    const lower = key.toLowerCase();
    const childPath = `${path}.${key}`;
    if (!forbiddenKeys.has(lower)) {
      cleaned[key] = redactExportValue(child, forbiddenKeys, mode, manifest, childPath);
      continue;
    }
    const strategy = strategyFor(lower, mode);
    record(manifest, childPath, strategy);
    if (strategy === 'strip') continue;
    cleaned[key] = strategy === 'partial' ? partialMask(child) : REDACTED_PLACEHOLDER;
  }
  return cleaned;
}
