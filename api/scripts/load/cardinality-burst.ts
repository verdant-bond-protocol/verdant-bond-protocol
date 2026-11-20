/**
 * Worst-case cardinality and burst-traffic load runner (issue #403).
 *
 * Dependency-free (Node's `http`/`https` only) so it can run anywhere the API
 * runs. It drives the plan from `src/ops/load/load-test-plan.ts` at a chosen
 * concurrency, then reports latency percentiles, error rate, and throughput,
 * exiting non-zero when a threshold is breached.
 *
 * Usage:
 *   npm run load:cardinality -- --url=http://localhost:3000 --concurrency=50 --requests=500
 *
 * Env fallbacks: TARGET_URL, LOAD_CONCURRENCY, LOAD_REQUESTS, LOAD_TIMEOUT_MS,
 * LOAD_PATH, LOAD_MAX_ERROR_RATE, LOAD_P95_MS, LOAD_P99_MS, LOAD_MIN_RPS.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import {
  buildCardinalityRequests,
  computeSummary,
  evaluateThresholds,
  LoadRequestSpec,
  LoadThresholds,
  RequestSample,
} from '../../src/ops/load/load-test-plan';

interface Config {
  targetUrl: string;
  path: string;
  concurrency: number;
  requests: number;
  timeoutMs: number;
  thresholds: LoadThresholds;
}

function argValue(argv: string[], name: string): string | undefined {
  const withEquals = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEquals) return withEquals.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  return undefined;
}

function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseConfig(argv: string[], env: NodeJS.ProcessEnv): Config {
  return {
    targetUrl: argValue(argv, 'url') ?? env.TARGET_URL ?? 'http://localhost:3000',
    path: argValue(argv, 'path') ?? env.LOAD_PATH ?? '/health',
    concurrency: Math.max(1, numberOr(argValue(argv, 'concurrency') ?? env.LOAD_CONCURRENCY, 25)),
    requests: Math.max(1, numberOr(argValue(argv, 'requests') ?? env.LOAD_REQUESTS, 200)),
    timeoutMs: Math.max(1, numberOr(argValue(argv, 'timeout') ?? env.LOAD_TIMEOUT_MS, 5000)),
    thresholds: {
      maxErrorRate: optionalNumber(argValue(argv, 'max-error-rate') ?? env.LOAD_MAX_ERROR_RATE),
      p95Ms: optionalNumber(argValue(argv, 'p95') ?? env.LOAD_P95_MS),
      p99Ms: optionalNumber(argValue(argv, 'p99') ?? env.LOAD_P99_MS),
      minRps: optionalNumber(argValue(argv, 'min-rps') ?? env.LOAD_MIN_RPS),
    },
  };
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Expand the base plan to exactly the requested number of requests. */
function buildPlan(config: Config): LoadRequestSpec[] {
  const base = buildCardinalityRequests({ path: config.path, maxRequests: config.requests });
  if (base.length === 0) {
    throw new Error('load plan is empty; check --path and plan options');
  }
  const plan: LoadRequestSpec[] = [];
  for (let i = 0; i < config.requests; i++) {
    plan.push(base[i % base.length]);
  }
  return plan;
}

async function requestOnce(target: string, spec: LoadRequestSpec, timeoutMs: number): Promise<RequestSample> {
  const url = new URL(spec.path, target);
  const lib = url.protocol === 'https:' ? https : http;

  return new Promise<RequestSample>((resolve) => {
    const start = process.hrtime.bigint();
    const finish = (status: number, ok: boolean) =>
      resolve({
        ok,
        status,
        durationMs: Number(process.hrtime.bigint() - start) / 1_000_000,
      });

    const req = lib.request(url, { method: spec.method, timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      res.on('end', () => finish(status, status >= 200 && status < 400));
      res.on('error', () => finish(status, false));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => finish(0, false));
    req.end();
  });
}

async function runPool(plan: LoadRequestSpec[], config: Config): Promise<RequestSample[]> {
  const samples: RequestSample[] = [];
  let cursor = 0;
  const workerCount = Math.min(config.concurrency, plan.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= plan.length) return;
      samples.push(await requestOnce(config.targetUrl, plan[index], config.timeoutMs));
    }
  });
  await Promise.all(workers);
  return samples;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'cardinality-burst load runner\n' +
        '  --url=<base url> --path=<path> --concurrency=<n> --requests=<n> --timeout=<ms>\n' +
        '  --max-error-rate=<0..1> --p95=<ms> --p99=<ms> --min-rps=<n>',
    );
    return;
  }

  const config = parseConfig(argv, process.env);
  const plan = buildPlan(config);
  console.log(
    `running ${plan.length} requests against ${config.targetUrl}${config.path} at concurrency ${config.concurrency}`,
  );

  const startedAt = Date.now();
  const samples = await runPool(plan, config);
  const elapsedMs = Date.now() - startedAt;

  const summary = computeSummary(samples, elapsedMs);
  const threshold = evaluateThresholds(summary, config.thresholds);

  console.log('── load summary ───────────────────────────────');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`thresholds: ${threshold.passed ? 'PASS' : 'FAIL'}${threshold.breaches.length ? ` -> ${threshold.breaches.join('; ')}` : ''}`);

  process.exitCode = threshold.passed ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
