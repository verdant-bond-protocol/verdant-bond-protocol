import {
  buildSummary,
  checkConnectivity,
  checkDependencies,
  checkEnvironment,
  checkNodeVersion,
  formatSummary,
  parseEnvFile,
  REQUIRED_ENV_VARS,
} from './developer-diagnostics';

describe('developer diagnostics (#374)', () => {
  describe('checkNodeVersion', () => {
    it('passes on the minimum supported major and newer', () => {
      expect(checkNodeVersion('v18.20.0').passed).toBe(true);
      expect(checkNodeVersion('v20.11.0').passed).toBe(true);
      expect(checkNodeVersion('20.11.0').passed).toBe(true);
    });

    it('fails with actionable remediation on older runtimes', () => {
      const result = checkNodeVersion('v16.20.0');

      expect(result.passed).toBe(false);
      expect(result.remediation).toContain('v18');
    });
  });

  describe('checkDependencies', () => {
    it('guides the contributor to install when node_modules is missing', () => {
      const result = checkDependencies(false);

      expect(result.passed).toBe(false);
      expect(result.remediation).toContain('npm');
    });

    it('passes when dependencies are present', () => {
      expect(checkDependencies(true)).toEqual({ name: 'Node dependencies installed', passed: true });
    });
  });

  describe('parseEnvFile', () => {
    it('ignores comments, blanks and surrounding quotes', () => {
      const parsed = parseEnvFile(
        [
          '# a comment',
          '',
          'DATABASE_URL=postgresql://localhost:5432/verdant',
          'REDIS_URL="redis://localhost:6379"',
          "JWT_SECRET='secret'",
        ].join('\r\n'),
      );

      expect(parsed).toEqual({
        DATABASE_URL: 'postgresql://localhost:5432/verdant',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'secret',
      });
    });
  });

  describe('checkEnvironment', () => {
    it('reports a single remediation when the .env file is absent', () => {
      const results = checkEnvironment(false, '');

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].remediation).toContain('.env.example');
    });

    it('flags every missing required variable', () => {
      const results = checkEnvironment(true, 'DATABASE_URL=postgresql://localhost/db\n');

      expect(results.find((r) => r.name === 'Environment file (.env)')?.passed).toBe(true);
      expect(results.find((r) => r.name === 'Environment variable DATABASE_URL')?.passed).toBe(true);

      for (const key of REQUIRED_ENV_VARS.filter((k) => k !== 'DATABASE_URL')) {
        const result = results.find((r) => r.name === `Environment variable ${key}`);
        expect(result?.passed).toBe(false);
        expect(result?.remediation).toContain(key);
      }
    });
  });

  describe('checkConnectivity', () => {
    it('embeds the target and remediation into a failure', () => {
      const failure = checkConnectivity('PostgreSQL', false, 'postgresql://localhost', 'start it');

      expect(failure.passed).toBe(false);
      expect(failure.remediation).toContain('postgresql://localhost');
      expect(failure.remediation).toContain('start it');
    });

    it('passes without a remediation when reachable', () => {
      expect(checkConnectivity('Redis', true, 'redis://localhost', 'n/a')).toEqual({
        name: 'Redis',
        passed: true,
      });
    });
  });

  describe('summary', () => {
    it('passes only when every check passes', () => {
      const passing = buildSummary([
        { name: 'a', passed: true },
        { name: 'b', passed: true },
      ]);

      expect(passing.passed).toBe(true);
      expect(formatSummary(passing)).toContain('All checks passed.');
    });

    it('lists failures with their remediation', () => {
      const summary = buildSummary([
        { name: 'a', passed: true },
        { name: 'b', passed: false, remediation: 'fix it' },
      ]);

      expect(summary.passed).toBe(false);
      expect(summary.failures).toHaveLength(1);
      const rendered = formatSummary(summary);
      expect(rendered).toContain('[FAIL] b');
      expect(rendered).toContain('fix it');
      expect(rendered).toContain('1 check(s) failed.');
    });
  });

  it('exposes the required variable list', () => {
    expect([...REQUIRED_ENV_VARS]).toEqual(['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET']);
  });
});
