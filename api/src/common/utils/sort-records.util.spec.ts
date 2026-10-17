import { BOND_STATUS_PRIORITY, sortRecords } from './sort-records.util';

const rec = (id: string, status: string, createdAt: string) => ({ id, status, createdAt });

describe('sortRecords', () => {
  it('sorts by status priority first', () => {
    const input = [
      rec('c', 'Matured', '2024-01-03'),
      rec('a', 'Active', '2024-01-01'),
      rec('b', 'Pending', '2024-01-02'),
    ];
    const result = sortRecords(input, BOND_STATUS_PRIORITY);
    expect(result.map((r) => r.status)).toEqual(['Active', 'Pending', 'Matured']);
  });

  it('sorts by createdAt ascending within same status', () => {
    const input = [
      rec('b', 'Active', '2024-01-05'),
      rec('a', 'Active', '2024-01-01'),
      rec('c', 'Active', '2024-01-03'),
    ];
    const result = sortRecords(input, BOND_STATUS_PRIORITY);
    expect(result.map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('sorts by id lexicographically when status and createdAt tie', () => {
    const ts = '2024-06-01T00:00:00Z';
    const input = [
      rec('bond-z', 'Active', ts),
      rec('bond-a', 'Active', ts),
      rec('bond-m', 'Active', ts),
    ];
    const result = sortRecords(input, BOND_STATUS_PRIORITY);
    expect(result.map((r) => r.id)).toEqual(['bond-a', 'bond-m', 'bond-z']);
  });

  it('places unknown statuses after all known statuses', () => {
    const input = [
      rec('x', 'UnknownFuture', '2024-01-01'),
      rec('y', 'Active', '2024-01-01'),
    ];
    const result = sortRecords(input, BOND_STATUS_PRIORITY);
    expect(result[0].status).toBe('Active');
    expect(result[1].status).toBe('UnknownFuture');
  });

  it('does not mutate the original array', () => {
    const input = [rec('b', 'Matured', '2024-01-02'), rec('a', 'Active', '2024-01-01')];
    const copy = [...input];
    sortRecords(input, BOND_STATUS_PRIORITY);
    expect(input).toEqual(copy);
  });

  it('returns empty array for empty input', () => {
    expect(sortRecords([], BOND_STATUS_PRIORITY)).toEqual([]);
  });

  it('handles Date objects in createdAt', () => {
    const input = [
      { id: 'b', status: 'Active', createdAt: new Date('2024-06-02') },
      { id: 'a', status: 'Active', createdAt: new Date('2024-06-01') },
    ];
    const result = sortRecords(input, BOND_STATUS_PRIORITY);
    expect(result[0].id).toBe('a');
  });
});
