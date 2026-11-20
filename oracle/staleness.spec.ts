import { computeStaleness, cadenceForMethodology, DEFAULT_GRACE_SECONDS } from './staleness';

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const CADENCE_GRACE_MS = (365 + DEFAULT_GRACE_SECONDS / (24 * 60 * 60)) * DAY;

describe('computeStaleness', () => {
  it('marks a project stale after the reporting window plus grace elapses', () => {
    const results = computeStaleness(
      [
        {
          projectId: 'VCS-1234',
          createdAt: new Date(NOW - 2 * CADENCE_GRACE_MS).toISOString(),
          lastVerifiedAt: new Date(NOW - CADENCE_GRACE_MS - DAY).toISOString(),
          cadenceSeconds: 365 * 24 * 60 * 60,
        },
      ],
      NOW,
    );

    expect(results[0].isStale).toBe(true);
    expect(results[0].stalenessSeconds).toBe((CADENCE_GRACE_MS + DAY) / 1000);
  });

  it('keeps a project healthy inside the window', () => {
    const results = computeStaleness(
      [
        {
          projectId: 'VCS-1234',
          createdAt: new Date(NOW - 2 * CADENCE_GRACE_MS).toISOString(),
          lastVerifiedAt: new Date(NOW - DAY).toISOString(),
          cadenceSeconds: 365 * 24 * 60 * 60,
        },
      ],
      NOW,
    );

    expect(results[0].isStale).toBe(false);
    expect(results[0].lastVerifiedAt).toBe(new Date(NOW - DAY).toISOString());
  });

  it('falls back to the project creation date when never verified', () => {
    const results = computeStaleness(
      [
        {
          projectId: 'VCS-9999',
          createdAt: new Date(NOW - CADENCE_GRACE_MS - DAY).toISOString(),
          cadenceSeconds: 365 * 24 * 60 * 60,
        },
      ],
      NOW,
    );

    expect(results[0].isStale).toBe(true);
    expect(results[0].lastVerifiedAt).toBeUndefined();
  });

  it('respects a custom grace period', () => {
    const graceSeconds = 7 * 24 * 60 * 60;
    const results = computeStaleness(
      [
        {
          projectId: 'VCS-1234',
          createdAt: new Date(NOW - 400 * DAY).toISOString(),
          lastVerifiedAt: new Date(NOW - (365 + 7) * DAY - DAY).toISOString(),
          cadenceSeconds: 365 * 24 * 60 * 60,
          graceSeconds,
        },
      ],
      NOW,
    );

    expect(results[0].isStale).toBe(true);
  });
});

describe('cadenceForMethodology', () => {
  it('uses an annual cadence by default', () => {
    expect(cadenceForMethodology('VERRA-VCS')).toBe(365 * 24 * 60 * 60);
  });

  it('uses quarterly cadence for remote sensing', () => {
    expect(cadenceForMethodology('REMOTE-SENSING')).toBe(90 * 24 * 60 * 60);
  });

  it('uses monthly cadence for IoT sensors', () => {
    expect(cadenceForMethodology('IOT-SENSORS')).toBe(30 * 24 * 60 * 60);
  });

  it('uses seasonal (90-day) cadence for BLUE-CARBON methodology', () => {
    expect(cadenceForMethodology('BLUE-CARBON')).toBe(90 * 24 * 60 * 60);
  });
});
