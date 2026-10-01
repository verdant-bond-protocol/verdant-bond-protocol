import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permission } from '../auth/rbac';
import { KycGuard } from '../common/guards/kyc.guard';
import { ProviderGuard } from '../common/guards/provider.guard';
import { IntentGuard } from '../common/guards/intent.guard';
import { AuthController } from '../auth/auth.controller';
import { BondsController } from '../bonds/bonds.controller';
import { OracleController } from '../oracle/oracle.controller';
import { ProjectsController } from '../projects/projects.controller';
import { MarketplaceController } from '../marketplace/marketplace.controller';
import { ValuationController } from '../valuation/valuation.controller';

/**
 * Single source of truth for the API route authorization matrix (issue #X part 1).
 *
 * Every controller route handler MUST be represented here. The companion spec
 * (`route-authorization.matrix.spec.ts`) walks the controllers at runtime, reads
 * the real `@UseGuards` metadata, and fails the build when:
 *   - a handler is missing from this matrix (new route added without review), or
 *   - the declared guards diverge from what is actually wired on the controller
 *     (a guard was removed from a sensitive route).
 *
 * Role taxonomy:
 *   - public        : no authentication required (read or write).
 *   - wallet-header : caller identity is taken from `x-wallet-address` only; no
 *                     JWT/KYC enforced at the API boundary (marketplace flow).
 *   - authenticated : a valid JWT session is required (JwtAuthGuard).
 *   - admin         : JWT session AND the configured admin key (AdminGuard).
 *   - permissioned  : JWT session AND every permission in `permissions`
 *                     (PermissionsGuard, #228). Roles map to permissions in
 *                     `auth/rbac.ts`; the maintainer (admin key) holds all.
 *
 * KYC-gated routes carry `KycGuard` and are listed as `authenticated`.
 * Admin mutation routes additionally carry `IntentGuard` (step-up signed intent,
 * see `require-intent.decorator.ts`); `ProviderGuard` is unit-tested in
 * `guard-roles.spec.ts`.
 */

export type GuardRef =
  | typeof JwtAuthGuard
  | typeof AdminGuard
  | typeof PermissionsGuard
  | typeof KycGuard
  | typeof ProviderGuard
  | typeof IntentGuard;

export type RouteRole = 'public' | 'wallet-header' | 'authenticated' | 'admin' | 'permissioned';

export interface RouteAuthEntry {
  controller: any;
  method: string;
  httpMethod: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  guards: GuardRef[];
  role: RouteRole;
  /** Required permissions; set exactly when `role` is `permissioned`. */
  permissions?: Permission[];
  mutation: boolean;
}

