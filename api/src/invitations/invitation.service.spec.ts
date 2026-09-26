import { Test, TestingModule } from '@nestjs/testing';
import { InvitationService } from './invitation.service';
import { InvitationError } from './invitation.interface';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const SCOPE = 'bond:42';
const ISSUER = 'GISSUER';
const MANAGER = 'GMANAGER';
const INVITEE = 'GINVITEE';
const OUTSIDER = 'GOUTSIDER';
const HOUR = 60 * 60 * 1000;

describe('InvitationService (#265)', () => {
  let service: InvitationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [InvitationService],
    }).compile();
    service = module.get<InvitationService>(InvitationService);
    // Bootstrap: the scope's issuer admin seeds a project manager.
    service.grantRole(ISSUER, SCOPE, ISSUER, 'issuer_admin', NOW);
    service.grantRole(ISSUER, SCOPE, MANAGER, 'project_admin', NOW);
  });

  const invite = (overrides: Record<string, unknown> = {}, at = NOW) =>
    service.create(
      {
        scope: SCOPE,
        inviterAddress: MANAGER,
        inviteeAddress: INVITEE,
        role: 'contributor',
        ...overrides,
      } as never,
      at,
    );

  describe('creation', () => {
    it('creates a pending invitation with an expiry one week out', () => {
      const invitation = invite();

      expect(invitation.status).toBe('pending');
      expect(invitation.role).toBe('contributor');
      expect(invitation.expiresAt).toBe(new Date(NOW + 7 * 24 * HOUR).toISOString());
    });

    it('rejects inviting with a role at or above the inviter rank', () => {
      expect(() => invite({ role: 'issuer_admin' })).toThrowError(
        expect.objectContaining<InvitationError>({
          code: 'role_escalation_rejected',
        }),
      );
    });

    it('rejects creation by a wallet holding no role in the scope', () => {
      expect(() => invite({ inviterAddress: OUTSIDER })).toThrowError(
        expect.objectContaining<InvitationError>({ code: 'role_escalation_rejected' }),
      );
    });

    it('rejects inviting an address that already holds the role', () => {
      service.grantRole(MANAGER, SCOPE, INVITEE, 'contributor', NOW);

      expect(() => invite()).toThrowError(
        expect.objectContaining<InvitationError>({ code: 'already_a_collaborator' }),
      );
    });
  });

  describe('acceptance', () => {
    it('grants exactly the invited role on acceptance', () => {
      const invitation = invite();
      const accepted = service.accept(invitation.id, INVITEE, NOW + 1_000);

      expect(accepted.status).toBe('accepted');
      expect(accepted.acceptedAt).toBeDefined();
      expect(service.rankOf(INVITEE, SCOPE)).toBe(1); // contributor
    });

    it('rejects acceptance by any wallet other than the invitee', () => {
      const invitation = invite();

      expect(() => service.accept(invitation.id, OUTSIDER, NOW)).toThrowError(
        expect.objectContaining<InvitationError>({ code: 'invitation_not_pending' }),
      );
    });

    it('refuses an expired invitation and flips it to expired', () => {
      const invitation = invite({ ttlMs: HOUR });

      expect(() => service.accept(invitation.id, INVITEE, NOW + HOUR + 1)).toThrowError(
        expect.objectContaining<InvitationError>({ code: 'invitation_expired' }),
      );
      expect(service.get(invitation.id, NOW + HOUR + 1).status).toBe('expired');
      expect(service.rankOf(INVITEE, SCOPE)).toBe(-1);
    });
  });

  describe('revocation', () => {
    it('lets the inviter revoke a pending invitation', () => {
      const invitation = invite();
      const revoked = service.revoke(invitation.id, MANAGER, NOW + 1_000);

      expect(revoked.status).toBe('revoked');
      expect(() => service.accept(invitation.id, INVITEE, NOW + 2_000)).toThrowError(
        expect.objectContaining<InvitationError>({ code: 'invitation_revoked' }),
      );
      expect(service.rankOf(INVITEE, SCOPE)).toBe(-1);
    });

    it('lets a higher role revoke someone else’s invitation', () => {
      const invitation = invite();

      expect(service.revoke(invitation.id, ISSUER, NOW + 1_000).status).toBe('revoked');
    });

    it('rejects revocation by an unrelated wallet', () => {
      const invitation = invite();

      expect(() => service.revoke(invitation.id, OUTSIDER, NOW + 1_000)).toThrowError(
        expect.objectContaining<InvitationError>({ code: 'role_escalation_rejected' }),
      );
    });
  });

  describe('throttling', () => {
    it('allows five invitations per rolling hour and then throttles', () => {
      for (let i = 0; i < 5; i++) {
        invite({ inviteeAddress: `GINVITEE${i}` }, NOW + i);
      }

      expect(() => invite({ inviteeAddress: 'GINVITEE6' }, NOW + 6)).toThrowError(
        expect.objectContaining<InvitationError>({ code: 'rate_limited' }),
      );
    });

    it('frees the window once the rolling hour passes', () => {
      for (let i = 0; i < 5; i++) {
        invite({ inviteeAddress: `GINVITEE${i}` }, NOW + i);
      }

      const afterWindow = invite({ inviteeAddress: 'GINVITEEAFTER' }, NOW + HOUR + 1);
      expect(afterWindow.status).toBe('pending');
    });
  });
});
