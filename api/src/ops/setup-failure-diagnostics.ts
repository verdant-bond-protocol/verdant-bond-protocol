/**
 * Setup failure diagnostics for contributors (#513).
 *
 * `npm run diagnostics` (#374) tells a contributor *that* Redis or Postgres is
 * unreachable. This module tells them *why*: it classifies the raw error a
 * probe produced (refused, timeout, DNS, bad credentials, missing grants,
 * missing database, missing module, port clash) into a category with a
 * targeted remediation, decides whether the failure is worth retrying, and
 * redacts credentials before anything reaches the terminal.
 *
 * Like `developer-diagnostics.ts`, everything here is pure: no `fs`, `net`,
 * or process access. Sleeping between retries is injected so specs run
 * instantly and deterministically.
 */

import { DiagnosticResult } from './developer-diagnostics';

export type SetupService = 'postgres' | 'redis';

export type SetupFailureCategory =
  | 'connection-refused'
  | 'timeout'
  | 'dns'
  | 'authentication'
  | 'authorization'
  | 'missing-database'
  | 'missing-dependency'
  | 'port-in-use'
  | 'unknown';

export interface SetupFailureDiagnosis {
  category: SetupFailureCategory;
  /** Transient failures (service still starting, flaky DNS) are retried. */
  retryable: boolean;
  /** Short reason, safe to print (never contains credentials). */
  summary: string;
  remediation: string;
}

export interface ProbeOutcome {
  ok: boolean;
  /** Number of probe attempts made, including the first. */
  attempts: number;
  /** Present when the final attempt failed. */
  diagnosis?: SetupFailureDiagnosis;
}

export interface RetryOptions {
  /** Total attempts including the first. Clamped to [1, 10]. */
  attempts?: number;
  /** First backoff delay; doubles after every retryable failure. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_PROBE_ATTEMPTS = 3;
export const DEFAULT_PROBE_BASE_DELAY_MS = 500;
const MAX_PROBE_ATTEMPTS = 10;

const START_COMMAND: Record<SetupService, string> = {
  postgres: 'docker compose up -d postgres',
  redis: 'docker compose up -d redis',
};

const URL_VARIABLE: Record<SetupService, string> = {
  postgres: 'DATABASE_URL',
  redis: 'REDIS_URL',
};

interface ErrorFacts {
  code: string;
  message: string;
}

function errorFacts(error: unknown): ErrorFacts {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown; errors?: unknown };
    // Node's happy-eyeballs connect wraps per-address failures in an
    // AggregateError whose own `code` is empty; the first inner error is the
    // one that explains the failure.
    if (!candidate.code && Array.isArray(candidate.errors) && candidate.errors.length > 0) {
      return errorFacts(candidate.errors[0]);
    }
    return {
      code: typeof candidate.code === 'string' ? candidate.code : '',
      message: typeof candidate.message === 'string' ? candidate.message : String(error),
    };
  }
  return { code: '', message: String(error ?? '') };
}

/**
 * Map a raw error from a Postgres/Redis probe to a contributor-facing
 * diagnosis. Credentials in the error message are redacted.
 */
export function classifySetupError(service: SetupService, error: unknown): SetupFailureDiagnosis {
  const { code, message } = errorFacts(error);
  const lower = message.toLowerCase();
  const urlVar = URL_VARIABLE[service];
  const safeMessage = redactSecrets(message);

  // Postgres SQLSTATEs: 28P01 invalid password, 28000 invalid authorization
  // spec. Redis: NOAUTH (password required) / WRONGPASS (bad credentials).
  if (
    code === '28P01' ||
    code === '28000' ||
    lower.includes('password authentication failed') ||
    lower.startsWith('noauth') ||
    lower.startsWith('wrongpass') ||
    lower.includes('invalid username-password')
  ) {
    return {
      category: 'authentication',
      retryable: false,
      summary: `${service} rejected the credentials`,
      remediation: `Check the user/password in ${urlVar}; they must match docker-compose.yml (or your local ${service} setup).`,
    };
  }

  // Postgres 42501 insufficient_privilege, Redis ACL NOPERM.
  if (code === '42501' || lower.startsWith('noperm') || lower.includes('permission denied')) {
    return {
      category: 'authorization',
      retryable: false,
      summary: `${service} accepted the login but the role lacks required privileges`,
      remediation:
        service === 'postgres'
          ? `Grant the role in ${urlVar} ownership of the database (e.g. \`ALTER DATABASE verdant OWNER TO <role>\`) or use the compose superuser.`
          : `Grant the Redis ACL user in ${urlVar} access to the commands the API uses (e.g. \`ACL SETUSER <user> +@all ~*\`) or use the default user.`,
    };
  }

  if (code === '3D000' || /database ".*" does not exist/.test(lower)) {
    return {
      category: 'missing-database',
      retryable: false,
      summary: 'the database named in the connection string does not exist',
      remediation: `Create it (\`createdb verdant\` or \`docker compose down -v && docker compose up -d postgres\`) or fix the database name in ${urlVar}.`,
    };
  }

  if (code === 'ECONNREFUSED' || lower.includes('econnrefused')) {
    return {
      category: 'connection-refused',
      retryable: true,
      summary: `nothing is listening at the ${service} address`,
      remediation: `Start ${service} (\`${START_COMMAND[service]}\`) or fix the host/port in ${urlVar}.`,
    };
  }

  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('the database system is starting up')
  ) {
    return {
      category: 'timeout',
      retryable: true,
      summary: `${service} did not answer in time`,
      remediation: `${service} may still be starting; wait and re-run. If it persists, check \`docker compose ps\` and any firewall/VPN between you and the host in ${urlVar}.`,
    };
  }

