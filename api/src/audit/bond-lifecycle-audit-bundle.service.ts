import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import { AuditService } from './audit.service';
import { AuditRecord } from './audit.interface';
import { MIN_PEPPER_LENGTH } from './evidence-bundle';
import { BondsService } from '../bonds/bonds.service';
import {
  BondLifecycleBundle,
  BondLifecyclePath,
  BondLifecycleStage,
  LifecycleEvidenceEvent,
  buildBondLifecycleBundle,
  stableStringify,
} from './bond-lifecycle-bundle-core';

const MAX_AUDIT_DERIVED_EVENTS = 250;

const RETRY_ACTION = /(retry|retried|reconcil|idempot|duplicate|resume|in[ -]?doubt|reapply|recover)/i;
const AUTH_ACTION = /(auth|admin|permission|permit|role|guard|kyc|signature|approve|grant)/i;
const FAILURE_ACTION = /(fail|reject|deny|denied|error|invalid|forbid|underfund|exceed|insufficient)/i;

function classifyPath(action: string): BondLifecyclePath {
  if (RETRY_ACTION.test(action)) return 'retry';
  if (AUTH_ACTION.test(action)) return 'authorization';
  if (FAILURE_ACTION.test(action)) return 'failure';
  return 'normal';
}

function classifyStage(action: string): BondLifecycleStage {
  if (/coupon|credit|claim|report/i.test(action)) return 'coupon';
  if (/redeem|retire|mature|payout|settle/i.test(action)) return 'redeem';
  if (/subscribe|holder|transfer/i.test(action)) return 'subscribe';
  return 'issue';
}

function minorUnits(value: unknown, label: string): string {
  let text: string;
  if (typeof value === 'bigint') text = value.toString();
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new BadRequestException(`${label} is not a safe integer`);
    text = BigInt(value).toString();
  } else if (typeof value === 'string') text = value;
  else text = '0';
  if (!/^\d+$/.test(text) || text.length > 64) {
    throw new BadRequestException(`${label} must be a non-negative minor-unit string`);
  }
  return text;
}

function hexDigest(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex');
}

@Injectable()
export class BondLifecycleAuditBundleService {
  constructor(
    private readonly audit: AuditService,
    private readonly bonds: BondsService,
  ) {}

