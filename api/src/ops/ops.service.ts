import { Injectable, Logger } from '@nestjs/common';
import { OracleIncidentRepository } from '../oracle/oracle-incident.repository';
import { DexReconciliationService } from '../marketplace/dex.reconciliation.service';
import { HolderIndexService } from '../bonds/holder-index.service';
import { BondsService } from '../bonds/bonds.service';
import {
  OpsDashboardResponse,
  UnresolvedException,
  StaleRecord,
  HealthIndicator,
} from './interfaces/ops-dashboard.interface';
import { OracleIncidentStatus } from '../oracle/interfaces/oracle-incident.interface';

@Injectable()
export class OpsService {
  private readonly logger = new Logger(OpsService.name);

  constructor(
    private readonly oracleIncidents: OracleIncidentRepository,
    private readonly dexReconciliation: DexReconciliationService,
    private readonly holderIndex: HolderIndexService,
    private readonly bondsService: BondsService,
  ) {}

  async getDashboard(): Promise<OpsDashboardResponse> {
    const unresolvedExceptions: UnresolvedException[] = [];
    const staleRecords: StaleRecord[] = [];

    // 1. Oracle Incidents
    let oracleHealth: HealthIndicator = { status: 'healthy', description: 'No active incidents' };
    try {
      const activeIncidents = await this.oracleIncidents.findMany(1, 100, 'active' as OracleIncidentStatus);
      const acknowledgedIncidents = await this.oracleIncidents.findMany(1, 100, 'acknowledged' as OracleIncidentStatus);
      
      const allIncidents = [...activeIncidents.data, ...acknowledgedIncidents.data];
      
      if (allIncidents.length > 0) {
        oracleHealth = {
          status: activeIncidents.data.length > 0 ? 'unhealthy' : 'degraded',
          description: `${activeIncidents.data.length} active, ${acknowledgedIncidents.data.length} acknowledged incidents`,
        };
      }

      unresolvedExceptions.push(
        ...allIncidents.map((inc) => ({
          id: inc.id,
          source: `oracle/${inc.subjectType}`,
          severity: inc.severity,
          message: `Oracle incident ${inc.subjectType} ${inc.subjectId} (${inc.occurrenceCount} occurrences)`,
          link: `/admin/oracle/incidents/${inc.id}`, // Maintainer UI or API link
        })),
      );
    } catch (err) {
      this.logger.error(`Failed to fetch oracle incidents: ${err}`);
      oracleHealth = { status: 'unhealthy', description: 'Failed to fetch oracle status' };
    }

    // 2. Marketplace Reconciliation Drift
    let marketplaceHealth: HealthIndicator = { status: 'healthy', description: 'No reconciliation drift detected' };
    try {
      const marketplaceMismatches = await this.dexReconciliation.listMismatches(100);
      if (marketplaceMismatches.length > 0) {
        marketplaceHealth = {
          status: 'degraded',
          description: `${marketplaceMismatches.length} reconciliation mismatches detected`,
        };
        
        staleRecords.push(
          ...marketplaceMismatches.map((m: any) => ({
            type: 'marketplace_reconciliation_drift',
            id: m.walletAddress || m.orderId || 'unknown',
            lastUpdated: null,
            link: '/admin/marketplace/reconciliation/mismatches',
          })),
        );
      }
    } catch (err) {
      this.logger.error(`Failed to fetch marketplace mismatches: ${err}`);
      marketplaceHealth = { status: 'unhealthy', description: 'Failed to fetch marketplace status' };
    }

    // 3. Bonds Holder Index Staleness
    let bondsHealth: HealthIndicator = { status: 'healthy', description: 'Holder indexes are up to date' };
    try {
      let totalBonds = 0;
      try {
        const bondsPage = await this.bondsService.findAll(1, 1);
        totalBonds = bondsPage.meta.total;
      } catch (err) {
        // Fallback or ignore if bondsService is unavailable
        this.logger.warn(`Could not fetch total bonds, assuming 10 for staleness check`);
        totalBonds = 10; 
      }

      const store = this.holderIndex.getStore();
      const maxStalenessMs = Number(process.env.HOLDER_INDEX_MAX_STALENESS_MS ?? 3600000);
      const now = Date.now();
      
      let staleCount = 0;
      for (let i = 1; i <= totalBonds; i++) {
        const lastReconciled = store.getLastReconciled(i);
        const stale = lastReconciled === 0 || now - lastReconciled > maxStalenessMs;
        
        if (stale) {
          staleCount++;
          staleRecords.push({
            type: 'bond_holder_index_stale',
            id: String(i),
            lastUpdated: lastReconciled === 0 ? null : new Date(lastReconciled).toISOString(),
            link: `/admin/bonds/${i}/reconcile-holders`,
          });
        }
      }

      if (staleCount > 0) {
        bondsHealth = {
          status: 'degraded',
          description: `${staleCount} bond(s) have stale holder indexes`,
        };
      }
    } catch (err) {
      this.logger.error(`Failed to check bonds staleness: ${err}`);
      bondsHealth = { status: 'unhealthy', description: 'Failed to check bonds status' };
    }

    return {
      indicators: {
        oracle: oracleHealth,
        marketplace: marketplaceHealth,
        bonds: bondsHealth,
      },
      unresolvedExceptions,
      staleRecords,
    };
  }
}
