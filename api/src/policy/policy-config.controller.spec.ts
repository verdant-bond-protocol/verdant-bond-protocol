import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { PolicyConfigController } from './policy-config.controller';
import { PolicyConfigChangeService } from './policy-config-change.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { IntentGuard } from '../common/guards/intent.guard';
import { buildControllerApp } from '../test/controller-guard.harness';
import { autoMock, TestRole } from '../test/guard-role-mocks';

describe('PolicyConfigController authorization (#408)', () => {
  let app: INestApplication;
  const changes = autoMock(PolicyConfigChangeService);
  const body = { changeId: 'chg-1', reason: 'tighten limits', updates: { maturityWarningDays: 14 } };

  beforeAll(async () => {
    app = await buildControllerApp(PolicyConfigController, [{ provide: PolicyConfigChangeService, useValue: changes }], (nest) =>
      nest.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })),
    );
  });

  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    changes.apply.mockResolvedValue({ changeId: 'chg-1', status: 'applied', changedKeys: [], config: {}, evidence: null });
    changes.rollback.mockResolvedValue({ changeId: 'rb-1', status: 'applied', changedKeys: [], config: {}, evidence: null });
  });

  const put = (role: TestRole, payload: unknown = body) =>
    request(app.getHttpServer()).put('/admin/config/policy').set('x-test-role', role).send(payload as object);

  it.each<[TestRole, number]>([
    ['anon', 401],
    ['user', 401],
    ['verified', 401],
  ])('denies %s with %i before any change is attempted', async (role, status) => {
    await put(role).expect(status);
    await request(app.getHttpServer()).get('/admin/config/policy').set('x-test-role', role).expect(status);
    await request(app.getHttpServer())
      .post('/admin/config/policy/rollback')
      .set('x-test-role', role)
      .send({ changeId: 'rb-1', reason: 'r', targetChangeId: 'chg-1' })
      .expect(status);
    expect(changes.apply).not.toHaveBeenCalled();
    expect(changes.rollback).not.toHaveBeenCalled();
  });

  it('applies an admin change with the authenticated wallet as the recorded actor', async () => {
    await put('admin').expect(200);
    expect(changes.apply).toHaveBeenCalledWith({ ...body, actor: 'G_ADMIN_ADDRESS' });
  });

  it('ignores a client-supplied actor', async () => {
    await put('admin', { ...body, actor: 'GSOMEONEELSE' }).expect(200);
    expect(changes.apply).toHaveBeenCalledWith(expect.objectContaining({ actor: 'G_ADMIN_ADDRESS' }));
  });

  it('routes rollbacks with the authenticated actor', async () => {
    const rollback = { changeId: 'rb-1', reason: 'revert', targetChangeId: 'chg-1' };
    await request(app.getHttpServer()).post('/admin/config/policy/rollback').set('x-test-role', 'admin').send(rollback).expect(200);
    expect(changes.rollback).toHaveBeenCalledWith({ ...rollback, actor: 'G_ADMIN_ADDRESS' });
  });

  it.each([
    ['a missing reason', { changeId: 'chg-1', updates: {} }],
    ['a missing change id', { reason: 'r', updates: {} }],
    ['non-object updates', { changeId: 'chg-1', reason: 'r', updates: 'max=1' }],
    ['an oversized change id', { changeId: 'x'.repeat(129), reason: 'r', updates: {} }],
  ])('rejects %s with 400', async (_label, payload) => {
    await put('admin', payload).expect(400);
    expect(changes.apply).not.toHaveBeenCalled();
  });

  it('wires JWT and admin guards on every route and a signed intent on every mutation', () => {
    const guardsOf = (method: keyof PolicyConfigController) => [
      ...(Reflect.getMetadata('__guards__', PolicyConfigController) ?? []),
      ...(Reflect.getMetadata('__guards__', PolicyConfigController.prototype[method]) ?? []),
    ];
    expect(guardsOf('getConfiguration')).toEqual([JwtAuthGuard, AdminGuard]);
    expect(guardsOf('updateConfiguration')).toEqual([JwtAuthGuard, AdminGuard, IntentGuard]);
    expect(guardsOf('rollback')).toEqual([JwtAuthGuard, AdminGuard, IntentGuard]);
  });
});
