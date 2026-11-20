/**
 * End-to-end verification of the degraded-workflow resilience slice.
 *
 * The probe controller exposes the real services over HTTP (the same pattern
 * as app.e2e-spec.ts) so supertest exercises serialization, status codes and
 * the full inject -> detect -> report -> recover journey, not just methods.
 */

import { Test } from '@nestjs/testing';
import {
  Body,
  Controller,
  Get,
  INestApplication,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import * as request from 'supertest';
import { WorkflowResilienceService } from '../src/resilience/workflow-resilience.service';
import { ExecuteWorkflowRequest, RoleMap, WorkflowComponent } from '../src/resilience/resilience.interface';
import { PayoutRedemptionFailureInjectionService } from '../src/failures/payout-redemption-failure-injection.service';
import { CreateInjectionRuleDto } from '../src/failures/failure-injection.interface';
import { PartialFailureService } from '../src/failures/partial-failure.service';
import { PermissionDiffService } from '../src/auth/permission-diff.service';
import { StatusService } from '../src/status/status.service';
import { RedisService } from '../src/common/services/redis.service';
import { OracleIncidentRepository } from '../src/oracle/oracle-incident.repository';

const ADMIN = 'GADMIN000000000000000000000000000000000000000000000000';

@Controller('resilience')
class ResilienceProbeController {
  constructor(
    private readonly resilience: WorkflowResilienceService,
    private readonly injection: PayoutRedemptionFailureInjectionService,
    private readonly failures: PartialFailureService,
    private readonly status: StatusService,
  ) {}

  @Post('workflows/execute')
  execute(@Body() body: ExecuteWorkflowRequest) {
    return this.resilience.execute(body);
  }

  @Post('injections')
  arm(@Body() body: CreateInjectionRuleDto) {
    return this.injection.registerRule(body, ADMIN);
  }

  @Post('permissions/apply')
  applyPermissions(@Body() body: { before: RoleMap; after: RoleMap }) {
    return this.resilience.applyPermissionChange(body.before, body.after, ADMIN);
  }

  @Post('permissions/reset')
  resetPermissions() {
    this.resilience.resetPermissions();
    return { reset: true };
  }

  @Post('recover/:component')
  recover(@Param('component') component: WorkflowComponent, @Body() body: { actor: string }) {
    return this.resilience.recover(component, body.actor);
  }

  @Get('status')
  userStatus(@Query('now') now?: string) {
    return this.resilience.getUserFacingStatus(now === undefined ? undefined : Number(now));
  }

  @Get('failures')
  failuresDashboard(@Query('includeArchived') includeArchived?: string) {
    return this.failures.dashboard({ filter: { includeArchived: includeArchived === 'true' } });
  }

  @Post('failures/:id/archive')
  archive(@Param('id') id: string, @Body() body: { reason: string }) {
    return this.failures.archive(id, ADMIN, body.reason);
  }

  @Post('failures/:id/restore')
  restore(@Param('id') id: string) {
    return this.failures.restore(id, ADMIN);
  }

  @Post('pause')
  pause() {
    this.status.pauseProtocol('planned incident', ADMIN);
    return { paused: true };
  }

  @Post('resume')
  resume() {
    this.status.resumeProtocol(ADMIN);
    return { paused: false };
  }
}

function payout(overrides: Partial<ExecuteWorkflowRequest> = {}): ExecuteWorkflowRequest {
  return {
    workflow: 'PAYOUT',
    bondId: 1,
    amount: '10000',
    counterPartyAddress: 'GAINVESTOR1',
    actorRole: 'issuer',
    actorAddress: ADMIN,
    now: Date.parse('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

function redemption(overrides: Partial<ExecuteWorkflowRequest> = {}): ExecuteWorkflowRequest {
  return {
    workflow: 'REDEMPTION',
    bondId: 1,
    amount: '100',
    counterPartyAddress: 'GAINVESTOR1',
    actorRole: 'investor',
    actorAddress: ADMIN,
    now: Date.parse('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('Degraded workflow resilience (e2e)', () => {
  let app: INestApplication;
  let injection: PayoutRedemptionFailureInjectionService;
  let failures: PartialFailureService;
  let status: StatusService;
  let resilience: WorkflowResilienceService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ResilienceProbeController],
      providers: [
        WorkflowResilienceService,
        PayoutRedemptionFailureInjectionService,
        PartialFailureService,
        PermissionDiffService,
        StatusService,
        { provide: RedisService, useValue: { isHealthy: () => true } },
        { provide: OracleIncidentRepository, useValue: { findMany: async () => ({ data: [], meta: {} }) } },
      ],
    }).compile();

    injection = moduleRef.get(PayoutRedemptionFailureInjectionService);
    failures = moduleRef.get(PartialFailureService);
    status = moduleRef.get(StatusService);
    resilience = moduleRef.get(WorkflowResilienceService);

    app = moduleRef.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    injection.resetMockState();
    failures.clear();
    status.resumeProtocol(ADMIN);
    status.clearComponentOverride('settlement');
    status.clearComponentOverride('redemption');
    resilience.resetPermissions();
  });

  afterAll(async () => {
    await app.close();
  });

  it('normal path: payout executes and the public status is healthy', async () => {
    const response = await request(app.getHttpServer())
      .post('/resilience/workflows/execute')
      .send(payout())
      .expect(201);

    expect(response.body.simulation.injected).toBe(false);
    expect(response.body.recoveryAction).toBe('NONE');
    expect(response.body.userStatus.overallStatus).toBe('healthy');
    expect(response.body.userStatus.report.schemaVersion).toBe(1);
  });

  it('failure + retry: an injected timeout is auto-recovered end to end', async () => {
    await request(app.getHttpServer())
      .post('/resilience/injections')
      .send({
        flowType: 'PAYOUT',
        failureMode: 'TRANSIENT_RPC_TIMEOUT',
        description: 'drill: transient timeout',
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/resilience/workflows/execute')
      .send(payout({ idempotencyKey: 'e2e_timeout_1' }))
      .expect(201);

    expect(response.body.simulation.injected).toBe(true);
    expect(response.body.simulation.attempts).toBe(2);
    expect(response.body.recoveryAction).toBe('AUTO_RETRY');
    expect(response.body.userStatus.overallStatus).toBe('healthy');
  });

  it('authorization path: an investor cannot drive a payout', async () => {
    await request(app.getHttpServer())
      .post('/resilience/workflows/execute')
      .send(payout({ actorRole: 'investor' }))
      .expect(403);
  });

  it('degraded path: a hard failure is reported publicly and recovered explicitly', async () => {
    await request(app.getHttpServer())
      .post('/resilience/injections')
      .send({
        flowType: 'REDEMPTION',
        failureMode: 'UNDERFUNDED_REDEMPTION_POOL',
        description: 'drill: underfunded pool',
      })
      .expect(201);

    const failed = await request(app.getHttpServer())
      .post('/resilience/workflows/execute')
      .send(redemption())
      .expect(201);

    expect(failed.body.recovered).toBe(false);
    expect(failed.body.userStatus.overallStatus).toBe('degraded');
    expect(failed.body.userStatus.degraded).toEqual([
      expect.objectContaining({ component: 'redemption', mutationAllowed: false }),
    ]);
    expect(failed.body.userStatus.report.components.find((c: { name: string }) => c.name === 'redemption'))
      .toMatchObject({ status: 'degraded' });

    const publicStatus = await request(app.getHttpServer())
      .get('/resilience/status')
      .expect(200);
    expect(publicStatus.body.overallStatus).toBe('degraded');

    const dashboard = await request(app.getHttpServer()).get('/resilience/failures').expect(200);
    expect(dashboard.body.unresolved).toBe(1);

    const recovered = await request(app.getHttpServer())
      .post('/resilience/recover/redemption')
      .send({ actor: ADMIN })
      .expect(201);
    expect(recovered.body.overallStatus).toBe('healthy');

    const after = await request(app.getHttpServer()).get('/resilience/failures').expect(200);
    expect(after.body.unresolved).toBe(0);
    expect(after.body.groups[0].failures[0].status).toBe('resolved');
  });

  it('hidden records: archiving removes a failure from the board but keeps it auditable', async () => {
    await request(app.getHttpServer())
      .post('/resilience/injections')
      .send({
        flowType: 'REDEMPTION',
        failureMode: 'UNDERFUNDED_REDEMPTION_POOL',
        description: 'drill: hidden record',
      })
      .expect(201);

    const failed = await request(app.getHttpServer())
      .post('/resilience/workflows/execute')
      .send(redemption())
      .expect(201);
    const id = failed.body.recordedFailureId;

    await request(app.getHttpServer())
      .post(`/resilience/failures/${id}/archive`)
      .send({ reason: 'duplicate of an existing incident' })
      .expect(201);

    const visible = await request(app.getHttpServer()).get('/resilience/failures').expect(200);
    expect(visible.body.unresolved).toBe(0);
    // The board keeps the operation-type group with its archived tally, but
    // renders no live row for a hidden record.
    expect(visible.body.archived).toBe(1);
    expect(visible.body.groups.every((g: { failures: unknown[] }) => g.failures.length === 0)).toBe(true);

    const archived = await request(app.getHttpServer())
      .get('/resilience/failures?includeArchived=true')
      .expect(200);
    expect(archived.body.groups[0].failures[0].lifecycle.archivedBy).toBe(ADMIN);

    await request(app.getHttpServer())
      .post(`/resilience/failures/${id}/restore`)
      .send()
      .expect(201);
    const restored = await request(app.getHttpServer()).get('/resilience/failures').expect(200);
    expect(restored.body.unresolved).toBe(1);
  });

  it('permission change: removing a workflow permission blocks it until rolled back', async () => {
    const report = await request(app.getHttpServer())
      .post('/resilience/permissions/apply')
      .send({
        before: { ISSUER: ['bond:create', 'bond:distribute-coupon'] },
        after: { ISSUER: ['bond:create'] },
      })
      .expect(201);
    expect(report.body.summary).toMatchObject({ permissionsRemoved: 1 });

    await request(app.getHttpServer())
      .post('/resilience/workflows/execute')
      .send(payout())
      .expect(403);

    await request(app.getHttpServer()).post('/resilience/permissions/reset').send().expect(201);
    await request(app.getHttpServer())
      .post('/resilience/workflows/execute')
      .send(payout())
      .expect(201);
  });

  it('paused protocol is reported as 503 and resumes cleanly', async () => {
    await request(app.getHttpServer()).post('/resilience/pause').send().expect(201);
    await request(app.getHttpServer())
      .post('/resilience/workflows/execute')
      .send(payout())
      .expect(503);

    await request(app.getHttpServer()).post('/resilience/resume').send().expect(201);
    await request(app.getHttpServer())
      .post('/resilience/workflows/execute')
      .send(payout())
      .expect(201);
  });

  it('idempotent replay returns the original transaction without re-injecting', async () => {
    const first = await request(app.getHttpServer())
      .post('/resilience/workflows/execute')
      .send(payout({ idempotencyKey: 'e2e_replay_1' }))
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/resilience/workflows/execute')
      .send(payout({ idempotencyKey: 'e2e_replay_1' }))
      .expect(201);

    expect(second.body.simulation.recoveryMethod).toBe('IDEMPOTENT_CACHE_HIT');
    expect(second.body.simulation.transactionHash).toBe(first.body.simulation.transactionHash);
  });
});
