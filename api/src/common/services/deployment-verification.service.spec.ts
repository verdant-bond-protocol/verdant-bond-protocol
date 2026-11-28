import { verifyRollback } from './deployment-verification.service';

describe('verifyRollback', () => {
  it('accepts an authorized rollback to the previous deployment', () => {
    expect(verifyRollback([
      { id: 'a', version: '1', status: 'deployed' },
      { id: 'b', version: '2', status: 'failed', rollbackTo: '1', authorizedBy: 'GADMIN' },
    ])).toEqual({ valid: true, errors: [] });
  });

  it.each([
    [{ id: 'b', version: '2', status: 'failed' as const }, 'rollback authorization is missing'],
    [{ id: 'b', version: '2', status: 'failed' as const, rollbackTo: '0', authorizedBy: 'GADMIN' }, 'rollback target does not match'],
  ])('rejects unsafe rollback plans', (failed, message) => {
    expect(verifyRollback([{ id: 'a', version: '1', status: 'deployed' }, failed]).errors.join(' ')).toContain(message);
  });
});
