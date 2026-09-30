import { AuthorizationService } from './authorization.service';
import { AuthorizationError, AuthorizationStatus } from './authorization.interface';

const GRANTOR = 'GGRANTOR000000000000000000000000000000000000000000000';
const SUBJECT = 'GSUBJECT0000000000000000000000000000000000000000000000';
const STRANGER = 'GSTRANGER000000000000000000000000000000000000000000000';
const ONE_HOUR = 60 * 60 * 1000;

describe('AuthorizationService', () => {
  let service: AuthorizationService;
  const NOW = Date.UTC(2026, 0, 1);

  beforeEach(() => {
    service = new AuthorizationService();
  });

  it('active: a freshly granted authorization is active and allows the action', () => {
    const grant = service.grant(SUBJECT, 'covenant:report', GRANTOR, ONE_HOUR, NOW);
    expect(grant.status).toBe(AuthorizationStatus.Active);
    expect(service.isActive(grant.id, NOW)).toBe(true);
    expect(service.effectiveStatus(grant, NOW + ONE_HOUR - 1)).toBe(AuthorizationStatus.Active);
  });

  it('expired: a grant past its expiry no longer allows the action, even before cleanup runs', () => {
    const grant = service.grant(SUBJECT, 'covenant:report', GRANTOR, ONE_HOUR, NOW);
    const afterExpiry = NOW + ONE_HOUR + 1;

    expect(service.isActive(grant.id, afterExpiry)).toBe(false);
    expect(service.effectiveStatus(grant, afterExpiry)).toBe(AuthorizationStatus.Expired);
    // The stored record itself has not been touched by a read.
    expect(service.get(grant.id).status).toBe(AuthorizationStatus.Active);
  });

  it('cleaned: cleanupExpired transitions lapsed grants to Expired and reports which ones', () => {
    const grant = service.grant(SUBJECT, 'covenant:report', GRANTOR, ONE_HOUR, NOW);
    const stillActive = service.grant(SUBJECT, 'covenant:vote', GRANTOR, ONE_HOUR * 24, NOW);
    const afterExpiry = NOW + ONE_HOUR + 1;

    const report = service.cleanupExpired(afterExpiry);

    expect(report.scanned).toBe(2);
    expect(report.expiredIds).toEqual([grant.id]);
    expect(service.get(grant.id).status).toBe(AuthorizationStatus.Expired);
    expect(service.get(grant.id).audit.at(-1)).toMatchObject({ event: 'expired' });
    // A grant that has not expired yet is left alone.
    expect(service.get(stillActive.id).status).toBe(AuthorizationStatus.Active);

    // Running it again is a safe no-op for the already-cleaned grant.
    const second = service.cleanupExpired(afterExpiry + 1);
    expect(second.expiredIds).toEqual([]);
  });

  it('renewed: the grantor can renew an active grant into a fresh one with a new expiry', () => {
    const original = service.grant(SUBJECT, 'covenant:report', GRANTOR, ONE_HOUR, NOW);
    const renewed = service.renew(original.id, GRANTOR, ONE_HOUR, NOW + 1000);

    expect(renewed.id).not.toBe(original.id);
    expect(renewed.renewedFromId).toBe(original.id);
    expect(renewed.status).toBe(AuthorizationStatus.Active);
    expect(renewed.expiresAt).not.toBe(original.expiresAt);
    expect(service.get(original.id).renewedById).toBe(renewed.id);
    expect(service.get(original.id).audit.at(-1)).toMatchObject({ event: 'renewed', note: renewed.id });
  });

  it('renewed: an already-expired grant can still be renewed (that is the point of renewal)', () => {
    const original = service.grant(SUBJECT, 'covenant:report', GRANTOR, ONE_HOUR, NOW);
    const afterExpiry = NOW + ONE_HOUR + 1;

    const renewed = service.renew(original.id, GRANTOR, ONE_HOUR, afterExpiry);

    expect(renewed.status).toBe(AuthorizationStatus.Active);
    expect(service.isActive(renewed.id, afterExpiry)).toBe(true);
    // The old record is now recorded as Expired, not left reading Active.
    expect(service.get(original.id).status).toBe(AuthorizationStatus.Expired);
  });

  it('renewed: the subject may also confirm their own renewal, but a stranger may not', () => {
    const original = service.grant(SUBJECT, 'covenant:report', GRANTOR, ONE_HOUR, NOW);
    expect(() => service.renew(original.id, STRANGER, ONE_HOUR, NOW)).toThrow(AuthorizationError);
    expect(() => service.renew(original.id, STRANGER, ONE_HOUR, NOW)).toThrow(
      expect.objectContaining({ code: 'unauthorized_actor' }),
    );

    const renewed = service.renew(original.id, SUBJECT, ONE_HOUR, NOW);
    expect(renewed.grantedBy).toBe(SUBJECT);
  });

  it('renewed: a revoked grant can never be renewed', () => {
    const original = service.grant(SUBJECT, 'covenant:report', GRANTOR, ONE_HOUR, NOW);
    service.revoke(original.id, GRANTOR, NOW);
    expect(() => service.renew(original.id, GRANTOR, ONE_HOUR, NOW)).toThrow(
      expect.objectContaining({ code: 'already_revoked' }),
    );
  });

  it('revoked: the grantor can revoke an active grant, and it stops authorizing the action immediately', () => {
    const grant = service.grant(SUBJECT, 'covenant:report', GRANTOR, ONE_HOUR, NOW);
    const revoked = service.revoke(grant.id, GRANTOR, NOW + 10);

    expect(revoked.status).toBe(AuthorizationStatus.Revoked);
    expect(revoked.revokedBy).toBe(GRANTOR);
    expect(service.isActive(grant.id, NOW + 10)).toBe(false);
    // Revocation stands even well before the natural expiry.
    expect(service.effectiveStatus(revoked, NOW + 20)).toBe(AuthorizationStatus.Revoked);
  });

  it('revoked: only the original grantor may revoke, and a double revoke fails loudly', () => {
    const grant = service.grant(SUBJECT, 'covenant:report', GRANTOR, ONE_HOUR, NOW);
    expect(() => service.revoke(grant.id, SUBJECT, NOW)).toThrow(
      expect.objectContaining({ code: 'unauthorized_actor' }),
    );

    service.revoke(grant.id, GRANTOR, NOW);
    expect(() => service.revoke(grant.id, GRANTOR, NOW)).toThrow(
      expect.objectContaining({ code: 'already_revoked' }),
    );
  });

  it('throws not_found for an unknown grant id', () => {
    expect(() => service.get('missing')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  describe('listing', () => {
    it('lists only live delegations by default, so a revoked one is never mistaken for a live one', () => {
      const live = service.grant(SUBJECT, 'covenant:report', GRANTOR, ONE_HOUR * 24, NOW);
      const revoked = service.grant(SUBJECT, 'covenant:vote', GRANTOR, ONE_HOUR, NOW);
      const lapsed = service.grant(SUBJECT, 'covenant:monitor', GRANTOR, ONE_HOUR, NOW);
      service.revoke(revoked.id, GRANTOR, NOW + 10);

      const listed = service.listForSubject(SUBJECT, { now: NOW + ONE_HOUR + 1 });

      // `lapsed` has passed its expiry and `revoked` was withdrawn an hour
      // ago; neither belongs in a default listing beside a live delegation.
      expect(listed.map((g) => g.id)).toEqual([live.id]);
      expect(lapsed.id).not.toBe(live.id);
      expect(listed[0]).toMatchObject({
        effective: true,
        effectiveStatus: AuthorizationStatus.Active,
      });
    });

    it('opts into the full history, with each row still labelled by its current status', () => {
      const revoked = service.grant(SUBJECT, 'covenant:vote', GRANTOR, ONE_HOUR, NOW);
      service.revoke(revoked.id, GRANTOR, NOW + 10);

      const listed = service.listForSubject(SUBJECT, { now: NOW + 20, includeInactive: true });

      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: revoked.id,
        effective: false,
        effectiveStatus: AuthorizationStatus.Revoked,
        // The persisted status is untouched by a read.
        status: AuthorizationStatus.Revoked,
      });
    });

    it('reports a lapsed grant as expired without waiting for cleanup', () => {
      const lapsed = service.grant(SUBJECT, 'covenant:monitor', GRANTOR, ONE_HOUR, NOW);

      const [view] = service.listForSubject(SUBJECT, { now: NOW + ONE_HOUR + 1, includeInactive: true });

      expect(view.effectiveStatus).toBe(AuthorizationStatus.Expired);
      expect(view.effective).toBe(false);
      expect(service.get(lapsed.id).status).toBe(AuthorizationStatus.Active);
    });

    it('never returns another subject’s grants', () => {
      service.grant(SUBJECT, 'covenant:report', GRANTOR, ONE_HOUR, NOW);
      expect(service.listForSubject(STRANGER, { now: NOW })).toEqual([]);
    });
  });
});
