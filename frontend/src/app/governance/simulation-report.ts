export type SimulationOutcome = { status: 'success'; value: string } | { status: 'failure'; error: string };
export interface SimulationDiff {
  label: string;
  explanation: string;
  category: 'fees' | 'covenants' | 'oracle_config';
  unit: string;
  before: SimulationOutcome;
  after: SimulationOutcome;
  changed: boolean;
}
export interface SimulationReport {
  version: 1;
  proposal_id: string;
  ledger_sequence: number;
  ledger_timestamp: number;
  snapshot_sha256: string;
  network_passphrase: string;
  authorization: string;
  proposal: { contract: string; method: string; args: unknown[] };
  proposal_result: SimulationOutcome;
  diffs: SimulationDiff[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 100_000;
const outcome = (value: unknown): value is SimulationOutcome => object(value) &&
  ((value['status'] === 'success' && text(value['value'])) || (value['status'] === 'failure' && text(value['error'])));

/** Reports are untrusted local files; render text only and reject malformed schemas. */
export function parseSimulationReport(content: string): SimulationReport {
  const value: unknown = JSON.parse(content);
  if (!object(value) || value['version'] !== 1 || !text(value['proposal_id']) ||
      !Number.isSafeInteger(value['ledger_sequence']) || Number(value['ledger_sequence']) < 0 ||
      !Number.isSafeInteger(value['ledger_timestamp']) || Number(value['ledger_timestamp']) < 0 ||
      !text(value['snapshot_sha256']) || !/^[a-f0-9]{64}$/.test(value['snapshot_sha256']) ||
      !text(value['network_passphrase']) || !text(value['authorization']) ||
      !object(value['proposal']) || !text(value['proposal']['contract']) || !text(value['proposal']['method']) ||
      !Array.isArray(value['proposal']['args']) || !outcome(value['proposal_result']) ||
      !Array.isArray(value['diffs']) || value['diffs'].length === 0 || value['diffs'].length > 100 ||
      !value['diffs'].every(diff => object(diff) && text(diff['label']) && text(diff['explanation']) &&
        ['fees', 'covenants', 'oracle_config'].includes(String(diff['category'])) && text(diff['unit']) &&
        outcome(diff['before']) && outcome(diff['after']) && typeof diff['changed'] === 'boolean' &&
        diff['changed'] === (JSON.stringify(diff['before']) !== JSON.stringify(diff['after'])))) {
    throw new Error('This file is not a supported governance simulation report.');
  }
  return value as unknown as SimulationReport;
}

export function outcomeText(value: SimulationOutcome): string {
  return value.status === 'success' ? value.value : `Could not execute: ${value.error}`;
}
