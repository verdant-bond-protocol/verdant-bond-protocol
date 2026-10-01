import { CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Role, RolePermissions } from '../auth/rbac';

/**
 * Role taxonomy used by the controller authorization specs. Each fake guard below
 * reads `x-test-role` from the request header and enforces the SAME allow/deny
 * semantics as the real guard it stands in for:
 *
 *   - JwtAuthGuard  : allows everyone except `anon`; populates `req.user`,
 *                     including the RBAC `permissions` a real token carries
 *                     (`admin` is the maintainer, everyone else an investor).
 *                     The real `PermissionsGuard` then runs unmodified.
 *   - AdminGuard     : allows only `admin` (throws UnauthorizedException, like the real one).
 *   - KycGuard       : allows only `verified` (throws ForbiddenException for everyone else).
 *   - ProviderGuard  : allows only `provider` (throws UnauthorizedException).
 *   - IntentGuard    : allow-all (intent verification is covered separately by
 *                      `intent.service.spec.ts`, not the behavioural role specs).
 *
 * The real guards remain covered by `route-authorization.matrix.spec.ts` (which
 * asserts they are actually wired) and `guard-roles.spec.ts` (unit behaviour).
 */

export type TestRole = 'anon' | 'user' | 'verified' | 'provider' | 'admin';

function roleOf(ctx: ExecutionContext): TestRole {
  const req = ctx.switchToHttp().getRequest();
  return ((req.headers['x-test-role'] as TestRole) || 'anon');
}

export const fakeJwtAuthGuard: CanActivate = {
  canActivate(ctx: ExecutionContext) {
    const role = roleOf(ctx);
    if (role === 'anon') {
      throw new UnauthorizedException('Authentication required');
    }
    const req = ctx.switchToHttp().getRequest();
    const rbacRole = role === 'admin' ? Role.MAINTAINER : Role.INVESTOR;
    req.user = {
      walletAddress: `G_${role.toUpperCase()}_ADDRESS`,
      kycStatus: role === 'verified' ? 'verified' : 'none',
      roles: [rbacRole],
      permissions: [...RolePermissions[rbacRole]],
    };
    return true;
  },
};

export const fakeAdminGuard: CanActivate = {
  canActivate(ctx: ExecutionContext) {
    if (roleOf(ctx) !== 'admin') {
      throw new UnauthorizedException('Admin access required');
    }
    return true;
  },
};

export const fakeKycGuard: CanActivate = {
  canActivate(ctx: ExecutionContext) {
    if (roleOf(ctx) !== 'verified') {
      throw new ForbiddenException('KYC verification required');
    }
    return true;
  },
};

export const fakeProviderGuard: CanActivate = {
  canActivate(ctx: ExecutionContext) {
    if (roleOf(ctx) !== 'provider') {
      throw new UnauthorizedException('Provider access required');
    }
    return true;
  },
};

export const fakeIntentGuard: CanActivate = {
  canActivate() {
    return true;
  },
};

/**
 * Produces a `jest.Mocked<T>` whose every prototype method is a `jest.fn()` so a
 * controller can be booted in isolation without a database. Only the methods a
 * test actually exercises need to be configured with return values.
 */
export function autoMock<T>(cls: new (...args: any[]) => T): jest.Mocked<T> {
  const mock: Record<string, jest.Mock> = {};
  const proto = (cls as any).prototype;
  Object.getOwnPropertyNames(proto).forEach((name) => {
    if (name === 'constructor') return;
    mock[name] = jest.fn();
  });
  return mock as unknown as jest.Mocked<T>;
}
