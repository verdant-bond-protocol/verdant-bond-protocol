import { rareFailureFixtures } from './rare-failure.fixtures';

describe('rare failure fixtures', () => {
  it('is deterministic and covers each rare failure class', () => {
    expect(rareFailureFixtures(99)).toEqual(rareFailureFixtures(99));
    expect(rareFailureFixtures(99).map((fixture) => fixture.kind)).toEqual([
      'timeout',
      'partial_write',
      'retry_exhausted',
    ]);
  });
});
