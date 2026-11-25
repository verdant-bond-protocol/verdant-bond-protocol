import { CovenantNotificationFanout } from './notification-fanout';

describe('covenant notification fan-out', () => {
  it('deduplicates recipients and tracks delivery acknowledgements', () => {
    const fanout = new CovenantNotificationFanout();
    const [entry] = fanout.fanOut('c-1', ['ops', 'ops']);
    expect(fanout.list('c-1')).toHaveLength(1);
    fanout.deliver(entry.id, () => undefined);
    expect(fanout.acknowledge(entry.id).status).toBe('acknowledged');
  });
  it('records failures for retry and enforces authorization', () => {
    const fanout = new CovenantNotificationFanout((recipient) => recipient === 'ops');
    const [entry] = fanout.fanOut('c-2', ['ops']);
    expect(fanout.deliver(entry.id, () => { throw new Error('transport down'); }).status).toBe('failed');
    const unauthorized = new CovenantNotificationFanout(() => false);
    const [blocked] = unauthorized.fanOut('c-3', ['x']);
    expect(() => unauthorized.deliver(blocked.id, () => undefined)).toThrow(/authorized/);
  });
});

