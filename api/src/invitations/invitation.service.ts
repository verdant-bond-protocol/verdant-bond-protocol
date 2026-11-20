import { Injectable, Logger } from '@nestjs/common';
import {
  CollaboratorRole,
  CreateInvitationInput,
  DEFAULT_INVITATION_TTL_MS,
  Invitation,
  InvitationError,
  INVITES_PER_WINDOW,
  INVITE_WINDOW_MS,
  ROLE_RANK,
} from './invitation.interface';

@Injectable()
export class InvitationService {
  private readonly logger = new Logger(InvitationService.name);
  private readonly invitations = new Map<string, Invitation>();
  /** address -> (scope -> highest role held). Server-side role registry. */
  private readonly roles = new Map<string, Map<string, CollaboratorRole>>();
  /** Creation timestamps per inviter for the rolling throttle window. */
  private readonly creationLog = new Map<string, number[]>();

  /**
   * Grant a collaboration role directly. The grantor must already hold a role
   * at least as powerful as the granted one in the scope — server-side role
   * escalation is rejected. The first `issuer_admin` of a scope may be seeded
   * by anyone (project creation bootstrap).
   */
  grantRole(
    actorAddress: string,
    scope: string,
    targetAddress: string,
    role: CollaboratorRole,
    now: number = Date.now(),
  ): void {
    const actorRank = this.rankOf(actorAddress, scope);
    if (actorRank >= 0 && actorRank < ROLE_RANK[role]) {
      throw new InvitationError(
        `${actorAddress} cannot grant ${role} above its own role in scope ${scope}`,
        'role_escalation_rejected',
      );
    }
    const bootstrap = actorRank < 0 && role === 'issuer_admin';
    if (actorRank < 0 && !bootstrap) {
      throw new InvitationError(
        `${actorAddress} holds no role in scope ${scope}`,
        'role_escalation_rejected',
      );
    }

    let byScope = this.roles.get(targetAddress);
    if (!byScope) {
      byScope = new Map<string, CollaboratorRole>();
      this.roles.set(targetAddress, byScope);
    }
    const existing = byScope.get(scope);
    if (existing && ROLE_RANK[existing] >= ROLE_RANK[role]) return;
    byScope.set(scope, role);
    this.logger.log(`role granted`, { scope, targetAddress, role, actorAddress, now });
  }

  /** Highest role an address holds in a scope, or -1 when none. */
  rankOf(address: string, scope: string): number {
    const role = this.roles.get(address)?.get(scope);
    return role ? ROLE_RANK[role] : -1;
  }

