/**
 * Pure, dependency-free building blocks for the contributor diagnostics
 * command (#374).
 *
 * `npm run diagnostics` (see `api/scripts/diagnostics.ts`) gathers real
 * environment facts and passes them through these functions. Keeping the
 * decision logic here — with no `fs`, `net`, or process access — makes the
 * "one command validates local setup" contract unit-testable and keeps the
 * failure messages/remediation consistent.
 */

export interface DiagnosticResult {
  /** Human-readable check name shown in the report. */
  name: string;
  /** Whether the check passed. */
  passed: boolean;
  /** Actionable fix shown only when the check fails. */
  remediation?: string;
}

export interface DiagnosticsSummary {
  results: DiagnosticResult[];
  passed: boolean;
  failures: DiagnosticResult[];
}

/** Node major version the toolchain requires (matches CI: node 20). */
export const MINIMUM_NODE_MAJOR = 18;

/** Variables the API cannot boot without in a real environment. */
export const REQUIRED_ENV_VARS = ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET'] as const;

export function checkNodeVersion(
  version: string,
  minimumMajor: number = MINIMUM_NODE_MAJOR,
): DiagnosticResult {
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  const passed = Number.isFinite(major) && major >= minimumMajor;
  return {
    name: 'Node.js runtime',
    passed,
    remediation: passed
      ? undefined
      : `Detected ${version}. Install Node.js v${minimumMajor} or newer (CI uses v20).`,
  };
}

export function checkDependencies(dependenciesPresent: boolean): DiagnosticResult {
  return {
    name: 'Node dependencies installed',
    passed: dependenciesPresent,
    remediation: dependenciesPresent
      ? undefined
      : 'Run `npm ci` (or `npm install`) in the api directory.',
  };
}

/** Parses a dotenv-style file into a lookup, ignoring comments and blanks. */
export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of String(contents).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    values[key] = value;
  }
  return values;
}

export function checkEnvironment(
  envFilePresent: boolean,
  contents: string,
  required: readonly string[] = REQUIRED_ENV_VARS,
): DiagnosticResult[] {
  if (!envFilePresent) {
    return [
      {
        name: 'Environment file (.env)',
        passed: false,
        remediation: 'Copy `.env.example` to `.env` and fill in the values.',
      },
    ];
  }

  const values = parseEnvFile(contents);
  return [
    { name: 'Environment file (.env)', passed: true },
    ...required.map((key) => ({
      name: `Environment variable ${key}`,
      passed: Boolean(values[key]),
      remediation: values[key] ? undefined : `Set ${key} in the api directory's .env file.`,
    })),
  ];
}

export function checkConnectivity(
  name: string,
  ok: boolean,
  target: string,
  remediation: string,
): DiagnosticResult {
  return { name, passed: ok, remediation: ok ? undefined : `${target} — ${remediation}` };
}

export function buildSummary(results: DiagnosticResult[]): DiagnosticsSummary {
  const failures = results.filter((result) => !result.passed);
  return { results, failures, passed: failures.length === 0 };
}

/** Renders a summary as newline-delimited, emoji-light text for terminals. */
export function formatSummary(summary: DiagnosticsSummary): string {
  const lines = summary.results.map((result) =>
    result.passed
      ? `  [PASS] ${result.name}`
      : `  [FAIL] ${result.name}\n         remediation: ${result.remediation ?? 'see docs/developer-diagnostics.md'}`,
  );
  lines.push('', summary.passed ? 'All checks passed.' : `${summary.failures.length} check(s) failed.`);
  return lines.join('\n');
}
