export enum Role {
  MAINTAINER = 'maintainer',
  ISSUER = 'issuer',
  INVESTOR = 'investor',
  SETTLEMENT_MANAGER = 'settlement_manager',
}

export enum Permission {
  CREATE_BOND = 'create_bond',
  DISTRIBUTE_COUPON = 'distribute_coupon',
  MATURE_BOND = 'mature_bond',
  SUBSCRIBE_BOND = 'subscribe_bond',
  CLAIM_CREDITS = 'claim_credits',
  TRANSFER_BOND = 'transfer_bond',
  RECONCILE_HOLDERS = 'reconcile_holders',
  REINDEX_HOLDERS = 'reindex_holders',
  SWEEP_UNDISTRIBUTED = 'sweep_undistributed',
  EXPORT_BOND = 'export_bond',
  APPROVE_INVESTOR = 'approve_investor',
  REGISTER_PROVIDER = 'register_provider',
  MANAGE_INCIDENTS = 'manage_incidents',
  APPROVE_PROJECT = 'approve_project',
  REJECT_PROJECT = 'reject_project',
}

export const RolePermissions: Record<Role, Permission[]> = {
  [Role.MAINTAINER]: Object.values(Permission),
  [Role.ISSUER]: [
    Permission.CREATE_BOND,
    Permission.DISTRIBUTE_COUPON,
    Permission.MATURE_BOND,
    Permission.EXPORT_BOND,
    Permission.APPROVE_PROJECT,
    Permission.REJECT_PROJECT,
  ],
  [Role.INVESTOR]: [
    Permission.SUBSCRIBE_BOND,
    Permission.CLAIM_CREDITS,
    Permission.TRANSFER_BOND,
  ],
  [Role.SETTLEMENT_MANAGER]: [
    Permission.RECONCILE_HOLDERS,
    Permission.REINDEX_HOLDERS,
    Permission.SWEEP_UNDISTRIBUTED,
    Permission.REGISTER_PROVIDER,
    Permission.MANAGE_INCIDENTS,
  ],
};
