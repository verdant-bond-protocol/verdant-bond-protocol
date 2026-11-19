import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PartialFailureService,
} from '../failures/partial-failure.service';
import {
  PayoutRedemptionFailureInjectionService,
} from '../failures/payout-redemption-failure-injection.service';
import { SimulationResult } from '../failures/failure-injection.interface';
import {
  DEFAULT_ROLES,
  PermissionDiffService,
  RoleDiffReport,
} from '../auth/permission-diff.service';
import { StatusService } from '../status/status.service';
import { StatusError } from '../status/status.interface';
import { isArchived } from '../common/lifecycle/record-lifecycle';
import {
  DEFAULT_DEGRADED_NOTICES,
  ExecuteWorkflowRequest,
  RecoveryAction,
  RESILIENCE_CONTRACT_VERSION,
  RoleMap,
  UserFacingDependencyStatus,
  WORKFLOW_REQUIRED_PERMISSION,
  WorkflowComponent,
  WorkflowExecutionResult,
} from './resilience.interface';

/**
 * Ties four existing capabilities into one vertical slice:
 *
 *   1. end-to-end failure injection for critical payout/redemption workflows,
 *   2. user-facing status for the dependency the workflow depends on,
 *   3. the permission gate that decides who may drive the workflow, and
 *   4. an explicit, attributed recovery path that un-degrades the service.
 *
 * No state is persisted here: degradation is reflected in StatusService's
 * component overrides and unresolved work in PartialFailureService, both of
 * which already support archive/restore and audit attribution. Restarting the
 * process returns to the (healthy) default, which is the safe failure mode.
 */
@Injectable()
export class WorkflowResilienceService {
  private readonly logger = new Logger(WorkflowResilienceService.name);
  private roleOverlay: RoleMap | undefined;
  private readonly unresolvedByComponent = new Map<WorkflowComponent, string[]>();

  constructor(
    private readonly injection: PayoutRedemptionFailureInjectionService,
    private readonly failures: PartialFailureService,
    private readonly status: StatusService,
    private readonly permissions: PermissionDiffService,
  ) {}

  // ── Permission changes ────────────────────────────────────────────────────

  /**
   * Validate and apply a permission change. Invalid changes are rejected
   * before they can take effect, so a role can never be left empty or an
   * unknown role silently introduced.
   */
  applyPermissionChange(before: RoleMap, after: RoleMap, actor: string): RoleDiffReport {
    const validation = this.permissions.validateRoleChanges(before, after);
    if (!validation.valid) {
      throw new BadRequestException(`Invalid permission change: ${validation.errors.join('; ')}`);
    }
    const report = this.permissions.generateReport(before, after);
    // Snapshot: callers may mutate `after` after this returns.
    this.roleOverlay = Object.fromEntries(
      Object.entries(after).map(([role, perms]) => [role, [...perms]]),
    );
    this.logger.warn(`permission change applied by ${actor}`, {
      rolesModified: report.summary.rolesModified,
      added: report.summary.permissionsAdded,
      removed: report.summary.permissionsRemoved,
    });
    return report;
  }

  /** Roll back to the built-in role map. */
  resetPermissions(): void {
    this.roleOverlay = undefined;
  }

  getEffectiveRoles(): RoleMap {
    const source = this.roleOverlay ?? DEFAULT_ROLES;
    return Object.fromEntries(
      Object.entries(source).map(([role, perms]) => [role, [...perms]]),
    );
  }

  // ── Critical workflow execution ──────────────────────────────────────────

  /** Execute a critical workflow with injection, gating and status feedback. */
  async execute(request: ExecuteWorkflowRequest): Promise<WorkflowExecutionResult> {
    const component = this.componentFor(request.workflow);
    const now = request.now ?? Date.now();

    this.assertPermission(request.actorRole, request.workflow);
    this.assertMutationsAllowed(component);

    const amount = this.parseAmount(request.amount);
    const idempotencyKey = request.idempotencyKey ?? `${request.workflow.toLowerCase()}_${now}`;

    const simulation = await this.simulate(request, amount, idempotencyKey);
    const { recovered } = simulation;
    let recoveryAction: RecoveryAction = 'NONE';
    let recordedFailureId: string | undefined;

    if (simulation.injected && !recovered) {
      // A hard, unrecovered failure leaves the dependency degraded until an
      // operator explicitly recovers it. The partial-failure record carries
      // the attribution so the hidden state is never silent.
      if (simulation.partialFailureId) {
        // The injection service already opened a tracked record for this
        // failure. Link to it rather than duplicating the operator's queue.
        recordedFailureId = simulation.partialFailureId;
      } else {
        const failure = this.failures.record({
          operationType:
            request.workflow === 'PAYOUT'
              ? 'payout.degraded-dependency'
              : 'redemption.degraded-dependency',
          externalRef: simulation.simulationId,
          message: `${component} dependency degraded after an unrecovered ${request.workflow} failure`,
          severity: 'critical',
          retryable: false,
          metadata: {
            component,
            workflow: request.workflow,
            failureMode: simulation.failureMode ?? 'UNKNOWN',
            amount: amount.toString(),
          },
        });
        recordedFailureId = failure.id;
      }
      const open = this.unresolvedByComponent.get(component) ?? [];
      open.push(recordedFailureId!);
      this.unresolvedByComponent.set(component, open);
      this.status.setComponentStatus(
        component,
        'degraded',
        DEFAULT_DEGRADED_NOTICES[component],
        request.actorAddress,
      );
      recoveryAction = 'OPERATOR_RECOVERY_REQUIRED';
      this.logger.warn(`${component} degraded after unrecovered ${request.workflow} failure`, {
        simulationId: simulation.simulationId,
        partialFailureId: recordedFailureId,
      });
    } else if (simulation.injected && recovered) {
      recoveryAction = 'AUTO_RETRY';
    }

    const userStatus = await this.getUserFacingStatus(now);

    return {
      contractVersion: RESILIENCE_CONTRACT_VERSION,
      workflow: request.workflow,
      component,
      simulation,
      userStatus,
      recordedFailureId,
      recovered,
      recoveryAction,
    };
  }