  async build(
    bondId: number,
    caseId: string,
    asOf: string,
    generatedBy: string,
  ): Promise<BondLifecycleBundle> {
    if (!Number.isInteger(bondId) || bondId < 0) throw new BadRequestException('bondId must be a non-negative integer');
    if (typeof caseId !== 'string' || !caseId.trim()) throw new BadRequestException('caseId is required');
    if (typeof asOf !== 'string' || Number.isNaN(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf) {
      throw new BadRequestException('asOf must be an ISO-8601 timestamp');
    }
    if (typeof generatedBy !== 'string' || !generatedBy.trim()) {
      throw new BadRequestException('An authenticated exporter is required');
    }

    const pepper = process.env.AUDIT_EVIDENCE_PEPPER ?? '';
    if (pepper.length < MIN_PEPPER_LENGTH) {
      throw new ServiceUnavailableException('Evidence export is not configured (AUDIT_EVIDENCE_PEPPER)');
    }

    const generatedByDigest = hexDigest(generatedBy, pepper);
    const entityId = String(bondId);
    const raw = (await this.bonds.exportBond(bondId, generatedBy)) as Record<string, any>;
    const history = this.audit.getEntityHistory('bond', entityId);
    const verification = await this.audit.verifyEntity('bond', entityId);

    const rawBody = {
      bond: raw.bond ?? {},
      lifecycleEvents: raw.lifecycleEvents ?? [],
      holders: raw.holders ?? [],
      couponDistributions: raw.couponDistributions ?? [],
      retirements: raw.retirements ?? [],
    };
    const rawExport = {
      checksum: createHash('sha256').update(stableStringify(rawBody)).digest('hex'),
      counts: {
        lifecycleEvents: rawBody.lifecycleEvents.length,
        holders: rawBody.holders.length,
        couponDistributions: rawBody.couponDistributions.length,
        retirements: rawBody.retirements.length,
      },
    };

    const events: LifecycleEvidenceEvent[] = this.eventsFromExport(rawBody, generatedByDigest, bondId, caseId, asOf);
    events.push(...this.eventsFromAudit(history.slice(-MAX_AUDIT_DERIVED_EVENTS), pepper));
    events.push({
      stage: 'issue',
      path: 'authorization',
      action: 'audit-bundle-admin-guard',
      outcome: 'applied',
      dedupeKey: `bundle-access:${bondId}:${caseId}:${asOf}`,
      actorDigest: generatedByDigest,
      detail: 'JwtAuthGuard+AdminGuard',
    });

    const bond = rawBody.bond as Record<string, unknown>;
    const holders = rawBody.holders as Array<Record<string, unknown>>;
    const retirements = rawBody.retirements as Array<Record<string, unknown>>;
    const financialState = {
      totalSupplyMinor: minorUnits(bond.totalSupply, 'bond.totalSupply'),
      totalSubscribedMinor: minorUnits(bond.totalSubscribed, 'bond.totalSubscribed'),
      holderBalancesMinor: holders.map((holder, i) => minorUnits(holder.balance, `holders[${i}].balance`)),
      redemptionAmountsMinor: retirements.map((record, i) => minorUnits(record.amount, `retirements[${i}].amount`)),
      faceValueMinor: minorUnits(bond.faceValue, 'bond.faceValue'),
    };

    let bundle: BondLifecycleBundle;
    try {
      bundle = buildBondLifecycleBundle({
        bondId,
        caseId,
        asOf,
        generatedByDigest,
        events,
        financialState,
        sourceChain: {
          entityType: 'bond',
          entityId,
          chainHead: this.audit.getChainHead('bond', entityId),
          verification: {
            ok: verification.ok,
            checkedEntries: verification.checkedEntries,
            failures: verification.failures.map((failure) => ({
              index: failure.failedIndex,
              reason: failure.reason,
            })),
          },
        },
        rawExport,
        redactions: [
          { path: 'generatedByDigest', rule: 'actor' },
          { path: 'events[*].actorDigest', rule: 'actor' },
        ],
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid lifecycle bundle input');
    }

    await this.audit.record({
      entityType: 'bond-lifecycle-bundle',
      entityId: caseId,
      action: 'export',
      actor: generatedBy,
      before: null,
      after: {
        bundleId: bundle.bundleId,
        bondId,
        asOf,
        digest: bundle.digest,
        chainHead: bundle.lifecycle.chainHead,
      },
    });
    return bundle;
  }

  private eventsFromExport(
    raw: Record<string, any>,
    actorDigest: string,
    bondId: number,
    caseId: string,
    asOf: string,
  ): LifecycleEvidenceEvent[] {
    const events: LifecycleEvidenceEvent[] = [];
    const bond = raw.bond as Record<string, unknown>;
    const dedupeScope = `${bondId}:${caseId}:${asOf}`;

    for (const entry of raw.lifecycleEvents as Array<Record<string, any>>) {
      const name = String(entry.event ?? '').toUpperCase();
      if (name.includes('ISSUED')) {
        events.push({
          stage: 'issue',
          path: 'normal',
          action: 'bond-issued',
          outcome: 'applied',
          dedupeKey: `issued:${dedupeScope}`,
          actorDigest,
          amountMinorUnits: minorUnits(bond.totalSupply, 'bond.totalSupply'),
        });
      } else if (name.includes('MATURED')) {
        events.push({
          stage: 'redeem',
          path: 'normal',
          action: 'bond-matured',
          outcome: 'observed',
          dedupeKey: `matured:${dedupeScope}`,
          actorDigest,
        });
      } else if (name.includes('SUBSCRIBED')) {
        events.push({
          stage: 'subscribe',
          path: 'normal',
          action: 'bond-subscribed',
          outcome: 'applied',
          dedupeKey: `subscribed:${dedupeScope}`,
          actorDigest,
          amountMinorUnits: minorUnits(bond.totalSubscribed, 'bond.totalSubscribed'),
        });
      }
    }

    if (Number(bond.totalSubscribed ?? 0) > 0 || (raw.holders as unknown[]).length > 0) {
      events.push({
        stage: 'subscribe',
        path: 'normal',
        action: 'holder-register-observed',
        outcome: 'observed',
        dedupeKey: `holder-register:${dedupeScope}`,
        actorDigest,
        amountMinorUnits: minorUnits(bond.totalSubscribed, 'bond.totalSubscribed'),
      });
    }

    (raw.couponDistributions as Array<Record<string, unknown>>).forEach((period, i) => {
      events.push({
        stage: 'coupon',
        path: 'normal',
        action: 'coupon-distributed',
        outcome: 'applied',
        dedupeKey: `coupon:${dedupeScope}:${String(period.periodIndex ?? i)}`,
        actorDigest,
        amountMinorUnits: minorUnits(period.totalCreditsEarned, `couponDistributions[${i}].totalCreditsEarned`),
        detail: `period=${String(period.periodIndex ?? i)}`,
      });
    });

    (raw.retirements as Array<Record<string, unknown>>).forEach((record, i) => {
      events.push({
        stage: 'redeem',
        path: 'normal',
        action: 'credit-retired',
        outcome: 'applied',
        dedupeKey: `retirement:${dedupeScope}:${String(record.id ?? i)}`,
        actorDigest,
        amountMinorUnits: minorUnits(record.amount, `retirements[${i}].amount`),
        detail: `retirement=${String(record.id ?? i)}`,
      });
    });

    return events;
  }

  private eventsFromAudit(history: AuditRecord[], pepper: string): LifecycleEvidenceEvent[] {
    return history.map((entry) => {
      const path = classifyPath(entry.action);
      const rejected = FAILURE_ACTION.test(entry.action) || /(denied|rejected|forbidden|failed)/i.test(entry.action);
      return {
        stage: classifyStage(`${entry.entityType} ${entry.action}`),
        path,
        action: entry.action.slice(0, 200),
        outcome: (path === 'failure' ? 'rejected' : path === 'retry' ? 'observed' : rejected ? 'rejected' : 'applied') as const,
        dedupeKey: `audit:${entry.entityType}:${entry.entityId}:${entry.sequence}`.slice(0, 200),
        actorDigest: hexDigest(entry.actor, pepper),
        auditSequence: entry.sequence,
        auditHash: /^[0-9a-f]{64}$/.test(entry.hash) ? entry.hash : undefined,
      };
    });
  }
}