  /**
   * Create a pending invitation. Throttled per inviter, and the invited role
   * must be strictly below the inviter's own role in the scope.
   */
  create(input: CreateInvitationInput, now: number = Date.now()): Invitation {
    const { scope, inviterAddress, inviteeAddress, role } = input;
    if (!scope || !inviterAddress || !inviteeAddress) {
      throw new InvitationError('scope, inviter and invitee are required', 'invalid_input');
    }
    if (inviterAddress === inviteeAddress) {
      throw new InvitationError('an address cannot invite itself', 'invalid_input');
    }

    this.enforceThrottle(inviterAddress, now);

    const inviterRank = this.rankOf(inviterAddress, scope);
    if (inviterRank < ROLE_RANK[role] || inviterRank < ROLE_RANK.contributor) {
      throw new InvitationError(
        `${inviterAddress} cannot invite ${inviteeAddress} as ${role} in scope ${scope}`,
        'role_escalation_rejected',
      );
    }

    if (this.rankOf(inviteeAddress, scope) >= ROLE_RANK[role]) {
      throw new InvitationError(
        `${inviteeAddress} already holds this or a higher role in scope ${scope}`,
        'already_a_collaborator',
      );
    }

    const ttl = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : DEFAULT_INVITATION_TTL_MS;
    const invitation: Invitation = {
      id: `inv_${scope}_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      scope,
      inviterAddress,
      inviteeAddress,
      role,
      status: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
    };
    this.invitations.set(invitation.id, invitation);
    return invitation;
  }

  /**
   * Accept a pending, unexpired invitation. The granted role is the one fixed
   * on the invitation server-side — the invitee cannot claim another role.
   */
  accept(invitationId: string, callerAddress: string, now: number = Date.now()): Invitation {
    const invitation = this.getOrThrow(invitationId);

    if (invitation.inviteeAddress !== callerAddress) {
      throw new InvitationError(
        'only the invited wallet can accept this invitation',
        'invitation_not_pending',
      );
    }
    if (invitation.status === 'revoked') {
      throw new InvitationError('this invitation was revoked', 'invitation_revoked');
    }
    if (invitation.status === 'expired' || now >= Date.parse(invitation.expiresAt)) {
      invitation.status = 'expired';
      throw new InvitationError('this invitation has expired', 'invitation_expired');
    }

    invitation.status = 'accepted';
    invitation.acceptedAt = new Date(now).toISOString();
    this.grantRole(invitation.inviterAddress, invitation.scope, callerAddress, invitation.role, now);
    this.logger.log('invitation accepted', { id: invitationId, role: invitation.role });
    return invitation;
  }

  /** Revoke a pending invitation; allowed for the inviter or a higher role. */
  revoke(invitationId: string, callerAddress: string, now: number = Date.now()): Invitation {
    const invitation = this.getOrThrow(invitationId);

    const callerRank = this.rankOf(callerAddress, invitation.scope);
    const isInviter = invitation.inviterAddress === callerAddress;
    if (!isInviter && callerRank <= ROLE_RANK[invitation.role]) {
      throw new InvitationError(
        'only the inviter or a higher role can revoke this invitation',
        'role_escalation_rejected',
      );
    }
    if (invitation.status !== 'pending') {
      throw new InvitationError(
        `invitation is ${invitation.status}`,
        'invitation_not_pending',
      );
    }

    invitation.status = 'revoked';
    invitation.revokedAt = new Date(now).toISOString();
    return invitation;
  }

  /** List invitations, optionally filtered; lazily expires stale ones. */
  list(filter: { inviteeAddress?: string; scope?: string } = {}, now: number = Date.now()): Invitation[] {
    const result: Invitation[] = [];
    for (const invitation of this.invitations.values()) {
      if (invitation.status === 'pending' && now >= Date.parse(invitation.expiresAt)) {
        invitation.status = 'expired';
      }
      if (filter.inviteeAddress && invitation.inviteeAddress !== filter.inviteeAddress) continue;
      if (filter.scope && invitation.scope !== filter.scope) continue;
      result.push(invitation);
    }
    return result;
  }

  get(invitationId: string, now: number = Date.now()): Invitation {
    const invitation = this.getOrThrow(invitationId);
    if (invitation.status === 'pending' && now >= Date.parse(invitation.expiresAt)) {
      invitation.status = 'expired';
    }
    return invitation;
  }

  clear(): void {
    this.invitations.clear();
    this.roles.clear();
    this.creationLog.clear();
  }

  private getOrThrow(invitationId: string): Invitation {
    const invitation = this.invitations.get(invitationId);
    if (!invitation) {
      throw new InvitationError(`no invitation ${invitationId}`, 'invitation_not_found');
    }
    return invitation;
  }

  /** Rolling-window throttle per inviter (issue #265 abuse resistance). */
  private enforceThrottle(inviterAddress: string, now: number): void {
    const windowStart = now - INVITE_WINDOW_MS;
    const log = (this.creationLog.get(inviterAddress) ?? []).filter((ts) => ts >= windowStart);
    if (log.length >= INVITES_PER_WINDOW) {
      throw new InvitationError(
        `invitation rate limit reached (${INVITES_PER_WINDOW} per hour)`,
        'rate_limited',
      );
    }
    log.push(now);
    this.creationLog.set(inviterAddress, log);
  }
}
