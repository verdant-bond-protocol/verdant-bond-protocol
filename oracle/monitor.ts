import * as http from 'http';
import * as fs from 'fs';
import {
  AdapterHealth,
  HealthCheckConfig,
  runHealthChecks,
  checkAdapterHealth,
  defaultHealthChecks,
} from './health';
import {
  StalenessInput,
  StalenessResult,
  computeStaleness,
  cadenceForMethodology,
} from './staleness';
import { groupAndAssess, CrossSourceAssessment } from './anomaly';

const DEFAULT_PORT = Number(process.env.ORACLE_MONITOR_PORT || 8080);

interface StalenessRequestBody {
  projects?: Array<
    Omit<StalenessInput, 'cadenceSeconds'> & { methodology?: string }
  >;
}

interface AnomalyRequestBody {
  reports?: Array<{
    projectId: string;
    periodStart: number;
    periodEnd: number;
    sourceId: string;
    methodology?: string | null;
    carbon: number;
  }>;
}

function readStalenessFile(filePath?: string): StalenessInput[] | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : parsed.projects ?? null;
  } catch {
    return null;
  }
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
}

/**
 * Start the oracle monitor HTTP server.
 *
 * Endpoints:
 *   GET  /health                 per-adapter health check
 *   GET  /staleness              staleness from ORACLE_STALENESS_FILE (optional)
 *   POST /staleness              staleness computed from a JSON body
 */
export function startMonitorServer(
  adapters: HealthCheckConfig[] = [],
  port: number = DEFAULT_PORT,
): http.Server {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (url.pathname === '/health' && request.method === 'GET') {
      const health: AdapterHealth[] = await runHealthChecks(adapters);
      sendJson(response, 200, {
        asOf: new Date().toISOString(),
        status: health.some((entry) => entry.status === 'down') ? 'down' : 'ok',
        adapters: health,
      });
      return;
    }

    if (url.pathname === '/staleness' && request.method === 'GET') {
      const inputs = readStalenessFile(process.env.ORACLE_STALENESS_FILE);
      if (!inputs) {
        sendJson(response, 503, {
          error: 'ORACLE_STALENESS_FILE not set or unreadable',
        });
        return;
      }
      sendJson(response, 200, { asOf: new Date().toISOString(), projects: computeStaleness(inputs) });
      return;
    }

    if (url.pathname === '/staleness' && request.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(request)) as StalenessRequestBody;
        const projects = body.projects ?? (Array.isArray(body) ? body : []);
        const inputs: StalenessInput[] = projects.map((project: any) => ({
          projectId: project.projectId,
          provider: project.provider,
          lastVerifiedAt: project.lastVerifiedAt,
          createdAt: project.createdAt,
          cadenceSeconds: project.cadenceSeconds ?? cadenceForMethodology(project.methodology ?? ''),
          graceSeconds: project.graceSeconds,
        }));
        const results: StalenessResult[] = computeStaleness(inputs);
        sendJson(response, 200, { asOf: new Date().toISOString(), projects: results });
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (url.pathname === '/anomaly' && request.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(request)) as AnomalyRequestBody;
        const reports = Array.isArray(body) ? body : body.reports ?? [];
        const results: CrossSourceAssessment[] = groupAndAssess(reports);
        sendJson(response, 200, { asOf: new Date().toISOString(), anomalies: results });
        return;
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }

    sendJson(response, 404, { error: 'not found' });
  });

  server.listen(port, () => {
    console.log(`Oracle monitor listening on http://localhost:${port}`);
    console.log(`Endpoints: /health, GET /staleness, POST /staleness, POST /anomaly`);
  });

  return server;
}

/** Resolve adapters from ORACLE_ADAPTERS, falling back to defaults. */
export function resolveAdapters(): HealthCheckConfig[] {
  const configured = process.env.ORACLE_ADAPTERS;
  if (!configured) return defaultHealthChecks();
  return configured.split(',').map((adapter) => ({
    adapter,
    url: process.env[`${adapter.toUpperCase()}_URL`] || '',
  }));
}

async function main(): Promise<void> {
  const port = Number(process.env.ORACLE_MONITOR_PORT || DEFAULT_PORT);
  const adapters = resolveAdapters();

  if (adapters.length === 0) {
    console.warn('No explicit adapters configured; using default health checks.');
  }

  startMonitorServer(adapters, port);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { checkAdapterHealth, runHealthChecks, defaultHealthChecks };
