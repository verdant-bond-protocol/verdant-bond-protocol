import {
  OracleKeyring,
  overlapWindow,
  DuplicateKeyIdError,
  OracleKey,
} from './keyring';
import { signEvidence } from '../ipfs/evidence';

describe('Oracle key rotation with overlapping validity windows (#447)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const T0 = 1_700_000_000_000;

  const v1: OracleKey = {
    keyId: 'VERDANT_ORACLE_KEY_V1',
    secret: 'secret-one',
    validFromMs: T0,
    validUntilMs: null,
  };

  const payload = { project_id: 'VCS-1', carbon_sequestered: 1200 };

  it('signs and verifies with a single active key', () => {
    const keyring = new OracleKeyring([v1]);
    const signed = keyring.sign(payload, T0 + DAY);
    expect(signed.keyId).toBe(v1.keyId);
    expect(keyring.verify(payload, signed)).toEqual({ valid: true, keyId: v1.keyId });
  });

  it('rejects a tampered payload', () => {
    const keyring = new OracleKeyring([v1]);
    const signed = keyring.sign(payload, T0 + DAY);
    const result = keyring.verify({ ...payload, carbon_sequestered: 9999 }, signed);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Signature verification failed/);
  });

  it('rotates keys and keeps the retiring key valid through the overlap', () => {
    const start = new OracleKeyring([v1]);
    const v2: OracleKey = {
      keyId: 'VERDANT_ORACLE_KEY_V2',
      secret: 'secret-two',
      validFromMs: T0 + 10 * DAY,
      validUntilMs: null,
    };

    const { keyring, extended } = start.rotateKey(v2, 3 * DAY);
    const retiring = extended.find((key) => key.keyId === v1.keyId);
    expect(retiring?.validUntilMs).toBe(v2.validFromMs + 3 * DAY);

    const overlap = overlapWindow(
      retiring!,
      keyring.list().find((k) => k.keyId === v2.keyId)!,
    );
    expect(overlap).toEqual({
      startMs: v2.validFromMs,
      endMs: v2.validFromMs + 3 * DAY,
    });

    const justBeforeRotation = v2.validFromMs - 1000;
    const oldSignature = start.sign(payload, justBeforeRotation);
    expect(oldSignature.keyId).toBe(v1.keyId);

    const newSignature = keyring.sign(payload, v2.validFromMs + 1000);
    expect(newSignature.keyId).toBe(v2.keyId);

    // Both the in-flight old key and the new key verify inside the overlap.
    expect(keyring.verify(payload, oldSignature).valid).toBe(true);
    expect(keyring.verify(payload, newSignature).valid).toBe(true);
  });

  it('stops accepting the retired key once its window closes', () => {
    const start = new OracleKeyring([v1]);
    const v2: OracleKey = {
      keyId: 'VERDANT_ORACLE_KEY_V2',
      secret: 'secret-two',
      validFromMs: T0 + 10 * DAY,
      validUntilMs: null,
    };
    const { keyring } = start.rotateKey(v2, 3 * DAY);

    const afterOverlap = v2.validFromMs + 4 * DAY;
    const staleSignature = start.sign(payload, afterOverlap);
    expect(staleSignature.keyId).toBe(v1.keyId);

    const result = keyring.verify(payload, staleSignature);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/was not valid at/);
  });

  it('rejects a key that is not yet valid', () => {
    const keyring = new OracleKeyring([
      { keyId: 'FUTURE', secret: 's', validFromMs: T0 + 5 * DAY },
    ]);
    expect(keyring.keysValidAt(T0)).toHaveLength(0);
    expect(() => keyring.sign(payload, T0)).toThrow(/No oracle key valid/);
  });

  it('rejects an unknown key id', () => {
    const keyring = new OracleKeyring([v1]);
    const result = keyring.verify(payload, {
      keyId: 'NOPE',
      timestampMs: T0,
      signature: 'deadbeef',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Unknown oracle key id/);
  });

  it('accepts a signature from any key via verifyAny during overlap', () => {
    const start = new OracleKeyring([v1]);
    const v2: OracleKey = {
      keyId: 'V2',
      secret: 'secret-two',
      validFromMs: T0 + DAY,
      validUntilMs: null,
    };
    const { keyring } = start.rotateKey(v2, DAY);

    const oldSignature = start.sign(payload, T0 + DAY);
    const result = keyring.verifyAny(payload, [
      { keyId: 'V2', timestampMs: T0 + DAY, signature: 'bogus' },
      oldSignature,
    ]);
    expect(result).toEqual({ valid: true, keyId: v1.keyId });
  });

  it('reports failure when no supplied signature verifies', () => {
    const keyring = new OracleKeyring([v1]);
    const result = keyring.verifyAny(payload, [
      { keyId: v1.keyId, timestampMs: T0, signature: 'bogus' },
    ]);
    expect(result.valid).toBe(false);
  });

  it('uses the plain signEvidence HMAC so secrets stay symmetric-only', () => {
    const keyring = new OracleKeyring([v1]);
    const signed = keyring.sign(payload, T0);
    expect(signed.signature).toBe(signEvidence(payload, v1.secret));
  });

  it('rejects duplicate key ids and inverted windows', () => {
    expect(() => new OracleKeyring([v1, { ...v1 }])).toThrow(DuplicateKeyIdError);
    expect(
      () =>
        new OracleKeyring([
          { keyId: 'BAD', secret: 's', validFromMs: T0, validUntilMs: T0 },
        ]),
    ).toThrow();
  });

  it('rejects a negative overlap', () => {
    const keyring = new OracleKeyring([v1]);
    expect(() =>
      keyring.rotateKey(
        { keyId: 'V2', secret: 's', validFromMs: T0 + DAY },
        -1,
      ),
    ).toThrow(/overlapMs must be non-negative/);
  });
});
