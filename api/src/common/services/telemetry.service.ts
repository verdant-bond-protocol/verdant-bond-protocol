import { Injectable, Logger } from '@nestjs/common';

export interface TelemetryFields {
  operation: string;
  actorType: 'user' | 'service' | 'system' | 'admin';
  result: 'success' | 'failure' | 'partial';
  durationMs: number;
  correlationId: string;
  userId?: string;
  businessMetric?: Record<string, number | string>;
  error?: string;
  errorCode?: string;
  labels?: Record<string, string>;
  sampleRate?: number;
  isSampled?: boolean;
}

export interface TelemetryConfig {
  maxLabelCardinality?: number;
  sampleRateSuccess?: number;
  highVolumeThresholdPerMin?: number;
  criticalOperations?: string[];
  sensitiveKeys?: string[];
  /**
   * Injectable source of sampling randomness. Defaults to `Math.random`.
   * Supplying a deterministic function makes adaptive-sampling decisions
   * reproducible in tests and replayable incident investigations.
   */
  samplingRandom?: () => number;
}

/**
 * Reduces a request path to a bounded, dashboard-safe label value. Numeric
 * ids, UUIDs, Stellar addresses and opaque hashes/tokens are replaced with
 * placeholders; static route segments are preserved. Without this, every
 * request would create a new label series and defeat cardinality protection.
 */
export function normalizeTelemetryRoute(rawPath: string): string {
  const path = (rawPath ?? '').split('?')[0] || '/';
  return path
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d+$/.test(segment)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ':uuid';
      if (/^G[A-Z2-7]{20,60}$/.test(segment)) return ':address';
      if (/^[A-Za-z0-9_-]{20,}$/.test(segment)) return ':token';
      return segment;
    })
    .join('/');
}

export interface TelemetryStats {
  totalEmitted: number;
  totalSampledOut: number;
  cardinalityClampedCount: number;
  redactedFieldCount: number;
  activeLabelsByMetric: Record<string, number>;
}

const DEFAULT_SENSITIVE_KEYS = [
  'password',
  'secret',
  'token',
  'jwt',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'seed',
  'nationalid',
  'national_id',
  'ssn',
  'passport',
  'taxid',
  'tax_id',
  'credential',
];

