import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditRecord } from './interfaces/audit.interface';

export const AUDIT_CHAIN_RESET_IGNORED = 'audit-chain-reset-ignored';

/**
 * Canonical JSON: object keys sorted recursively so two serialisations of one
 * record hash identically regardless of key insertion order. Arrays keep their
 * order (an array of values is order-meaningful), which is why `AuditRecord`
 * is intentionally flat.
 */
export function canonicalize(value: any): any {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  const sorted: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalize(value[key]);
  }
  return sorted;
}

/**
 * Stable JSON string used both for hashing and for error messages.
 */
export function stableStringify(value: any): string {
  return JSON.stringify(canonicalize(value));
}
