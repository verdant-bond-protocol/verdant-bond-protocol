/**
 * Privacy-Preserving Analytics Service
 * 
 * Aggregates usage and reliability metrics without exposing
 * private user data, secrets, or sensitive payload content.
 * 
 * Closes #271
 */

import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

export interface AnalyticsEvent {
  eventType: string;
  timestamp: Date;
  dimensions: Record<string, string | number>;
  metrics: Record<string, number>;
}

export interface AggregatedMetrics {
  period: string;
  eventType: string;
  dimensions: Record<string, string>;
  count: number;
  sum: Record<string, number>;
  avg: Record<string, number>;
  min: Record<string, number>;
  max: Record<string, number>;
}

// Safe dimensions that don't expose PII
const SAFE_DIMENSIONS = new Set([
  'event_type',
  'status',
  'bond_type',
  'error_code',
  'http_status',
  'duration_bucket',
  'hour_of_day',
  'day_of_week',
  'country_code', // Aggregated only, never individual
]);

// Metrics that can be safely aggregated
const SAFE_METRICS = new Set([
  'count',
  'duration_ms',
  'amount_usd_rounded', // Rounded to prevent identification
  'response_size_bytes',
  'error_count',
  'success_count',
]);

@Injectable()
export class PrivacyPreservingAnalyticsService {
  private readonly logger = new Logger(PrivacyPreservingAnalyticsService.name);
  private readonly aggregations = new Map<string, AggregatedMetrics>();

  /**
   * Records an analytics event with privacy protection
   */
  recordEvent(event: Partial<AnalyticsEvent>): void {
    // Sanitize the event before recording
    const sanitizedEvent = this.sanitizeEvent(event);

    if (!sanitizedEvent) {
      this.logger.warn('Event rejected due to privacy violation');
      return;
    }

    // Aggregate the event
    this.aggregateEvent(sanitizedEvent);
  }

  /**
   * Sanitizes event to remove PII and sensitive data
   */
  private sanitizeEvent(event: Partial<AnalyticsEvent>): AnalyticsEvent | null {
    if (!event.eventType || !event.timestamp) {
      return null;
    }

    // Filter dimensions to only safe ones
    const safeDimensions: Record<string, string | number> = {};
    if (event.dimensions) {
      for (const [key, value] of Object.entries(event.dimensions)) {
        if (SAFE_DIMENSIONS.has(key)) {
          safeDimensions[key] = value;
        }
      }
    }

    // Filter metrics to only safe ones
    const safeMetrics: Record<string, number> = {};
    if (event.metrics) {
      for (const [key, value] of Object.entries(event.metrics)) {
        if (SAFE_METRICS.has(key)) {
          safeMetrics[key] = value;
        }
      }
    }

    return {
      eventType: event.eventType,
      timestamp: event.timestamp,
      dimensions: safeDimensions,
      metrics: safeMetrics,
    };
  }

  /**
   * Aggregates event data for privacy-preserving analytics
   */
  private aggregateEvent(event: AnalyticsEvent): void {
    const aggregationKey = this.getAggregationKey(event);
    let aggregation = this.aggregations.get(aggregationKey);

    if (!aggregation) {
      aggregation = {
        period: this.getPeriod(event.timestamp),
        eventType: event.eventType,
        dimensions: this.convertDimensionsToStrings(event.dimensions),
        count: 0,
        sum: {},
        avg: {},
        min: {},
        max: {},
      };
      this.aggregations.set(aggregationKey, aggregation);
    }

    // Update count
    aggregation.count++;

    // Update metrics
    for (const [metricName, value] of Object.entries(event.metrics)) {
      if (!aggregation.sum[metricName]) {
        aggregation.sum[metricName] = 0;
        aggregation.min[metricName] = value;
        aggregation.max[metricName] = value;
      }

      aggregation.sum[metricName] += value;
      aggregation.min[metricName] = Math.min(aggregation.min[metricName], value);
      aggregation.max[metricName] = Math.max(aggregation.max[metricName], value);
      aggregation.avg[metricName] = aggregation.sum[metricName] / aggregation.count;
    }
  }