const STELLAR_SECRET_REGEX = /S[A-Z0-9]{55}/g;
const JWT_TOKEN_REGEX = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const EMAIL_REGEX = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;
const LABEL_KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger('TELEMETRY');

  private readonly maxLabelCardinality: number;
  private sampleRateSuccess: number;
  private readonly highVolumeThresholdPerMin: number;
  private readonly criticalOperations: Set<string>;
  private readonly sensitiveKeySet: Set<string>;
  private readonly samplingRandom: () => number;

  // High cardinality label tracking: Map<metricKey, Set<labelValue>>
  private readonly labelCardinalityTracker = new Map<string, Set<string>>();

  // Sliding window volume tracker
  private requestWindowStart = Date.now();
  private requestCountInWindow = 0;

  // Telemetry metrics
  private stats: TelemetryStats = {
    totalEmitted: 0,
    totalSampledOut: 0,
    cardinalityClampedCount: 0,
    redactedFieldCount: 0,
    activeLabelsByMetric: {},
  };

  constructor(config: TelemetryConfig = {}) {
    this.maxLabelCardinality = config.maxLabelCardinality ?? 100;
    this.sampleRateSuccess = config.sampleRateSuccess ?? 1.0;
    this.highVolumeThresholdPerMin = config.highVolumeThresholdPerMin ?? 1000;
    this.criticalOperations = new Set(
      config.criticalOperations ?? [
        'bond_issuance',
        'coupon_distribution',
        'settlement',
        'governance_vote',
        'kyc_verification',
        'oracle_update',
      ],
    );
    this.sensitiveKeySet = new Set(
      (config.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS).map((k) => k.toLowerCase()),
    );
    this.samplingRandom = config.samplingRandom ?? Math.random;
  }

  emit(fields: TelemetryFields): boolean {
    this.updateVolumeWindow();

    // 1. Sampling Decision
    const shouldSample = this.evaluateSampling(fields);
    if (!shouldSample) {
      this.stats.totalSampledOut++;
      return false;
    }

    // 2. High-Cardinality Label Protection
    const protectedLabels = this.protectLabels(fields.operation, fields.labels);

    // 3. Sensitive Data Redaction
    const sanitized = this.sanitizeFields({
      ...fields,
      labels: protectedLabels,
      sampleRate: this.calculateCurrentSampleRate(fields),
      isSampled: true,
    });

    this.stats.totalEmitted++;
    this.logger.log(JSON.stringify(sanitized));
    return true;
  }

  private evaluateSampling(fields: TelemetryFields): boolean {
    // ALWAYS retain 100% of failures, errors, or critical protocol operations
    if (fields.result === 'failure' || fields.result === 'partial' || fields.error) {
      return true;
    }
    if (this.criticalOperations.has(fields.operation)) {
      return true;
    }

    // Adaptive sampling based on load volume
    const effectiveRate = this.calculateCurrentSampleRate(fields);
    if (effectiveRate >= 1.0) {
      return true;
    }
    return this.samplingRandom() < effectiveRate;
  }

  private calculateCurrentSampleRate(fields: TelemetryFields): number {
    if (fields.result === 'failure' || fields.result === 'partial' || fields.error) {
      return 1.0;
    }
    if (this.criticalOperations.has(fields.operation)) {
      return 1.0;
    }

    // Under abusive input volume, dynamically reduce sampling rate
    if (this.requestCountInWindow > this.highVolumeThresholdPerMin) {
      const reductionFactor = this.highVolumeThresholdPerMin / this.requestCountInWindow;
      return Math.max(0.01, Math.min(this.sampleRateSuccess, reductionFactor));
    }

    return this.sampleRateSuccess;
  }

  private updateVolumeWindow(): void {
    const now = Date.now();
    if (now - this.requestWindowStart >= 60000) {
      this.requestWindowStart = now;
      this.requestCountInWindow = 1;
    } else {
      this.requestCountInWindow++;
    }
  }

  private protectLabels(
    operation: string,
    labels?: Record<string, string>,
  ): Record<string, string> | undefined {
    if (!labels) return undefined;

    const result: Record<string, string> = {};

    for (const [key, rawVal] of Object.entries(labels)) {
      // Reject unsafe label keys (reject metric label injection)
      if (!LABEL_KEY_REGEX.test(key)) {
        this.stats.cardinalityClampedCount++;
        continue;
      }

      // Redact sensitive values from label values first
      const cleanVal = this.redactString(String(rawVal));

      // Track cardinality per operation + label key
      const trackerKey = `${operation}:${key}`;
      let knownValues = this.labelCardinalityTracker.get(trackerKey);
      if (!knownValues) {
        knownValues = new Set<string>();
        this.labelCardinalityTracker.set(trackerKey, knownValues);
      }

      if (knownValues.has(cleanVal)) {
        result[key] = cleanVal;
      } else if (knownValues.size < this.maxLabelCardinality) {
        knownValues.add(cleanVal);
        result[key] = cleanVal;
        this.stats.activeLabelsByMetric[trackerKey] = knownValues.size;
      } else {
        // Cardinality limit reached: bucket into __other__ to preserve dashboard viability
        this.stats.cardinalityClampedCount++;
        result[key] = '__other__';
      }
    }

    return result;
  }

  private sanitizeFields(fields: TelemetryFields): Partial<TelemetryFields> {
    const { userId, businessMetric, error, labels, ...rest } = fields;

    return {
      ...rest,
      ...(userId && { userId: this.redactUserId(userId) }),
      ...(businessMetric && {
        businessMetric: this.redactObject(businessMetric) as Record<string, number | string>,
      }),
      ...(error && { error: this.redactString(error) }),
      ...(labels && { labels }),
    };
  }

  private redactUserId(userId: string): string {
    // If userId looks like a secret seed or email, redact it
    if (/S[A-Z0-9]{55,}/.test(userId)) {
      this.stats.redactedFieldCount++;
      return '[REDACTED_STELLAR_SECRET]';
    }
    if (/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/.test(userId)) {
      this.stats.redactedFieldCount++;
      return '[REDACTED_EMAIL]';
    }
    return userId;
  }

  redactString(text: string): string {
    let result = text;
    result = result.replace(/S[A-Z0-9]{55,}/g, () => {
      this.stats.redactedFieldCount++;
      return '[REDACTED_STELLAR_SECRET]';
    });
    result = result.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, () => {
      this.stats.redactedFieldCount++;
      return '[REDACTED_JWT]';
    });
    result = result.replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, () => {
      this.stats.redactedFieldCount++;
      return '[REDACTED_EMAIL]';
    });
    return result;
  }

  redactObject(obj: any): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') return this.redactString(obj);
    if (typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactObject(item));
    }

    const cleaned: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (this.sensitiveKeySet.has(lowerKey)) {
        cleaned[key] = '[REDACTED_SENSITIVE]';
        this.stats.redactedFieldCount++;
      } else if (typeof val === 'string') {
        cleaned[key] = this.redactString(val);
      } else if (typeof val === 'object') {
        cleaned[key] = this.redactObject(val);
      } else {
        cleaned[key] = val;
      }
    }
    return cleaned;
  }

  getStats(): TelemetryStats {
    return { ...this.stats };
  }

  setSampleRate(rate: number): void {
    this.sampleRateSuccess = Math.max(0, Math.min(1.0, rate));
  }

  resetStats(): void {
    this.stats = {
      totalEmitted: 0,
      totalSampledOut: 0,
      cardinalityClampedCount: 0,
      redactedFieldCount: 0,
      activeLabelsByMetric: {},
    };
    this.labelCardinalityTracker.clear();
    this.requestCountInWindow = 0;
  }
}