export const ROUTE_AUTHORIZATION_MATRIX: RouteAuthEntry[] = [
  // ---- Auth ----
  { controller: AuthController, method: 'challenge', httpMethod: 'POST', path: 'auth/challenge', guards: [], role: 'public', mutation: true },
  { controller: AuthController, method: 'verify', httpMethod: 'POST', path: 'auth/verify', guards: [], role: 'public', mutation: true },
  { controller: AuthController, method: 'refresh', httpMethod: 'POST', path: 'auth/refresh', guards: [], role: 'public', mutation: true },
  { controller: AuthController, method: 'profile', httpMethod: 'GET', path: 'auth/profile', guards: [JwtAuthGuard], role: 'authenticated', mutation: false },
  { controller: AuthController, method: 'getKyc', httpMethod: 'GET', path: 'auth/kyc/:address', guards: [JwtAuthGuard], role: 'authenticated', mutation: false },
  { controller: AuthController, method: 'updateKyc', httpMethod: 'POST', path: 'auth/kyc/:address', guards: [JwtAuthGuard], role: 'authenticated', mutation: true },

  // ---- Bonds ----
  { controller: BondsController, method: 'create', httpMethod: 'POST', path: 'bonds', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.CREATE_BOND], mutation: true },
  { controller: BondsController, method: 'findAll', httpMethod: 'GET', path: 'bonds', guards: [], role: 'public', mutation: false },
  { controller: BondsController, method: 'findHeldByAddress', httpMethod: 'GET', path: 'bonds/held/:address', guards: [], role: 'public', mutation: false },
  { controller: BondsController, method: 'findOne', httpMethod: 'GET', path: 'bonds/:id', guards: [], role: 'public', mutation: false },
  { controller: BondsController, method: 'getBondDetail', httpMethod: 'GET', path: 'bonds/:id/detail', guards: [], role: 'public', mutation: false },
  { controller: BondsController, method: 'subscribe', httpMethod: 'POST', path: 'bonds/:id/subscribe', guards: [JwtAuthGuard, KycGuard], role: 'authenticated', mutation: true },
  { controller: BondsController, method: 'getHolders', httpMethod: 'GET', path: 'bonds/:id/holders', guards: [], role: 'public', mutation: false },
  { controller: BondsController, method: 'distributeCoupon', httpMethod: 'POST', path: 'bonds/:id/coupon', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.DISTRIBUTE_COUPON], mutation: true },
  { controller: BondsController, method: 'claimCredits', httpMethod: 'POST', path: 'bonds/:id/claim', guards: [JwtAuthGuard, KycGuard], role: 'authenticated', mutation: true },
  { controller: BondsController, method: 'getUndistributedTotal', httpMethod: 'GET', path: 'bonds/:id/undistributed', guards: [], role: 'public', mutation: false },
  { controller: BondsController, method: 'previewSubscribe', httpMethod: 'GET', path: 'bonds/:id/preview-subscribe', guards: [], role: 'public', mutation: false },
  { controller: BondsController, method: 'getClaimableCredits', httpMethod: 'GET', path: 'bonds/:id/claimable-credits', guards: [], role: 'public', mutation: false },
  { controller: BondsController, method: 'sweepUndistributed', httpMethod: 'POST', path: 'bonds/:id/sweep-undistributed', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.SWEEP_UNDISTRIBUTED], mutation: true },
  { controller: BondsController, method: 'transfer', httpMethod: 'POST', path: 'bonds/:id/transfer', guards: [JwtAuthGuard, KycGuard], role: 'authenticated', mutation: true },
  { controller: BondsController, method: 'mature', httpMethod: 'POST', path: 'bonds/:id/mature', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.MATURE_BOND], mutation: true },
  { controller: BondsController, method: 'reconcileHolders', httpMethod: 'POST', path: 'bonds/:id/reconcile-holders', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.RECONCILE_HOLDERS], mutation: true },
  { controller: BondsController, method: 'reindexHolders', httpMethod: 'POST', path: 'bonds/admin/reindex-holders', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.REINDEX_HOLDERS], mutation: true },
  { controller: BondsController, method: 'exportBond', httpMethod: 'GET', path: 'bonds/:id/export', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.EXPORT_BOND], mutation: false },

  // ---- Oracle ----
  { controller: OracleController, method: 'submitReport', httpMethod: 'POST', path: 'oracle/reports', guards: [], role: 'wallet-header', mutation: true },
  { controller: OracleController, method: 'getProjectReports', httpMethod: 'GET', path: 'oracle/reports/:projectId', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'getProjectChallengedReports', httpMethod: 'GET', path: 'oracle/reports/:projectId/challenges', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'getReportChallengeState', httpMethod: 'GET', path: 'oracle/challenges/:reportId', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'getCouponEligibility', httpMethod: 'GET', path: 'oracle/projects/:projectId/coupon-eligibility', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'challengeReport', httpMethod: 'POST', path: 'oracle/challenge/:reportId', guards: [], role: 'wallet-header', mutation: true },
  { controller: OracleController, method: 'registerProvider', httpMethod: 'POST', path: 'oracle/providers', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.REGISTER_PROVIDER], mutation: true },
  { controller: OracleController, method: 'listProviders', httpMethod: 'GET', path: 'oracle/providers', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'getProviderStats', httpMethod: 'GET', path: 'oracle/stats/:providerAddress', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'staleness', httpMethod: 'GET', path: 'oracle/monitoring/staleness', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'anomalies', httpMethod: 'GET', path: 'oracle/monitoring/anomalies', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'getProjectStalenessState', httpMethod: 'GET', path: 'oracle/staleness/:projectId', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'listIncidents', httpMethod: 'GET', path: 'oracle/incidents', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.MANAGE_INCIDENTS], mutation: false },
  { controller: OracleController, method: 'acknowledgeIncident', httpMethod: 'POST', path: 'oracle/incidents/:id/acknowledge', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.MANAGE_INCIDENTS], mutation: true },
  { controller: OracleController, method: 'resolveIncident', httpMethod: 'POST', path: 'oracle/incidents/:id/resolve', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.MANAGE_INCIDENTS], mutation: true },

  // ---- Projects ----
  { controller: ProjectsController, method: 'register', httpMethod: 'POST', path: 'projects', guards: [], role: 'public', mutation: true },
  { controller: ProjectsController, method: 'findAll', httpMethod: 'GET', path: 'projects', guards: [], role: 'public', mutation: false },
  { controller: ProjectsController, method: 'findOne', httpMethod: 'GET', path: 'projects/:id', guards: [], role: 'public', mutation: false },
  { controller: ProjectsController, method: 'provenance', httpMethod: 'GET', path: 'projects/:id/provenance', guards: [], role: 'public', mutation: false },
  { controller: ProjectsController, method: 'approve', httpMethod: 'POST', path: 'projects/:id/approve', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.APPROVE_PROJECT], mutation: true },
  { controller: ProjectsController, method: 'reject', httpMethod: 'POST', path: 'projects/:id/reject', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.REJECT_PROJECT], mutation: true },
  { controller: ProjectsController, method: 'uploadDocuments', httpMethod: 'POST', path: 'projects/:id/documents', guards: [], role: 'public', mutation: true },
  { controller: ProjectsController, method: 'exportProject', httpMethod: 'GET', path: 'projects/:id/export', guards: [JwtAuthGuard], role: 'authenticated', mutation: false },
  { controller: ProjectsController, method: 'addCertification', httpMethod: 'POST', path: 'projects/:id/certifications', guards: [], role: 'public', mutation: true },
  { controller: ProjectsController, method: 'certificationHistory', httpMethod: 'GET', path: 'projects/:id/certifications', guards: [], role: 'public', mutation: false },
  { controller: ProjectsController, method: 'couponCertification', httpMethod: 'GET', path: 'projects/:id/coupon-certification', guards: [], role: 'public', mutation: false },

  // ---- Marketplace ----
  { controller: MarketplaceController, method: 'listQuoteAssets', httpMethod: 'GET', path: 'marketplace/quote-assets', guards: [], role: 'public', mutation: false },
  { controller: MarketplaceController, method: 'listOrders', httpMethod: 'GET', path: 'marketplace/orders', guards: [], role: 'public', mutation: false },
  { controller: MarketplaceController, method: 'listBondTokens', httpMethod: 'POST', path: 'marketplace/list', guards: [], role: 'wallet-header', mutation: true },
  { controller: MarketplaceController, method: 'buyBondTokens', httpMethod: 'POST', path: 'marketplace/buy', guards: [], role: 'wallet-header', mutation: true },
  { controller: MarketplaceController, method: 'getQuoteBalance', httpMethod: 'GET', path: 'marketplace/quote-balance', guards: [], role: 'wallet-header', mutation: false },
  { controller: MarketplaceController, method: 'getWalletBalance', httpMethod: 'GET', path: 'marketplace/wallet-balance', guards: [], role: 'wallet-header', mutation: false },
  { controller: MarketplaceController, method: 'depositQuote', httpMethod: 'POST', path: 'marketplace/deposit', guards: [], role: 'wallet-header', mutation: true },
  { controller: MarketplaceController, method: 'withdrawQuote', httpMethod: 'POST', path: 'marketplace/withdraw', guards: [], role: 'wallet-header', mutation: true },
  { controller: MarketplaceController, method: 'cancelOrder', httpMethod: 'DELETE', path: 'marketplace/orders/:id', guards: [], role: 'wallet-header', mutation: true },
  { controller: MarketplaceController, method: 'getOrder', httpMethod: 'GET', path: 'marketplace/orders/:id', guards: [], role: 'public', mutation: false },
  { controller: MarketplaceController, method: 'getPriceFeed', httpMethod: 'GET', path: 'marketplace/prices', guards: [], role: 'public', mutation: false },
  { controller: MarketplaceController, method: 'getBestPrice', httpMethod: 'GET', path: 'marketplace/prices/:bondId/best', guards: [], role: 'public', mutation: false },
  { controller: MarketplaceController, method: 'calculateSlippage', httpMethod: 'GET', path: 'marketplace/prices/:bondId/slippage', guards: [], role: 'public', mutation: false },
  { controller: MarketplaceController, method: 'runReconciliation', httpMethod: 'POST', path: 'marketplace/reconciliation/run', guards: [], role: 'wallet-header', mutation: true },
  { controller: MarketplaceController, method: 'listReconciliationMismatches', httpMethod: 'GET', path: 'marketplace/reconciliation/mismatches', guards: [], role: 'wallet-header', mutation: false },
  { controller: MarketplaceController, method: 'repairReconciliation', httpMethod: 'POST', path: 'marketplace/reconciliation/repair', guards: [], role: 'wallet-header', mutation: true },
  // ---- Valuations (#204) ----
  { controller: ValuationController, method: 'getValuations', httpMethod: 'GET', path: 'valuations', guards: [], role: 'public', mutation: false },
];
