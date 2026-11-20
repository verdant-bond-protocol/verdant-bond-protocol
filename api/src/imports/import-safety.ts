import { createHash } from 'crypto';
import { stableStringify } from '../audit/audit.canonical';
import { QuarantineCode, QuarantineReason, RawImportRow } from './import.interface';

export const IMPORT_LIMITS = {
  /** Submitted payload size (CSV text or JSON-serialised rows). */
  MAX_PAYLOAD_BYTES: 2 * 1024 * 1024,
  MAX_ROWS: 5_000,
  MAX_COLUMNS: 32,
  MAX_FIELD_LENGTH: 512,
} as const;

/** Thrown for payload-level problems: the whole import is refused, nothing is staged. */
export class ImportPayloadError extends Error {}

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Leading characters that make spreadsheet software evaluate a cell
 * (OWASP "CSV injection"). A plain signed number such as "-5" is data, not a
 * formula, so it is allowed through.
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const SIGNED_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/**
 * C0/C1 controls, DEL, zero-width characters and bidi overrides. The latter
 * can make an address or reference render differently from its bytes
 * ("Trojan Source"), which defeats human review of the preview.
 */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function fingerprintRow(row: unknown): string {
  return sha256(stableStringify(row));
}

/**
 * Schema-independent checks every row goes through before a sink sees it.
 * Returns every problem rather than the first, so one preview tells the
 * operator everything that needs fixing.
 */
export function checkRowSafety(row: RawImportRow, allowedFields: readonly string[]): QuarantineReason[] {
  const reasons: QuarantineReason[] = [];
  const allowed = new Set(allowedFields);

  for (const key of Object.keys(row)) {
    if (FORBIDDEN_KEYS.has(key)) {
      reasons.push({ code: QuarantineCode.FORBIDDEN_KEY, field: key, message: 'reserved object key is not allowed' });
      continue;
    }
    if (!allowed.has(key)) {
      reasons.push({ code: QuarantineCode.UNKNOWN_FIELD, field: key, message: 'column is not part of the import schema' });
      continue;
    }

    const value = row[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        reasons.push({ code: QuarantineCode.INVALID_VALUE, field: key, message: 'number must be finite' });
      }
      continue;
    }
    if (typeof value !== 'string') {
      reasons.push({ code: QuarantineCode.INVALID_TYPE, field: key, message: `expected a string or number, got ${Array.isArray(value) ? 'array' : typeof value}` });
      continue;
    }
    if (value.length > IMPORT_LIMITS.MAX_FIELD_LENGTH) {
      reasons.push({ code: QuarantineCode.FIELD_TOO_LONG, field: key, message: `value exceeds ${IMPORT_LIMITS.MAX_FIELD_LENGTH} characters` });
      continue;
    }
    if (UNSAFE_CHARS.test(value)) {
      reasons.push({ code: QuarantineCode.UNSAFE_CHARACTERS, field: key, message: 'value contains control, zero-width or bidi-override characters' });
      continue;
    }
    if (FORMULA_PREFIX.test(value) && !SIGNED_NUMBER.test(value)) {
      reasons.push({ code: QuarantineCode.FORMULA_INJECTION, field: key, message: 'value starts with a spreadsheet formula character' });
    }
  }
  return reasons;
}

export interface ParsedCsvRow {
  line: number;
  row: RawImportRow | null;
  error: string | null;
}

/**
 * Minimal RFC 4180 parser: quoted fields, escaped quotes ("") and CRLF/LF
 * line endings. Header row is required. A data row whose column count does
 * not match the header is returned with `error` set (and quarantined), never
 * re-aligned: a shifted column would silently write a value into the wrong
 * field.
 *
 * Header problems (duplicates, forbidden names, too many columns) throw
 * ImportPayloadError because no row of such a file can be trusted.
 */
export function parseCsv(text: string): ParsedCsvRow[] {
  if (Buffer.byteLength(text, 'utf8') > IMPORT_LIMITS.MAX_PAYLOAD_BYTES) {
    throw new ImportPayloadError(`CSV exceeds ${IMPORT_LIMITS.MAX_PAYLOAD_BYTES} bytes`);
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = splitRecords(body);
  if (records.length === 0) throw new ImportPayloadError('CSV is empty');

  const header = records[0].fields.map((h) => h.trim());
  if (header.length > IMPORT_LIMITS.MAX_COLUMNS) {
    throw new ImportPayloadError(`CSV has more than ${IMPORT_LIMITS.MAX_COLUMNS} columns`);
  }
  const seen = new Set<string>();
  for (const name of header) {
    if (!name) throw new ImportPayloadError('CSV header has an empty column name');
    if (FORBIDDEN_KEYS.has(name)) throw new ImportPayloadError(`CSV header uses reserved name "${name}"`);
    if (seen.has(name)) throw new ImportPayloadError(`CSV header repeats column "${name}"`);
    seen.add(name);
  }

  const dataRecords = records.slice(1).filter((r) => !(r.fields.length === 1 && r.fields[0] === ''));
  if (dataRecords.length > IMPORT_LIMITS.MAX_ROWS) {
    throw new ImportPayloadError(`CSV has more than ${IMPORT_LIMITS.MAX_ROWS} data rows`);
  }

  return dataRecords.map((record) => {
    if (record.fields.length !== header.length) {
      return {
        line: record.line,
        row: null,
        error: `expected ${header.length} columns, found ${record.fields.length}`,
      };
    }
    // Null-prototype object: a header can never reach Object.prototype.
    const row: RawImportRow = Object.create(null);
    header.forEach((name, i) => {
      const cell = record.fields[i];
      row[name] = cell === '' ? null : cell;
    });
    return { line: record.line, row: { ...row }, error: null };
  });
}

interface CsvRecord {
  line: number;
  fields: string[];
}

function splitRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;

  const endRecord = () => {
    fields.push(field);
    records.push({ line: recordLine, fields });
    fields = [];
    field = '';
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (ch === '\n') line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      fields.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      endRecord();
      i += 2;
      line++;
      recordLine = line;
      continue;
    }
    if (ch === '\n') {
      endRecord();
      i++;
      line++;
      recordLine = line;
      continue;
    }
    field += ch;
    i++;
  }

  if (inQuotes) {
    // Every row boundary after this point is unknowable, so no row can be trusted.
    throw new ImportPayloadError(`CSV has an unterminated quoted field starting on line ${recordLine}`);
  }
  if (field !== '' || fields.length > 0) {
    endRecord();
  }
  return records;
}
