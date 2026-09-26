/**
 * Tests for Privacy-Preserving Analytics Service
 * Closes #271
 */

import { PrivacyPreservingAnalyticsService } from './privacy-preserving-analytics.service';

describe('PrivacyPreservingAnalyticsService', () => {
  let service: PrivacyPreservingAnalyticsService;

  beforeEach(() => {
    service = new PrivacyPreservingAnalyticsService();
  });

  describe('recordEvent', () => {
    it('should accept event with safe dimensions only', () => {
      const event = {
        eventType: 'bond_created',
        timestamp: new Date(),
        dimensions: {
          bond_type: 'green',
          status: 'success',
        },
        metrics: {
          count: 1,
          duration_ms: 150,
        },
      };

      expect(() => service.recordEvent(event)).not.toThrow();
    });

    it('should filter out unsafe dimensions', () => {
      const event = {
        eventType: 'bond_created',
        timestamp: new Date(),
        dimensions: {
          bond_type: 'green',
          user_email: 'user@example.com', // Should be filtered
          investor_address: 'GDHX...', // Should be filtered
        },
        metrics: {
          count: 1,
        },
      };

      service.recordEvent(event);
      const metrics = service.getAggregatedMetrics();
      expect(metrics[0].dimensions).not.toHaveProperty('user_email');
      expect(metrics[0].dimensions).not.toHaveProperty('investor_address');
    });

    it('should filter out unsafe metrics', () => {
      const event = {
        eventType: 'transaction',
        timestamp: new Date(),
        dimensions: {
          status: 'success',
        },
        metrics: {
          count: 1,
          secret_value: 12345, // Should be filtered
        },
      };

      service.recordEvent(event);
      const metrics = service.getAggregatedMetrics();
      expect(metrics[0].sum).not.toHaveProperty('secret_value');
    });
  });

  describe('aggregation', () => {
    it('should aggregate events by period and dimensions', () => {
      const timestamp = new Date();
      
      service.recordEvent({
        eventType: 'bond_created',
        timestamp,
        dimensions: { bond_type: 'green', status: 'success' },
        metrics: { count: 1, duration_ms: 100 },
      });

      service.recordEvent({
        eventType: 'bond_created',
        timestamp,
        dimensions: { bond_type: 'green', status: 'success' },
        metrics: { count: 1, duration_ms: 200 },
      });

      const metrics = service.getAggregatedMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0].count).toBe(2);
      expect(metrics[0].avg.duration_ms).toBe(150);
    });

    it('should calculate min, max, avg correctly', () => {
      const timestamp = new Date();

      service.recordEvent({
        eventType: 'test',
        timestamp,
        dimensions: { status: 'success' },
        metrics: { duration_ms: 100 },
      });

      service.recordEvent({
        eventType: 'test',
        timestamp,
        dimensions: { status: 'success' },
        metrics: { duration_ms: 300 },
      });

      service.recordEvent({
        eventType: 'test',
        timestamp,
        dimensions: { status: 'success' },
        metrics: { duration_ms: 200 },
      });

      const metrics = service.getAggregatedMetrics();
      expect(metrics[0].min.duration_ms).toBe(100);
      expect(metrics[0].max.duration_ms).toBe(300);
      expect(metrics[0].avg.duration_ms).toBe(200);
    });

    it('should separate aggregations by different dimensions', () => {
      const timestamp = new Date();

      service.recordEvent({
        eventType: 'bond_created',
        timestamp,
        dimensions: { bond_type: 'green' },
        metrics: { count: 1 },
      });

      service.recordEvent({
        eventType: 'bond_created',
        timestamp,
        dimensions: { bond_type: 'sustainability' },
        metrics: { count: 1 },
      });

      const metrics = service.getAggregatedMetrics();
      expect(metrics).toHaveLength(2);
    });
  });

  describe('privacy helpers', () => {
    it('should hash identifiers consistently', () => {
      const identifier = 'user123';
      const salt = 'test-salt';

      const hash1 = service.hashIdentifier(identifier, salt);
      const hash2 = service.hashIdentifier(identifier, salt);

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(identifier);
      expect(hash1.length).toBe(16);
    });

    it('should hash different identifiers differently', () => {
      const salt = 'test-salt';
      const hash1 = service.hashIdentifier('user1', salt);
      const hash2 = service.hashIdentifier('user2', salt);

      expect(hash1).not.toBe(hash2);
    });

    it('should round amounts to buckets', () => {
      expect(service.roundAmount(1234, 1000)).toBe(1000);
      expect(service.roundAmount(5678, 1000)).toBe(5000);
      expect(service.roundAmount(999, 1000)).toBe(0);
    });

    it('should bucket durations correctly', () => {
      expect(service.bucketDuration(50)).toBe('<100ms');
      expect(service.bucketDuration(250)).toBe('100-500ms');
      expect(service.bucketDuration(750)).toBe('500ms-1s');
      expect(service.bucketDuration(3000)).toBe('1-5s');
      expect(service.bucketDuration(7000)).toBe('5-10s');
      expect(service.bucketDuration(15000)).toBe('>10s');
    });
  });

  describe('domain-specific recording', () => {
    it('should record bond issuance without PII', () => {
      service.recordBondIssuance({
        bondType: 'green',
        amountUsd: 1234567,
        durationMs: 1500,
        status: 'success',
      });

      const metrics = service.getAggregatedMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0].eventType).toBe('bond_issuance');
      expect(metrics[0].dimensions.bond_type).toBe('green');
      expect(metrics[0].metrics.amount_usd_rounded).toBe(1234000);
    });

    it('should record investor activity without identity', () => {
      service.recordInvestorActivity({
        activityType: 'purchase',
        durationMs: 500,
        success: true,
      });

      const metrics = service.getAggregatedMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0].eventType).toBe('investor_activity');
      expect(metrics[0].dimensions).not.toHaveProperty('investor_id');
      expect(metrics[0].metrics.success_count).toBe(1);
    });
  });

  describe('getAggregatedMetrics', () => {
    it('should filter by period range', () => {
      const date1 = new Date('2024-01-01T10:00:00Z');
      const date2 = new Date('2024-01-01T12:00:00Z');

      service.recordEvent({
        eventType: 'test',
        timestamp: date1,
        dimensions: { status: 'success' },
        metrics: { count: 1 },
      });

      service.recordEvent({
        eventType: 'test',
        timestamp: date2,
        dimensions: { status: 'success' },
        metrics: { count: 1 },
      });

      const startPeriod = new Date('2024-01-01T11:00:00Z').toISOString();
      const metrics = service.getAggregatedMetrics(startPeriod);

      expect(metrics).toHaveLength(1);
      expect(new Date(metrics[0].period).getTime()).toBeGreaterThanOrEqual(
        new Date(startPeriod).getTime(),
      );
    });
  });

  describe('clearOldAggregations', () => {
    it('should remove old aggregations', () => {
      const oldDate = new Date('2024-01-01T10:00:00Z');
      const newDate = new Date('2024-01-02T10:00:00Z');

      service.recordEvent({
        eventType: 'test',
        timestamp: oldDate,
        dimensions: { status: 'success' },
        metrics: { count: 1 },
      });

      service.recordEvent({
        eventType: 'test',
        timestamp: newDate,
        dimensions: { status: 'success' },
        metrics: { count: 1 },
      });

      const cutoff = new Date('2024-01-02T00:00:00Z');
      service.clearOldAggregations(cutoff);

      const metrics = service.getAggregatedMetrics();
      expect(metrics).toHaveLength(1);
      expect(new Date(metrics[0].period).getTime()).toBeGreaterThanOrEqual(
        cutoff.getTime(),
      );
    });
  });
});
