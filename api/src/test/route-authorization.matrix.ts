import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permission } from '../auth/rbac';
import { KycGuard } from '../common/guards/kyc.guard';
import { ProviderGuard } from '../common/guards/provider.guard';
import { IntentGuard } from '../common/guards/intent.guard';
import { RiskGuard } from '../common/risk/risk.guard';
import { AuthController } from '../auth/auth.controller';
import { BondsController } from '../bonds/bonds.controller';
import { OracleController } from '../oracle/oracle.controller';
import { ProjectsController } from '../projects/projects.controller';
import { MethodologyVersioningController } from '../projects/methodology-versioning.controller';
import { MarketplaceController } from '../marketplace/marketplace.controller';
import { ValuationController } from '../valuation/valuation.controller';
import { QuoteConversionController } from '../valuation/quote-conversion.controller';
import { PolicyConfigController } from '../policy/policy-config.controller';
import { IntentReceiptController } from '../intent-receipts/intent-receipt.controller';
import { JobsController } from '../workers/controllers/jobs.controller';

import { FeesController } from '../fees/fees.controller';
import { PayoutReconciliationController } from '../reconciliation/controllers/payout-reconciliation.controller';
import { InvestorComplianceExportController } from '../exports/controllers/investor-compliance-export.controller';

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
  | typeof IntentGuard
  | typeof RiskGuard;

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
  // ---- Background jobs / recovery ----
  { controller: JobsController, method: 'enqueueJob', httpMethod: 'POST', path: 'api/v1/jobs/enqueue', guards: [JwtAuthGuard], role: 'authenticated', mutation: true },
  { controller: JobsController, method: 'getJob', httpMethod: 'GET', path: 'api/v1/jobs/:jobId', guards: [JwtAuthGuard], role: 'authenticated', mutation: false },
  { controller: JobsController, method: 'getQueueStatus', httpMethod: 'GET', path: 'api/v1/jobs/queue/status', guards: [JwtAuthGuard, AdminGuard], role: 'admin', mutation: false },
  { controller: JobsController, method: 'getDeadLetterJobs', httpMethod: 'GET', path: 'api/v1/jobs/dead-letter/list', guards: [JwtAuthGuard, AdminGuard], role: 'admin', mutation: false },
  { controller: JobsController, method: 'recoverDeadLetter', httpMethod: 'POST', path: 'api/v1/jobs/dead-letter/:jobId/recover', guards: [JwtAuthGuard, AdminGuard], role: 'admin', mutation: true },
  { controller: JobsController, method: 'recoverStuck', httpMethod: 'POST', path: 'api/v1/jobs/recover/stuck', guards: [JwtAuthGuard, AdminGuard], role: 'admin', mutation: true },
  { controller: JobsController, method: 'getRecoveryAudit', httpMethod: 'GET', path: 'api/v1/jobs/recovery/audit', guards: [JwtAuthGuard, AdminGuard], role: 'admin', mutation: false },
  { controller: JobsController, method: 'getDependencyMatrix', httpMethod: 'GET', path: 'api/v1/jobs/recovery/dependency-matrix', guards: [JwtAuthGuard, AdminGuard], role: 'admin', mutation: false },

  // ---- Auth ----
  { controller: AuthController, method: 'challenge', httpMethod: 'POST', path: 'auth/challenge', guards: [], role: 'public', mutation: true },
  { controller: AuthController, method: 'verify', httpMethod: 'POST', path: 'auth/verify', guards: [], role: 'public', mutation: true },
  { controller: AuthController, method: 'refresh', httpMethod: 'POST', path: 'auth/refresh', guards: [], role: 'public', mutation: true },
  { controller: AuthController, method: 'profile', httpMethod: 'GET', path: 'auth/profile', guards: [JwtAuthGuard], role: 'authenticated', mutation: false },
  { controller: AuthController, method: 'getKyc', httpMethod: 'GET', path: 'auth/kyc/:address', guards: [JwtAuthGuard], role: 'authenticated', mutation: false },
  { controller: AuthController, method: 'updateKyc', httpMethod: 'POST', path: 'auth/kyc/:address', guards: [JwtAuthGuard], role: 'authenticated', mutation: true },

  // ---- Bonds ----
  { controller: BondsController, method: 'create', httpMethod: 'POST', path: 'bonds', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard, RiskGuard], role: 'permissioned', permissions: [Permission.CREATE_BOND], mutation: true },
  { controller: BondsController, method: 'findAll', httpMethod: 'GET', path: 'bonds', guards: [], role: 'public', mutation: false },
  { controller: BondsController, method: 'findHeldByAddress', httpMethod: 'GET', path: 'bonds/held/:address', guards: [JwtAuthGuard], role: 'authenticated', mutation: false },
  { controller: BondsController, method: 'findOne', httpMethod: 'GET', path: 'bonds/:id', guards: [], role: 'public', mutation: false },
  { controller: BondsController, method: 'getBondDetail', httpMethod: 'GET', path: 'bonds/:id/detail', guards: [], role: 'public', mutation: false },
  { controller: BondsController, method: 'subscribe', httpMethod: 'POST', path: 'bonds/:id/subscribe', guards: [JwtAuthGuard, KycGuard], role: 'authenticated', mutation: true },
  { controller: BondsController, method: 'getHolders', httpMethod: 'GET', path: 'bonds/:id/holders', guards: [], role: 'public', mutation: false },
  { controller: BondsController, method: 'distributeCoupon', httpMethod: 'POST', path: 'bonds/:id/coupon', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.DISTRIBUTE_COUPON], mutation: true },
  { controller: BondsController, method: 'distributeCouponBatch', httpMethod: 'POST', path: 'bonds/:id/coupon-batch', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.DISTRIBUTE_COUPON], mutation: true },
  { controller: BondsController, method: 'getCouponBatchStatus', httpMethod: 'GET', path: 'bonds/:id/coupon-batch-status', guards: [], role: 'public', mutation: false },
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
  { controller: BondsController, method: 'redeem', httpMethod: 'POST', path: 'bonds/:id/redeem', guards: [JwtAuthGuard, KycGuard], role: 'authenticated', mutation: true },
  { controller: BondsController, method: 'runCouponBacktest', httpMethod: 'POST', path: 'bonds/backtest', guards: [JwtAuthGuard], role: 'authenticated', mutation: true },
  { controller: BondsController, method: 'archiveMaturedRecord', httpMethod: 'POST', path: 'bonds/:id/archive', guards: [], role: 'public', mutation: true },
  { controller: BondsController, method: 'verifyRestore', httpMethod: 'POST', path: 'bonds/:id/verify-restore', guards: [], role: 'public', mutation: true },
  { controller: BondsController, method: 'restoreMaturedRecord', httpMethod: 'POST', path: 'bonds/:id/restore', guards: [], role: 'public', mutation: true },
  { controller: BondsController, method: 'getArchivalLifecycle', httpMethod: 'GET', path: 'bonds/:id/lifecycle', guards: [], role: 'public', mutation: false },

  // Oracle
  { controller: OracleController, method: 'submitReport', httpMethod: 'POST', path: 'oracle/reports', guards: [], role: 'wallet-header', mutation: true },
  { controller: OracleController, method: 'getProjectReports', httpMethod: 'GET', path: 'oracle/reports/:projectId', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'getProjectChallengedReports', httpMethod: 'GET', path: 'oracle/reports/:projectId/challenges', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'getReportChallengeState', httpMethod: 'GET', path: 'oracle/challenges/:reportId', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'getCouponEligibility', httpMethod: 'GET', path: 'oracle/projects/:projectId/coupon-eligibility', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'challengeReport', httpMethod: 'POST', path: 'oracle/challenge/:reportId', guards: [], role: 'wallet-header', mutation: true },
  { controller: OracleController, method: 'getDisputeEvidenceBundle', httpMethod: 'GET', path: 'oracle/reports/:reportId/dispute-bundle', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'submitHistoricalCorrection', httpMethod: 'POST', path: 'oracle/reports/correction', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.MANAGE_INCIDENTS], mutation: true },
  { controller: OracleController, method: 'getHistoricalCorrections', httpMethod: 'GET', path: 'oracle/reports/:reportId/corrections', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'registerProvider', httpMethod: 'POST', path: 'oracle/providers', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.REGISTER_PROVIDER], mutation: true },
  { controller: OracleController, method: 'listProviders', httpMethod: 'GET', path: 'oracle/providers', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'getProviderStats', httpMethod: 'GET', path: 'oracle/stats/:providerAddress', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'staleness', httpMethod: 'GET', path: 'oracle/monitoring/staleness', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'anomalies', httpMethod: 'GET', path: 'oracle/monitoring/anomalies', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'getProjectStalenessState', httpMethod: 'GET', path: 'oracle/staleness/:projectId', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'listIncidents', httpMethod: 'GET', path: 'oracle/incidents', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.MANAGE_INCIDENTS], mutation: false },
  { controller: OracleController, method: 'acknowledgeIncident', httpMethod: 'POST', path: 'oracle/incidents/:id/acknowledge', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.MANAGE_INCIDENTS], mutation: true },
  { controller: OracleController, method: 'resolveIncident', httpMethod: 'POST', path: 'oracle/incidents/:id/resolve', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.MANAGE_INCIDENTS], mutation: true },
  { controller: OracleController, method: 'getCircuitBreakerStatus', httpMethod: 'GET', path: 'oracle/circuit-breaker/:projectId', guards: [], role: 'public', mutation: false },
  { controller: OracleController, method: 'resumeProject', httpMethod: 'POST', path: 'oracle/circuit-breaker/resume', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.MANAGE_INCIDENTS], mutation: true },

  // Projects
  { controller: ProjectsController, method: 'register', httpMethod: 'POST', path: 'projects', guards: [], role: 'public', mutation: true },
  { controller: ProjectsController, method: 'findAll', httpMethod: 'GET', path: 'projects', guards: [], role: 'public', mutation: false },
  { controller: ProjectsController, method: 'findOne', httpMethod: 'GET', path: 'projects/:id', guards: [], role: 'public', mutation: false },
  { controller: ProjectsController, method: 'provenance', httpMethod: 'GET', path: 'projects/:id/provenance', guards: [], role: 'public', mutation: false },
  { controller: ProjectsController, method: 'approve', httpMethod: 'POST', path: 'projects/:id/approve', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.APPROVE_PROJECT], mutation: true },
  { controller: ProjectsController, method: 'reject', httpMethod: 'POST', path: 'projects/:id/reject', guards: [JwtAuthGuard, PermissionsGuard, IntentGuard], role: 'permissioned', permissions: [Permission.REJECT_PROJECT], mutation: true },
  { controller: ProjectsController, method: 'uploadDocuments', httpMethod: 'POST', path: 'projects/:id/documents', guards: [], role: 'public', mutation: true },
  { controller: ProjectsController, method: 'exportProject', httpMethod: 'GET', path: 'projects/:id/export', guards: [JwtAuthGuard], role: 'authenticated', mutation: false },
  { controller: ProjectsController, method: 'addCertification', httpMethod: 'POST', path: 'projects/:id/certifications', guards: [], role: 'public', mutation: true },
  { controller: ProjectsController, method: 'updateCertifications', httpMethod: 'PUT', path: 'projects/:id/certifications', guards: [], role: 'public', mutation: true },
  { controller: ProjectsController, method: 'certificationHistory', httpMethod: 'GET', path: 'projects/:id/certifications', guards: [], role: 'public', mutation: false },
  { controller: ProjectsController, method: 'couponCertification', httpMethod: 'GET', path: 'projects/:id/coupon-certification', guards: [], role: 'public', mutation: false },
  { controller: ProjectsController, method: 'getDocument', httpMethod: 'GET', path: 'projects/:id/documents/:hash', guards: [], role: 'public', mutation: false },
  { controller: ProjectsController, method: 'flagDocumentAsAudit', httpMethod: 'POST', path: 'projects/:id/documents/:hash/flag-audit', guards: [JwtAuthGuard], role: 'authenticated', mutation: true },
  { controller: ProjectsController, method: 'escalateDocument', httpMethod: 'POST', path: 'projects/:id/documents/:hash/escalate', guards: [], role: 'public', mutation: true },
  { controller: ProjectsController, method: 'getDocumentHealth', httpMethod: 'GET', path: 'projects/:id/documents/:hash/health', guards: [], role: 'public', mutation: false },

  // Methodology Versioning (#622)
  { controller: MethodologyVersioningController, method: 'createDraft', httpMethod: 'POST', path: 'methodologies', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.MANAGE_METHODOLOGIES], mutation: true },
  { controller: MethodologyVersioningController, method: 'activate', httpMethod: 'POST', path: 'methodologies/:id/versions/:version/activate', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.MANAGE_METHODOLOGIES], mutation: true },
  { controller: MethodologyVersioningController, method: 'deprecate', httpMethod: 'POST', path: 'methodologies/:id/versions/:version/deprecate', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.MANAGE_METHODOLOGIES], mutation: true },
  { controller: MethodologyVersioningController, method: 'list', httpMethod: 'GET', path: 'methodologies', guards: [JwtAuthGuard], role: 'authenticated', mutation: false },
  { controller: MethodologyVersioningController, method: 'getOne', httpMethod: 'GET', path: 'methodologies/:id/versions/:version', guards: [JwtAuthGuard], role: 'authenticated', mutation: false },
  { controller: MethodologyVersioningController, method: 'pinToBond', httpMethod: 'POST', path: 'methodologies/bonds/:bondId/pin', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.MANAGE_METHODOLOGIES], mutation: true },
  { controller: MethodologyVersioningController, method: 'getBondPin', httpMethod: 'GET', path: 'methodologies/bonds/:bondId/pin', guards: [JwtAuthGuard], role: 'authenticated', mutation: false },
  { controller: MethodologyVersioningController, method: 'bindReport', httpMethod: 'POST', path: 'methodologies/reports/:reportId/bind', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.MANAGE_METHODOLOGIES], mutation: true },
  { controller: MethodologyVersioningController, method: 'migrateLegacy', httpMethod: 'POST', path: 'methodologies/migrations/legacy', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.MANAGE_METHODOLOGIES], mutation: true },
  { controller: MethodologyVersioningController, method: 'rollbackLegacy', httpMethod: 'POST', path: 'methodologies/migrations/legacy/rollback', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.MANAGE_METHODOLOGIES], mutation: true },


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
  { controller: MarketplaceController, method: 'evaluatePriceImpact', httpMethod: 'GET', path: 'marketplace/prices/:bondId/impact', guards: [], role: 'public', mutation: false },
  { controller: MarketplaceController, method: 'getPriceImpactConfig', httpMethod: 'GET', path: 'marketplace/config/:bondId/impact-limits', guards: [], role: 'public', mutation: false },
  { controller: MarketplaceController, method: 'updatePriceImpactConfig', httpMethod: 'PUT', path: 'marketplace/config/:bondId/impact-limits', guards: [], role: 'wallet-header', mutation: true },
  { controller: MarketplaceController, method: 'runReconciliation', httpMethod: 'POST', path: 'marketplace/reconciliation/run', guards: [], role: 'wallet-header', mutation: true },
  { controller: MarketplaceController, method: 'listReconciliationMismatches', httpMethod: 'GET', path: 'marketplace/reconciliation/mismatches', guards: [], role: 'wallet-header', mutation: false },
  { controller: MarketplaceController, method: 'repairReconciliation', httpMethod: 'POST', path: 'marketplace/reconciliation/repair', guards: [], role: 'wallet-header', mutation: true },
  // ---- Admin configuration (#408) ----
  { controller: PolicyConfigController, method: 'getConfiguration', httpMethod: 'GET', path: 'admin/config/policy', guards: [JwtAuthGuard, AdminGuard], role: 'admin', mutation: false },
  { controller: PolicyConfigController, method: 'updateConfiguration', httpMethod: 'PUT', path: 'admin/config/policy', guards: [JwtAuthGuard, AdminGuard, IntentGuard], role: 'admin', mutation: true },
  { controller: PolicyConfigController, method: 'rollback', httpMethod: 'POST', path: 'admin/config/policy/rollback', guards: [JwtAuthGuard, AdminGuard, IntentGuard], role: 'admin', mutation: true },
  // ---- Fees (#301); large-integer amount contract in fees.large-integer.contract.spec.ts ----
  { controller: FeesController, method: 'preview', httpMethod: 'POST', path: 'fees/preview', guards: [JwtAuthGuard], role: 'authenticated', mutation: false },
  // ---- Valuations (#204) & Quotes (#620) ----
  { controller: ValuationController, method: 'getValuations', httpMethod: 'GET', path: 'valuations', guards: [], role: 'public', mutation: false },
  { controller: QuoteConversionController, method: 'issueQuote', httpMethod: 'POST', path: 'valuations/quotes', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.REQUEST_CONVERSION_QUOTE], mutation: true },
  { controller: QuoteConversionController, method: 'consumeQuote', httpMethod: 'POST', path: 'valuations/quotes/:id/consume', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.CONSUME_CONVERSION_QUOTE], mutation: true },
  { controller: QuoteConversionController, method: 'getQuote', httpMethod: 'GET', path: 'valuations/quotes/:id', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.REQUEST_CONVERSION_QUOTE], mutation: false },
  // ---- Maintainer intent receipts (review surface; read-only + reviews) ----
  { controller: IntentReceiptController, method: 'list', httpMethod: 'GET', path: 'admin/intent-receipts', guards: [JwtAuthGuard, AdminGuard], role: 'admin', mutation: false },
  { controller: IntentReceiptController, method: 'stats', httpMethod: 'GET', path: 'admin/intent-receipts/stats', guards: [JwtAuthGuard, AdminGuard], role: 'admin', mutation: false },
  { controller: IntentReceiptController, method: 'signingKey', httpMethod: 'GET', path: 'admin/intent-receipts/signing-key', guards: [JwtAuthGuard, AdminGuard], role: 'admin', mutation: false },
  { controller: IntentReceiptController, method: 'verifyExported', httpMethod: 'POST', path: 'admin/intent-receipts/verify', guards: [JwtAuthGuard, AdminGuard], role: 'admin', mutation: false },
  { controller: IntentReceiptController, method: 'get', httpMethod: 'GET', path: 'admin/intent-receipts/:id', guards: [JwtAuthGuard, AdminGuard], role: 'admin', mutation: false },
  { controller: IntentReceiptController, method: 'verify', httpMethod: 'GET', path: 'admin/intent-receipts/:id/verify', guards: [JwtAuthGuard, AdminGuard], role: 'admin', mutation: false },
  { controller: IntentReceiptController, method: 'review', httpMethod: 'POST', path: 'admin/intent-receipts/:id/reviews', guards: [JwtAuthGuard, AdminGuard], role: 'admin', mutation: true },

  // ---- Payout reconciliation (#621) ----
  { controller: PayoutReconciliationController, method: 'run', httpMethod: 'POST', path: 'api/v1/reconciliation/payouts/run', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.RECONCILE_PAYOUTS], mutation: true },
  { controller: PayoutReconciliationController, method: 'getReport', httpMethod: 'GET', path: 'api/v1/reconciliation/payouts/reports/:runId', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.RECONCILE_PAYOUTS], mutation: false },
  { controller: PayoutReconciliationController, method: 'createAdjustment', httpMethod: 'POST', path: 'api/v1/reconciliation/payouts/adjustments', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.RECONCILE_PAYOUTS], mutation: true },
  { controller: PayoutReconciliationController, method: 'listAdjustments', httpMethod: 'GET', path: 'api/v1/reconciliation/payouts/adjustments', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.RECONCILE_PAYOUTS], mutation: false },

  // ---- Investor compliance export (#619) ----
  { controller: InvestorComplianceExportController, method: 'exportCompliance', httpMethod: 'GET', path: 'api/v1/exports/investors/compliance', guards: [JwtAuthGuard, PermissionsGuard], role: 'permissioned', permissions: [Permission.EXPORT_INVESTOR_COMPLIANCE], mutation: false },
];
