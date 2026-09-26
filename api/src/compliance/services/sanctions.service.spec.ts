import { SanctionsService } from './sanctions.service';

describe('SanctionsService', () => {
  let service: SanctionsService;

  beforeEach(() => {
    service = new SanctionsService();
  });

  describe('Sanctions Screening & Verification', () => {
    it('identifies sanctioned wallet addresses', () => {
      const sanctioned = 'GSANCTIONEDWALLETOFAC0000000000000000000000000000000000000';
      const result = service.checkSanctions(sanctioned, 'US');

      expect(result.sanctioned).toBe(true);
      expect(result.reason).toContain('listed on active sanctions lists');
    });

    it('identifies embargoed / comprehensively sanctioned countries', () => {
      const cleanAddress = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
      const result = service.checkSanctions(cleanAddress, 'KP'); // North Korea

      expect(result.sanctioned).toBe(true);
      expect(result.reason).toContain('subject to comprehensive international sanctions');
    });

    it('passes clean address in non-sanctioned jurisdiction', () => {
      const cleanAddress = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
      const result = service.checkSanctions(cleanAddress, 'US');

      expect(result.sanctioned).toBe(false);
    });
  });

  describe('Periodic Refresh Cadence & Staleness Alerting', () => {
    it('documents daily refresh cadence (0 0 * * *) and initial non-stale status', () => {
      const status = service.getStatus();

      expect(status.refreshCadence).toBe('0 0 * * *');
      expect(status.maxStalenessHours).toBe(24);
      expect(status.isStale).toBe(false);
      expect(status.entryCount).toBeGreaterThan(0);
      expect(status.alertRaised).toBe(false);
    });

    it('flags staleness and raises alerts when last refresh exceeds maxStalenessHours', () => {
      // Simulate last refresh 25 hours ago
      service.simulateStaleness(25);

      expect(service.isStale()).toBe(true);

      const status = service.getStatus();
      expect(status.isStale).toBe(true);
      expect(status.alertRaised).toBe(true);
    });

    it('refreshes sanctions list and clears staleness', async () => {
      // Set to stale
      service.simulateStaleness(30);
      expect(service.isStale()).toBe(true);

      const newAddress = 'GNEWLYSANCTIONEDADDRESS0000000000000000000000000000000';
      const status = await service.refreshSanctionsList({
        additionalAddresses: [newAddress],
      });

      expect(status.isStale).toBe(false);
      expect(status.alertRaised).toBe(false);
      expect(service.isSanctioned(newAddress)).toBe(true);
    });
  });
});
