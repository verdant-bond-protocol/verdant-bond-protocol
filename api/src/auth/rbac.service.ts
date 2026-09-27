import { Injectable } from '@nestjs/common';
import { Role, Permission, RolePermissions } from './rbac';

@Injectable()
export class RbacService {
  getUserRoles(address: string): Role[] {
    const roles: Role[] = [];
    const adminKey = process.env.STELLAR_PUBLIC_KEY;
    if (adminKey && address === adminKey) {
      roles.push(Role.MAINTAINER);
    }
    
    const issuerKeys = (process.env.ISSUER_PUBLIC_KEYS || '').split(',').filter(Boolean);
    if (issuerKeys.includes(address)) {
      roles.push(Role.ISSUER);
    }

    const settlementKeys = (process.env.SETTLEMENT_PUBLIC_KEYS || '').split(',').filter(Boolean);
    if (settlementKeys.includes(address)) {
      roles.push(Role.SETTLEMENT_MANAGER);
    }

    // Default to investor if no other role
    roles.push(Role.INVESTOR);

    return roles;
  }

  getUserPermissions(address: string): Permission[] {
    const roles = this.getUserRoles(address);
    const perms = new Set<Permission>();
    for (const role of roles) {
      for (const p of RolePermissions[role] || []) {
        perms.add(p);
      }
    }
    return Array.from(perms);
  }
}
