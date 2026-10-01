import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../common/services/redis.service';
import {
  buildSeedDataset,
  walletFor,
  SeedDataset,
} from './fixtures';

export interface SeedSummary {
  wasSkipped: boolean;
  totals: {
    users: number;
    projects: number;
    bonds: number;
    orders: number;
    oracleReports: number;
    authorizations: number;
    cacheKeysWritten: number;
  };
}

const MARKER_KEY = 'seed:verdant:marker';
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

/**
 * Writes deterministic, realistic fixtures into the Redis cache that the API
 * reads for its list/detail endpoints. This gives the local frontend
 * meaningful data (dashboard, projects, bonds, marketplace, oracle) without
 * requiring deployed Soroban contracts or external providers.
 *
 * The seed is idempotent: it uses a marker key so running it repeatedly does
 * not duplicate or clobber work, and every key is written with the same values
 * each time (deterministic fixtures), so results never drift between runs.
 */
@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  constructor(private readonly redis: RedisService) {}

  onModuleInit(): void {
    if (process.env.SEED_ON_BOOT === 'true') {
      this.seed().catch((error) => this.logger.error(`Seed-on-boot failed: ${error.message}`));
    }
  }

  /** True when a previous seed run already completed successfully. */
  private async markerPresent(): Promise<boolean> {
    return (await this.redis.get(MARKER_KEY)) === 'done';
  }

  /**
   * Seed the local Redis cache. When `force` is false (default) the seed is
   * skipped if it already ran, keeping the command idempotent.
   */
  async seed(force = false): Promise<SeedSummary> {
    if (!force && (await this.markerPresent())) {
      const summary = { wasSkipped: true } as SeedSummary;
      this.logger.log('Seed already applied; use --force to reseed. Skipping.');
      return summary;
    }

    const dataset = buildSeedDataset();
    const written = await this.writeAll(dataset);

    await this.redis.set(MARKER_KEY, 'done');

    const summary: SeedSummary = {
      wasSkipped: false,
      totals: {
        users: dataset.users.length,
        projects: dataset.projects.length,
        bonds: dataset.bonds.length,
        orders: dataset.orders.length,
        oracleReports: dataset.oracleReports.length,
        authorizations: dataset.authorizations.length,
        cacheKeysWritten: written,
      },
    };

    this.logger.log(
      `Seed complete: ${summary.totals.cacheKeysWritten} cache keys written ` +
        `(${summary.totals.projects} projects, ${summary.totals.bonds} bonds, ` +
        `${summary.totals.orders} orders, ${summary.totals.oracleReports} oracle reports, ` +
        `${summary.totals.authorizations} authorization grants).`,
    );

    return summary;
  }

  async reset(): Promise<void> {
    await this.redis.delPattern('project:*');
    await this.redis.delPattern('projects:*');
    await this.redis.delPattern('bond:*');
    await this.redis.delPattern('bonds:*');
    await this.redis.delPattern('order:*');
    await this.redis.delPattern('orders:*');
    await this.redis.delPattern('reports:*');
    await this.redis.del('oracle:providers');
    await this.redis.delPattern('authorization:*');
    await this.redis.del('authorizations:seed');
    await this.redis.del(MARKER_KEY);
    this.logger.log('Seed data cleared.');
  }

  private async writeAll(dataset: SeedDataset): Promise<number> {
    let written = 0;
    const write = async (key: string, value: unknown): Promise<void> => {
      await this.redis.set(key, JSON.stringify(value));
      written++;
    };

    for (const project of dataset.projects) {
      await write(`project:${project.id}`, {
        id: project.id,
        name: project.name,
        status: project.status,
        methodology: project.methodology,
        country: project.country,
        metadataIpfsHash: project.metadataIpfsHash,
        ownerAddress: walletFor(project.ownerAddress),
        totalAreaHa: project.totalAreaHa,
        carbonSequestrationEstimate: project.carbonSequestrationEstimate,
        createdAt: new Date(project.createdAt).toISOString(),
      });
    }
    await write(`projects:${DEFAULT_PAGE}:${DEFAULT_LIMIT}`, {
      data: dataset.projects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        methodology: p.methodology,
        country: p.country,
        metadataIpfsHash: p.metadataIpfsHash,
        ownerAddress: walletFor(p.ownerAddress),
        totalAreaHa: p.totalAreaHa,
        carbonSequestrationEstimate: p.carbonSequestrationEstimate,
        createdAt: new Date(p.createdAt).toISOString(),
      })),
      meta: {
        page: DEFAULT_PAGE,
        limit: DEFAULT_LIMIT,
        total: dataset.projects.length,
        totalPages: 1,
      },
    });

    for (const bond of dataset.bonds) {
      await write(`bond:${bond.id}`, {
        id: bond.id,
        projectId: bond.projectId,
        name: bond.name,
        faceValue: bond.faceValue.toString(),
        couponSchedule: bond.couponSchedule,
        creditType: bond.creditType,
        maturityDate: new Date(bond.maturityDate).toISOString(),
        maturityStatus: bond.maturityStatus,
        totalSupply: bond.totalSupply.toString(),
        totalSubscribed: bond.totalSubscribed.toString(),
        status: bond.status,
        couponRate: bond.couponRate,
        createdAt: new Date(bond.createdAt).toISOString(),
      });
    }
    await write(`bonds:${DEFAULT_PAGE}:${DEFAULT_LIMIT}`, {
      data: dataset.bonds.map((b) => ({
        id: b.id,
        projectId: b.projectId,
        name: b.name,
        faceValue: b.faceValue.toString(),
        couponSchedule: b.couponSchedule,
        creditType: b.creditType,
        maturityDate: new Date(b.maturityDate).toISOString(),
        maturityStatus: b.maturityStatus,
        totalSupply: b.totalSupply.toString(),
        totalSubscribed: b.totalSubscribed.toString(),
        status: b.status,
        couponRate: b.couponRate,
        createdAt: new Date(b.createdAt).toISOString(),
      })),
      meta: {
        page: DEFAULT_PAGE,
        limit: DEFAULT_LIMIT,
        total: dataset.bonds.length,
        totalPages: 1,
      },
    });

    for (const order of dataset.orders) {
      await write(`order:${order.id}`, {
        id: order.id,
        seller: walletFor(order.seller),
        bondId: order.bondId,
        amount: order.amount.toString(),
        pricePerToken: order.pricePerToken.toString(),
        quoteAsset: order.quoteAsset,
        status: order.status,
        createdAt: new Date(order.createdAt).toISOString(),
      });
    }
    await write(`orders:all:all:${DEFAULT_PAGE}:${DEFAULT_LIMIT}`, {
      data: dataset.orders.map((o) => ({
        id: o.id,
        seller: walletFor(o.seller),
        bondId: o.bondId,
        amount: o.amount.toString(),
        pricePerToken: o.pricePerToken.toString(),
        quoteAsset: o.quoteAsset,
        status: o.status,
        createdAt: new Date(o.createdAt).toISOString(),
      })),
      meta: {
        page: DEFAULT_PAGE,
        limit: DEFAULT_LIMIT,
        total: dataset.orders.length,
        totalPages: 1,
      },
    });

    const reportsByProject = new Map<number, unknown[]>();
    for (const report of dataset.oracleReports) {
      const list = reportsByProject.get(report.projectId) ?? [];
      list.push(reportToResponse(report));
      reportsByProject.set(report.projectId, list);
    }
    for (const [projectId, list] of reportsByProject) {
      await write(`reports:${projectId}`, list);
    }

    // Authorization grant fixtures for issue #302's grant/expiry/renewal
    // flow — see `SeedAuthorization` in fixtures.ts for which edge case each
    // one covers (active, expired-but-uncleaned, revoked).
    const authorizations = dataset.authorizations.map((a) => ({
      id: a.id,
      subjectAddress: walletFor(a.subjectAddress),
      scope: a.scope,
      grantedBy: walletFor(a.grantedBy),
      grantedAt: new Date(a.grantedAt).toISOString(),
      expiresAt: new Date(a.expiresAt).toISOString(),
      status: a.status,
      ...(a.revokedAt ? { revokedAt: new Date(a.revokedAt).toISOString() } : {}),
      ...(a.revokedBy !== undefined ? { revokedBy: walletFor(a.revokedBy) } : {}),
    }));
    for (const authorization of authorizations) {
      await write(`authorization:${authorization.id}`, authorization);
    }
    await write('authorizations:seed', authorizations);

    await write('oracle:providers', [
      {
        providerAddress: walletFor(4),
        methodology: 'Satellite + IoT',
        name: 'GeoSat Oracle',
        active: true,
        registeredAt: new Date(BASE_REGISTERED).toISOString(),
      },
    ]);

    return written;
  }

  get markerKey(): string {
    return MARKER_KEY;
  }
}

const BASE_REGISTERED = Date.UTC(2025, 6, 1);

function reportToResponse(report: {
  id: number;
  projectId: number;
  periodStart: number;
  periodEnd: number;
  carbonSequestered: number;
  methodology: string;
  ipfsHash: string;
  providerAddress: number;
  status: string;
  createdAt: number;
  verifiedAt?: number;
}): Record<string, unknown> {
  return {
    id: report.id,
    projectId: report.projectId.toString(),
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    carbonSequestered: report.carbonSequestered.toString(),
    methodology: report.methodology,
    ipfsHash: report.ipfsHash,
    providerAddress: walletFor(report.providerAddress),
    status: report.status,
    createdAt: new Date(report.createdAt).toISOString(),
    ...(report.verifiedAt ? { verifiedAt: new Date(report.verifiedAt).toISOString() } : {}),
  };
}
