import { Test, TestingModule } from '@nestjs/testing';
import { OpsService } from './ops.service';
import { OracleIncidentRepository } from '../oracle/oracle-incident.repository';
import { DexReconciliationService } from '../marketplace/dex.reconciliation.service';
import { HolderIndexService } from '../bonds/holder-index.service';
import { BondsService } from '../bonds/bonds.service';
import { OracleIncidentSeverity, OracleIncidentStatus } from '../oracle/interfaces/oracle-incident.interface';

describe('OpsService', () => {
  let service: OpsService;
  let oracleIncidents: any;
  let dexReconciliation: any;
  let holderIndex: any;
  let bondsService: any;
  let holderStore: any;

  beforeEach(async () => {
    oracleIncidents = {
      findMany: jest.fn(),
    };
    dexReconciliation = {
      listMismatches: jest.fn(),
    };
    holderStore = {
      getLastReconciled: jest.fn(),
    };
    holderIndex = {
      getStore: jest.fn().mockReturnValue(holderStore),
    };
    bondsService = {
      findAll: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpsService,
        { provide: OracleIncidentRepository, useValue: oracleIncidents },
        { provide: DexReconciliationService, useValue: dexReconciliation },
        { provide: HolderIndexService, useValue: holderIndex },
        { provide: BondsService, useValue: bondsService },
      ],
    }).compile();

    service = module.get<OpsService>(OpsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('aggregates healthy status correctly', async () => {
    oracleIncidents.findMany.mockResolvedValue({ data: [], meta: { total: 0 } });
    dexReconciliation.listMismatches.mockResolvedValue([]);
    bondsService.findAll.mockResolvedValue({ meta: { total: 2 } });
    holderStore.getLastReconciled.mockReturnValue(Date.now()); // recent

    const dashboard = await service.getDashboard();

    expect(dashboard.indicators.oracle.status).toBe('healthy');
    expect(dashboard.indicators.marketplace.status).toBe('healthy');
    expect(dashboard.indicators.bonds.status).toBe('healthy');
    expect(dashboard.unresolvedExceptions).toHaveLength(0);
    expect(dashboard.staleRecords).toHaveLength(0);
  });

  it('aggregates unhealthy status and incidents correctly', async () => {
    oracleIncidents.findMany.mockImplementation(async (page, limit, status) => {
      if (status === 'active') {
        return {
          data: [
            {
              id: 'inc-1',
              subjectType: 'satellite',
              subjectId: 'proj-1',
              severity: OracleIncidentSeverity.Critical,
              occurrenceCount: 3,
            }
          ],
          meta: { total: 1 }
        };
      }
      return { data: [], meta: { total: 0 } };
    });

    dexReconciliation.listMismatches.mockResolvedValue([
      { walletAddress: 'G1' }
    ]);
    
    bondsService.findAll.mockResolvedValue({ meta: { total: 1 } });
    holderStore.getLastReconciled.mockReturnValue(0); // stale (never reconciled)

    const dashboard = await service.getDashboard();

    expect(dashboard.indicators.oracle.status).toBe('unhealthy');
    expect(dashboard.indicators.marketplace.status).toBe('degraded');
    expect(dashboard.indicators.bonds.status).toBe('degraded');

    expect(dashboard.unresolvedExceptions).toHaveLength(1);
    expect(dashboard.unresolvedExceptions[0].id).toBe('inc-1');
    expect(dashboard.unresolvedExceptions[0].link).toContain('inc-1');

    // Marketplace mismatch + 1 bond stale
    expect(dashboard.staleRecords).toHaveLength(2);
    expect(dashboard.staleRecords[0].type).toBe('marketplace_reconciliation_drift');
    expect(dashboard.staleRecords[1].type).toBe('bond_holder_index_stale');
    expect(dashboard.staleRecords[1].id).toBe('1');
  });
});
