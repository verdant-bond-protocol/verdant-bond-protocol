import { buildSummary, formatSummary } from './developer-diagnostics';
import {
  classifySetupError,
  connectivityResultFromProbe,
  probeWithRetry,
  redactConnectionString,
  redactSecrets,
} from './setup-failure-diagnostics';

function errorWith(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('setup failure diagnostics (#513)', () => {
  describe('classifySetupError', () => {
    it('classifies a refused connection as retryable with a start command', () => {
      const diagnosis = classifySetupError('redis', errorWith('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:6379'));

      expect(diagnosis.category).toBe('connection-refused');
      expect(diagnosis.retryable).toBe(true);
      expect(diagnosis.remediation).toContain('docker compose up -d redis');
      expect(diagnosis.remediation).toContain('REDIS_URL');
    });

    it('unwraps AggregateError from dual-stack connects', () => {
      const aggregate = Object.assign(new Error(''), {
        code: '',
        errors: [errorWith('ECONNREFUSED'), errorWith('ECONNREFUSED')],
      });

      expect(classifySetupError('postgres', aggregate).category).toBe('connection-refused');
    });

    it.each([
      ['ETIMEDOUT', 'connect ETIMEDOUT'],
      ['', 'Connection terminated due to connection timeout'],
      ['57P03', 'the database system is starting up'],
    ])('treats %s / "%s" as a retryable timeout', (code, message) => {
      const diagnosis = classifySetupError('postgres', errorWith(code, message));

      expect(diagnosis.category).toBe('timeout');
      expect(diagnosis.retryable).toBe(true);
    });

    it('separates transient DNS (EAI_AGAIN) from a wrong hostname (ENOTFOUND)', () => {
      expect(classifySetupError('postgres', errorWith('EAI_AGAIN'))).toMatchObject({ category: 'dns', retryable: true });
      const wrongHost = classifySetupError('postgres', errorWith('ENOTFOUND', 'getaddrinfo ENOTFOUND postgres'));
      expect(wrongHost).toMatchObject({ category: 'dns', retryable: false });
      expect(wrongHost.remediation).toContain('localhost');
    });

    describe('authorization paths', () => {
      it.each([
        ['postgres', errorWith('28P01', 'password authentication failed for user "postgres"')],
        ['postgres', errorWith('28000', 'no pg_hba.conf entry')],
        ['redis', new Error('NOAUTH Authentication required.')],
        ['redis', new Error('WRONGPASS invalid username-password pair or user is disabled.')],
      ] as const)('%s bad credentials are authentication failures and never retried', (service, error) => {
        const diagnosis = classifySetupError(service, error);

        expect(diagnosis.category).toBe('authentication');
        expect(diagnosis.retryable).toBe(false);
      });

      it('distinguishes missing privileges from bad credentials', () => {
        const pg = classifySetupError('postgres', errorWith('42501', 'permission denied for schema public'));
        const redis = classifySetupError('redis', new Error("NOPERM this user has no permissions to run the 'ping' command"));

        expect(pg).toMatchObject({ category: 'authorization', retryable: false });
        expect(pg.remediation).toContain('OWNER');
        expect(redis).toMatchObject({ category: 'authorization', retryable: false });
        expect(redis.remediation).toContain('ACL');
      });
    });

    it('reports a missing database with a create command', () => {
      const diagnosis = classifySetupError('postgres', errorWith('3D000', 'database "verdant" does not exist'));

      expect(diagnosis).toMatchObject({ category: 'missing-database', retryable: false });
      expect(diagnosis.remediation).toContain('createdb');
    });

    it('reports a missing module and a port clash', () => {
      expect(classifySetupError('redis', errorWith('MODULE_NOT_FOUND', "Cannot find module 'pg'")).category).toBe(
        'missing-dependency',
      );
      expect(classifySetupError('redis', errorWith('EADDRINUSE')).category).toBe('port-in-use');
    });

    it('falls back to unknown without leaking credentials from the raw message', () => {
      const diagnosis = classifySetupError('postgres', new Error('boom at postgresql://admin:hunter2@db:5432/verdant'));

      expect(diagnosis.category).toBe('unknown');
      expect(diagnosis.summary).not.toContain('hunter2');
      expect(diagnosis.summary).toContain('admin:***@');
    });

    it('handles non-Error throwables', () => {
      expect(classifySetupError('redis', undefined).category).toBe('unknown');
      expect(classifySetupError('redis', 'ECONNREFUSED').category).toBe('connection-refused');
    });
  });

  describe('probeWithRetry', () => {
    it('returns on the first success without sleeping (normal path)', async () => {
      const sleep = jest.fn().mockResolvedValue(undefined);

      const outcome = await probeWithRetry('redis', async () => undefined, { sleep });

      expect(outcome).toEqual({ ok: true, attempts: 1 });
      expect(sleep).not.toHaveBeenCalled();
    });

    it('retries transient failures with doubling backoff and recovers', async () => {
      const sleep = jest.fn().mockResolvedValue(undefined);
      const probe = jest
        .fn()
        .mockRejectedValueOnce(errorWith('ECONNREFUSED'))
        .mockRejectedValueOnce(errorWith('ETIMEDOUT'))
        .mockResolvedValueOnce(undefined);

      const outcome = await probeWithRetry('postgres', probe, { attempts: 3, baseDelayMs: 100, sleep });

      expect(outcome).toEqual({ ok: true, attempts: 3 });
      expect(sleep.mock.calls).toEqual([[100], [200]]);
    });

    it('gives up after the attempt budget with the last diagnosis', async () => {
      const sleep = jest.fn().mockResolvedValue(undefined);
      const probe = jest.fn().mockRejectedValue(errorWith('ECONNREFUSED'));

      const outcome = await probeWithRetry('redis', probe, { attempts: 2, baseDelayMs: 1, sleep });

      expect(outcome.ok).toBe(false);
      expect(outcome.attempts).toBe(2);
      expect(outcome.diagnosis?.category).toBe('connection-refused');
      expect(probe).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('does not retry authentication failures', async () => {
      const sleep = jest.fn().mockResolvedValue(undefined);
      const probe = jest.fn().mockRejectedValue(errorWith('28P01', 'password authentication failed'));

      const outcome = await probeWithRetry('postgres', probe, { attempts: 5, sleep });

      expect(outcome).toMatchObject({ ok: false, attempts: 1, diagnosis: { category: 'authentication' } });
      expect(sleep).not.toHaveBeenCalled();
    });

    it('clamps nonsensical attempt counts', async () => {
      const probe = jest.fn().mockRejectedValue(errorWith('ECONNREFUSED'));
      const sleep = jest.fn().mockResolvedValue(undefined);

      expect((await probeWithRetry('redis', probe, { attempts: 0, sleep })).attempts).toBe(1);
      probe.mockClear();
      expect((await probeWithRetry('redis', probe, { attempts: 1000, baseDelayMs: 0, sleep })).attempts).toBe(10);
    });
  });

  describe('redaction', () => {
    it('masks only the password of a connection URL', () => {
      expect(redactConnectionString('postgresql://postgres:s3cret@localhost:5432/verdant')).toBe(
        'postgresql://postgres:***@localhost:5432/verdant',
      );
      expect(redactConnectionString('redis://localhost:6379')).toBe('redis://localhost:6379');
    });

    it('redacts unparseable connection strings wholesale', () => {
      expect(redactConnectionString('not a url with s3cret')).not.toContain('s3cret');
    });

    it('masks credentials embedded in free text', () => {
      expect(redactSecrets('failed redis://default:pa55@cache:6379 and postgres://u:p@h/db')).toBe(
        'failed redis://default:***@cache:6379 and postgres://u:***@h/db',
      );
    });
  });

  describe('connectivityResultFromProbe', () => {
    it('produces a passing row on success', () => {
      expect(connectivityResultFromProbe('Redis connectivity', 'redis://localhost:6379', { ok: true, attempts: 1 })).toEqual({
        name: 'Redis connectivity',
        passed: true,
      });
    });

    it('produces a redacted, categorised failure row that formatSummary can render', () => {
      const row = connectivityResultFromProbe('PostgreSQL connectivity', 'postgresql://postgres:s3cret@localhost/verdant', {
        ok: false,
        attempts: 3,
        diagnosis: classifySetupError('postgres', errorWith('ECONNREFUSED')),
      });

      expect(row.passed).toBe(false);
      expect(row.category).toBe('connection-refused');
      expect(row.remediation).toContain('after 3 attempts');
      expect(row.remediation).not.toContain('s3cret');

      const output = formatSummary(buildSummary([row]));
      expect(output).toContain('[FAIL] PostgreSQL connectivity');
      expect(output).not.toContain('s3cret');
    });
  });
});