  /**
   * Operator recovery: clear the degraded override and resolve the partial
   * failures that forced it. This is the rollback half of the slice — it is
   * explicit, attributed, and leaves the original records in the dashboard.
   */
  async recover(
    component: WorkflowComponent,
    actor: string,
    now: number = Date.now(),
  ): Promise<UserFacingDependencyStatus> {
    const ids = this.unresolvedByComponent.get(component) ?? [];
    for (const id of ids) {
      const failure = this.failures.get(id);
      // An archived record was deliberately hidden by an operator; recovery
      // must not silently mutate it. It stays archived and is skipped here.
      if (isArchived(failure)) continue;
      if (failure.status !== 'resolved') {
        this.failures.resolve(id, `Recovered by ${actor}`, now);
      }
    }
    this.unresolvedByComponent.delete(component);
    this.status.clearComponentOverride(component);
    this.logger.log(`${component} recovered by ${actor}`);
    return this.getUserFacingStatus(now);
  }

  // ── User-facing status ───────────────────────────────────────────────────

  /** Async view (reads the oracle incident feed) used by HTTP callers. */
  async getUserFacingStatus(now: number = Date.now()): Promise<UserFacingDependencyStatus> {
    const report = await this.status.getPublicStatus(now);
    return this.toUserFacingStatus(report, now);
  }

  private toUserFacingStatus(
    report: Awaited<ReturnType<StatusService['getPublicStatus']>>,
    now: number,
  ): UserFacingDependencyStatus {
    const degraded = report.components
      .filter((component) => component.status !== 'operational')
      .map((component) => ({
        component: component.name,
        message:
          component.publicNotice ??
          DEFAULT_DEGRADED_NOTICES[component.name] ??
          `${component.name} is temporarily unavailable.`,
        mutationAllowed: component.isMutationAllowed ?? true,
      }));
    return {
      contractVersion: RESILIENCE_CONTRACT_VERSION,
      generatedAt: new Date(now).toISOString(),
      overallStatus: report.overallStatus,
      headline: this.headline(report.overallStatus, degraded.length),
      degraded,
      report,
    };
  }

  private headline(overall: string, degradedCount: number): string {
    if (overall === 'healthy') return 'All systems operational.';
    if (degradedCount === 1) return 'One service is degraded. We are working on it.';
    if (degradedCount > 1) return `${degradedCount} services are degraded. We are working on it.`;
    return 'Service is temporarily unavailable.';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private componentFor(workflow: 'PAYOUT' | 'REDEMPTION'): WorkflowComponent {
    return workflow === 'PAYOUT' ? 'settlement' : 'redemption';
  }

  private assertPermission(role: string, workflow: 'PAYOUT' | 'REDEMPTION'): void {
    const roles = this.getEffectiveRoles();
    // Role maps are keyed in upper case, while HTTP callers send lower case
    // role names. Resolve both so the gate cannot be bypassed by casing.
    const permissions = roles[role.toUpperCase()] ?? roles[role] ?? [];
    const required = WORKFLOW_REQUIRED_PERMISSION[workflow];
    const allowed = permissions.includes('*:*') || permissions.includes(required);
    if (!allowed) {
      throw new ForbiddenException(`Role "${role}" lacks "${required}" required for ${workflow}`);
    }
  }

  private assertMutationsAllowed(component: WorkflowComponent): void {
    try {
      this.status.assertMutationAllowed(component);
    } catch (error) {
      if (error instanceof StatusError) {
        throw new ServiceUnavailableException(error.message);
      }
      throw error;
    }
  }

  private parseAmount(raw: string): bigint {
    if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) {
      throw new BadRequestException('amount must be a decimal integer string');
    }
    const amount = BigInt(raw.trim());
    if (amount < 0n) {
      throw new BadRequestException('amount must be non-negative');
    }
    return amount;
  }

  private simulate(
    request: ExecuteWorkflowRequest,
    amount: bigint,
    idempotencyKey: string,
  ): Promise<SimulationResult> {
    if (request.workflow === 'PAYOUT') {
      return this.injection.simulatePayoutFlow({
        bondId: request.bondId,
        amount,
        recipientAddress: request.counterPartyAddress,
        callerRole: request.actorRole,
        idempotencyKey,
      });
    }
    return this.injection.simulateRedemptionFlow({
      bondId: request.bondId,
      amount,
      holderAddress: request.counterPartyAddress,
      idempotencyKey,
    });
  }
}
