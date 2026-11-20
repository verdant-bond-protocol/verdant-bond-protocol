/**
 * Abuse-resistant invitation and collaboration workflow (issue #265).
 *
 * Model: an authenticated holder of a collaboration role invites another
 * wallet into the same scope at a role strictly below their own. Invitations
 * are pending until accepted (before expiry) or revoked; expired and revoked
 * invitations can never be accepted. The role granted at acceptance is the
 * one recorded server-side at creation — the invitee can never claim a
 * higher role, and inviting above the inviter's own role is rejected.
 * Creation is throttled per inviter to blunt spam.
 */

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export type CollaboratorRole = 'viewer' | 'contributor' | 'project_admin' | 'issuer_admin';

/** Rank used for server-side role-escalation checks (higher = more power). */
export const ROLE_RANK: Record<CollaboratorRole, number> = {
  viewer: 0,
  contributor: 1,
  project_admin: 2,
  issuer_admin: 3,
};

export interface Invitation {
  id: string;
  scope: string;
  inviterAddress: string;
  inviteeAddress: string;
  /** Role granted on acceptance — fixed server-side, never client-chosen. */
  role: CollaboratorRole;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  revokedAt?: string;
}

export interface CreateInvitationInput {
  scope: string;
  inviterAddress: string;
  inviteeAddress: string;
  role: CollaboratorRole;
  /** Custom time-to-live in ms; defaults to DEFAULT_INVITATION_TTL_MS. */
  ttlMs?: number;
}

export class InvitationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'role_escalation_rejected'
      | 'invitation_not_found'
      | 'invitation_not_pending'
      | 'invitation_expired'
      | 'invitation_revoked'
      | 'already_a_collaborator'
      | 'rate_limited'
      | 'invalid_input',
  ) {
    super(message);
    this.name = 'InvitationError';
  }
}

export const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Maximum invitations an inviter may create in a rolling 60-minute window. */
export const INVITES_PER_WINDOW = 5;
export const INVITE_WINDOW_MS = 60 * 60 * 1000;
/** Default TTL for the rolling creation window (ms). */
export { INVITE_WINDOW_MS as INVITATION_WINDOW_MS };