  // EAI_AGAIN is a transient resolver failure; ENOTFOUND is a wrong hostname.
  if (code === 'EAI_AGAIN') {
    return {
      category: 'dns',
      retryable: true,
      summary: `the ${service} hostname could not be resolved (temporary)`,
      remediation: `Check your network/DNS, then re-run. Use \`localhost\` in ${urlVar} for a local compose setup.`,
    };
  }
  if (code === 'ENOTFOUND') {
    return {
      category: 'dns',
      retryable: false,
      summary: `the ${service} hostname does not resolve`,
      remediation: `Fix the host in ${urlVar}. Compose service names (e.g. \`${service}\`) only resolve inside the compose network; use \`localhost\` from your machine.`,
    };
  }

  if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND' || lower.includes('cannot find module')) {
    return {
      category: 'missing-dependency',
      retryable: false,
      summary: 'a Node dependency required by the probe is not installed',
      remediation: 'Run `npm ci` in the api directory.',
    };
  }

  if (code === 'EADDRINUSE') {
    return {
      category: 'port-in-use',
      retryable: false,
      summary: `another process already holds the ${service} port`,
      remediation: `Stop the other process (\`lsof -i :<port>\`) or map compose to a free port and update ${urlVar}.`,
    };
  }

  return {
    category: 'unknown',
    retryable: false,
    summary: safeMessage || 'unrecognised failure',
    remediation: `Check ${urlVar} and the ${service} logs (\`docker compose logs ${service}\`); see docs/developer-diagnostics.md.`,
  };
}

/**
 * Run `probe` until it succeeds, a non-retryable failure is seen, or the
 * attempt budget is spent. Backoff doubles from `baseDelayMs`. Never throws:
 * the final failure is returned as a diagnosis.
 */
export async function probeWithRetry(
  service: SetupService,
  probe: () => Promise<void>,
  options: RetryOptions = {},
): Promise<ProbeOutcome> {
  const attempts = Math.min(Math.max(Math.floor(options.attempts ?? DEFAULT_PROBE_ATTEMPTS), 1), MAX_PROBE_ATTEMPTS);
  const baseDelayMs = Math.max(options.baseDelayMs ?? DEFAULT_PROBE_BASE_DELAY_MS, 0);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let diagnosis: SetupFailureDiagnosis | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await probe();
      return { ok: true, attempts: attempt };
    } catch (error) {
      diagnosis = classifySetupError(service, error);
      if (!diagnosis.retryable || attempt === attempts) {
        return { ok: false, attempts: attempt, diagnosis };
      }
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  // Unreachable: the loop always returns. Kept for the type checker.
  return { ok: false, attempts, diagnosis };
}

/** Mask the password component of a connection URL. Unparseable input is redacted wholesale. */
export function redactConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<unparseable connection string>';
  }
}

/** Mask `scheme://user:password@` credentials anywhere in free text. */
export function redactSecrets(text: string): string {
  return String(text).replace(/([a-z][a-z0-9+.-]*:\/\/[^:/@\s]*):[^@\s]*@/gi, '$1:***@');
}

/** Turn a probe outcome into a report row compatible with `buildSummary`. */
export function connectivityResultFromProbe(
  name: string,
  url: string,
  outcome: ProbeOutcome,
): DiagnosticResult & { category?: SetupFailureCategory } {
  if (outcome.ok) return { name, passed: true };
  const diagnosis: SetupFailureDiagnosis = outcome.diagnosis ?? {
    category: 'unknown',
    retryable: false,
    summary: 'probe failed without an error',
    remediation: 'see docs/developer-diagnostics.md',
  };
  const tries = outcome.attempts > 1 ? ` after ${outcome.attempts} attempts` : '';
  return {
    name,
    passed: false,
    category: diagnosis.category,
    remediation: `${redactConnectionString(url)} — ${diagnosis.category}${tries}: ${diagnosis.summary}. ${diagnosis.remediation}`,
  };
}