  /**
   * Generates aggregation key for grouping
   */
  private getAggregationKey(event: AnalyticsEvent): string {
    const period = this.getPeriod(event.timestamp);
    const dimensionKey = Object.entries(event.dimensions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join('|');

    return `${period}|${event.eventType}|${dimensionKey}`;
  }

  /**
   * Gets time period for aggregation (hourly)
   */
  private getPeriod(timestamp: Date): string {
    const date = new Date(timestamp);
    date.setMinutes(0, 0, 0);
    return date.toISOString();
  }

  /**
   * Converts dimensions to strings for aggregation key
   */
  private convertDimensionsToStrings(
    dimensions: Record<string, string | number>,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(dimensions)) {
      result[key] = String(value);
    }
    return result;
  }

  /**
   * Gets aggregated metrics for a period
   */
  getAggregatedMetrics(
    startPeriod?: string,
    endPeriod?: string,
  ): AggregatedMetrics[] {
    const results: AggregatedMetrics[] = [];

    for (const aggregation of this.aggregations.values()) {
      // Filter by period if specified
      if (startPeriod && aggregation.period < startPeriod) {
        continue;
      }
      if (endPeriod && aggregation.period > endPeriod) {
        continue;
      }

      results.push({ ...aggregation });
    }

    return results;
  }

  /**
   * Hashes sensitive identifiers for k-anonymity
   */
  hashIdentifier(identifier: string, salt: string): string {
    return crypto
      .createHash('sha256')
      .update(`${identifier}${salt}`)
      .digest('hex')
      .substring(0, 16); // Truncate for storage efficiency
  }

  /**
   * Rounds monetary amounts to prevent identification
   */
  roundAmount(amount: number, bucketSize: number = 1000): number {
    return Math.floor(amount / bucketSize) * bucketSize;
  }

  /**
   * Groups duration into buckets for privacy
   */
  bucketDuration(durationMs: number): string {
    if (durationMs < 100) return '<100ms';
    if (durationMs < 500) return '100-500ms';
    if (durationMs < 1000) return '500ms-1s';
    if (durationMs < 5000) return '1-5s';
    if (durationMs < 10000) return '5-10s';
    return '>10s';
  }

  /**
   * Records bond issuance analytics without PII
   */
  recordBondIssuance(bondData: {
    bondType: string;
    amountUsd: number;
    durationMs: number;
    status: string;
  }): void {
    this.recordEvent({
      eventType: 'bond_issuance',
      timestamp: new Date(),
      dimensions: {
        bond_type: bondData.bondType,
        status: bondData.status,
        duration_bucket: this.bucketDuration(bondData.durationMs),
      },
      metrics: {
        count: 1,
        duration_ms: bondData.durationMs,
        amount_usd_rounded: this.roundAmount(bondData.amountUsd),
      },
    });
  }

  /**
   * Records investor activity without exposing investor identity
   */
  recordInvestorActivity(activityData: {
    activityType: string;
    durationMs: number;
    success: boolean;
  }): void {
    this.recordEvent({
      eventType: 'investor_activity',
      timestamp: new Date(),
      dimensions: {
        event_type: activityData.activityType,
        status: activityData.success ? 'success' : 'error',
        duration_bucket: this.bucketDuration(activityData.durationMs),
      },
      metrics: {
        count: 1,
        duration_ms: activityData.durationMs,
        [activityData.success ? 'success_count' : 'error_count']: 1,
      },
    });
  }

  /**
   * Clears old aggregations to manage memory
   */
  clearOldAggregations(olderThan: Date): void {
    const cutoffPeriod = this.getPeriod(olderThan);
    let removed = 0;

    for (const [key, aggregation] of this.aggregations.entries()) {
      if (aggregation.period < cutoffPeriod) {
        this.aggregations.delete(key);
        removed++;
      }
    }

    this.logger.debug(`Cleared ${removed} old aggregations`);
  }
}
