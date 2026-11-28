import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { ArchiveState } from '../common/lifecycle/record-lifecycle';
import { PartialFailureController } from './partial-failure.controller';
import { PartialFailureService } from './partial-failure.service';

/**
 * Authorization tests for hidden and archived records (#568).
 *
 * An archived partial failure is a hidden record: it is off the default board
 * and out of the operator queue. These tests pin who may reach the archive,
 * restore and audit paths, how the actor is attributed, and that a hidden
 * record can neither leak into a default read nor be mutated by a work action.
 */

const ADMIN = 'GADMIN';
const adminReq = (wallet: string = ADMIN) =>
  ({ user: { walletAddress: wallet } }) as unknown as AuthenticatedRequest;

const contextFor = (user?: { walletAddress?: string }) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

describe('PartialFailureController authorization (#568)', () => {
  const originalAdminKey = process.env.STELLAR_PUBLIC_KEY;

  beforeEach(() => {
    process.env.STELLAR_PUBLIC_KEY = ADMIN;
  });

  afterEach(() => {
    if (originalAdminKey === undefined) delete process.env.STELLAR_PUBLIC_KEY;
    else process.env.STELLAR_PUBLIC_KEY = originalAdminKey;
  });

  describe('route protection', () => {
    it('puts every route, including archive, restore and the audit view, behind the JWT and admin guards', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, PartialFailureController)).toEqual([
        JwtAuthGuard,
        AdminGuard,
      ]);
    });

    it('admits only the configured admin wallet', async () => {
      const guard = new AdminGuard();
      await expect(guard.canActivate(contextFor({ walletAddress: ADMIN }))).resolves.toBe(true);
    });

    it('rejects an authenticated wallet that is not the admin', async () => {
      const guard = new AdminGuard();
      await expect(guard.canActivate(contextFor({ walletAddress: 'GSOMEONEELSE' }))).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(guard.canActivate(contextFor({ walletAddress: 'GSOMEONEELSE' }))).rejects.toThrow(
        'Admin access required',
      );
    });

    it('rejects a request that carries no user at all', async () => {
      const guard = new AdminGuard();
      await expect(guard.canActivate(contextFor(undefined))).rejects.toThrow('Admin access required');
      await expect(guard.canActivate(contextFor({}))).rejects.toThrow('Admin access required');
    });

    it('compares the wallet exactly, so a case or whitespace variant is not the admin', async () => {
      const guard = new AdminGuard();
      for (const variant of [ADMIN.toLowerCase(), ` ${ADMIN}`, `${ADMIN} `, `${ADMIN}\n`]) {
        await expect(guard.canActivate(contextFor({ walletAddress: variant }))).rejects.toThrow(
          UnauthorizedException,
        );
      }
    });

    it('fails closed when no admin key is configured, even for a wallet that looks like an admin', async () => {
      delete process.env.STELLAR_PUBLIC_KEY;
      const guard = new AdminGuard();
      await expect(guard.canActivate(contextFor({ walletAddress: ADMIN }))).rejects.toThrow(
        'Admin key not configured',
      );
      await expect(guard.canActivate(contextFor(undefined))).rejects.toThrow('Admin key not configured');
    });
  });

  describe('archived records', () => {
    let service: PartialFailureService;
    let controller: PartialFailureController;

    beforeEach(() => {
      service = new PartialFailureService();
      controller = new PartialFailureController(service);
    });

    const seed = (operationType = 'stellar.settlement') =>
      service.record({ operationType, message: 'settlement submitted but not confirmed', retryable: true });

    const boardRows = (query: Record<string, unknown> = {}) =>
      controller.dashboard(query as never).groups.flatMap((group) => group.failures);
    const boardIds = (query: Record<string, unknown> = {}) => boardRows(query).map((row) => row.id);

    it('takes the archiving actor from the token, never from the request body', () => {
      const failure = seed();

      const archived = controller.archive(
        failure.id,
        { reason: 'duplicate of tx_1', actor: 'GSPOOF' } as never,
        adminReq(),
      );

      expect(archived.lifecycle.state).toBe(ArchiveState.Archived);
      expect(archived.lifecycle.archivedBy).toBe(ADMIN);
      expect(archived.lifecycle.archiveReason).toBe('duplicate of tx_1');
      expect(archived.lifecycle.history).toEqual([
        expect.objectContaining({ action: 'archive', actor: ADMIN, reason: 'duplicate of tx_1' }),
      ]);
    });

    it('attributes a restore to the token and keeps the archive in the record history', () => {
      const failure = seed();
      controller.archive(failure.id, { reason: 'duplicate' }, adminReq());

      const restored = controller.restore(failure.id, adminReq());

      expect(restored.lifecycle.state).toBe(ArchiveState.Active);
      expect(restored.lifecycle.restoredBy).toBe(ADMIN);
      expect(restored.lifecycle.history.map((event) => event.action)).toEqual(['archive', 'restore']);
    });

    it('refuses to archive without a written reason, and the record stays visible', () => {
      const failure = seed();

      expect(() => controller.archive(failure.id, {}, adminReq())).toThrow(BadRequestException);
      expect(() => controller.archive(failure.id, { reason: '   ' }, adminReq())).toThrow(
        BadRequestException,
      );

      expect(service.get(failure.id).lifecycle.state).toBe(ArchiveState.Active);
      expect(boardIds()).toContain(failure.id);
    });

    it('answers 409 for a double archive and for restoring a record that is not archived', () => {
      const failure = seed();
      expect(() => controller.restore(failure.id, adminReq())).toThrow(ConflictException);

      controller.archive(failure.id, { reason: 'first' }, adminReq());
      expect(() => controller.archive(failure.id, { reason: 'second' }, adminReq())).toThrow(
        ConflictException,
      );

      // the refused second archive must not have overwritten the original attribution
      expect(service.get(failure.id).lifecycle.archiveReason).toBe('first');
      expect(service.get(failure.id).lifecycle.history).toHaveLength(1);
    });

    it('answers 404 rather than leaking existence details for an unknown id', () => {
      expect(() => controller.archive('missing', { reason: 'x' }, adminReq())).toThrow(NotFoundException);
      expect(() => controller.restore('missing', adminReq())).toThrow(NotFoundException);
      expect(() => controller.get('missing')).toThrow(NotFoundException);
    });

    it('hides an archived failure from the default board but still counts it', () => {
      const hidden = seed();
      const live = seed('webhook.delivery');
      controller.archive(hidden.id, { reason: 'duplicate' }, adminReq());

      expect(boardIds()).toEqual([live.id]);
      expect(controller.dashboard({}).archived).toBe(1);
    });

    it.each([
      ['boolean true', true],
      ['the string "true"', 'true'],
    ])('lists archived rows, with their attribution, when includeArchived is %s', (_label, value) => {
      const hidden = seed();
      controller.archive(hidden.id, { reason: 'duplicate' }, adminReq());

      const rows = boardRows({ includeArchived: value });
      const archivedRow = rows.find((row) => row.id === hidden.id);

      expect(archivedRow).toBeDefined();
      expect(archivedRow?.lifecycle.state).toBe(ArchiveState.Archived);
      expect(archivedRow?.lifecycle.archivedBy).toBe(ADMIN);
      expect(archivedRow?.lifecycle.archiveReason).toBe('duplicate');
    });

    it.each([
      ['boolean false', false],
      ['the string "false"', 'false'],
      ['the string "1"', '1'],
      ['the string "yes"', 'yes'],
      ['an empty string', ''],
      ['the string "TRUE"', 'TRUE'],
    ])('keeps archived rows hidden when includeArchived is %s', (_label, value) => {
      const hidden = seed();
      controller.archive(hidden.id, { reason: 'duplicate' }, adminReq());

      expect(boardIds({ includeArchived: value })).not.toContain(hidden.id);
    });

    it('keeps archived failures off the operator queue and out of its totals', () => {
      const hidden = seed();
      const live = seed('webhook.delivery');
      controller.archive(hidden.id, { reason: 'duplicate' }, adminReq());

      const operatorBoard = controller.unresolved({});

      expect(operatorBoard.queue.map((item) => item.id)).toEqual([live.id]);
      expect(operatorBoard.totals.unresolved).toBe(1);
    });

    it('refuses work actions on an archived failure instead of mutating a hidden record', () => {
      const failure = seed();
      controller.archive(failure.id, { reason: 'duplicate' }, adminReq());

      expect(() => controller.retry(failure.id)).toThrow(BadRequestException);
      expect(() => controller.resolve(failure.id, { note: 'done' })).toThrow(BadRequestException);

      const untouched = service.get(failure.id);
      expect(untouched.retryCount).toBe(0);
      expect(untouched.status).toBe('open');
      expect(untouched.resolvedAt).toBeUndefined();
    });

    it('lets the admin read an archived failure by id so the audit trail stays reachable', () => {
      const failure = seed();
      controller.archive(failure.id, { reason: 'duplicate of tx_1' }, adminReq());

      const audited = controller.get(failure.id);

      expect(audited.lifecycle.state).toBe(ArchiveState.Archived);
      expect(audited.lifecycle.archivedBy).toBe(ADMIN);
      expect(audited.lifecycle.archiveReason).toBe('duplicate of tx_1');
    });

    it('rolls an archive back: a restored failure rejoins the board and accepts work again', () => {
      const failure = seed();
      controller.archive(failure.id, { reason: 'archived by mistake' }, adminReq());
      expect(boardIds()).not.toContain(failure.id);

      controller.restore(failure.id, adminReq());

      expect(boardIds()).toContain(failure.id);
      expect(controller.dashboard({}).archived).toBe(0);
      const retried = controller.retry(failure.id);
      expect(retried.retryCount).toBe(1);
      expect(retried.status).toBe('retrying');
    });
  });
});
