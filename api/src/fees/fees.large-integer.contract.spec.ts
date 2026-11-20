import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { FeesController } from './fees.controller';
import { FeesService } from './fees.service';
import { buildControllerApp } from '../test/controller-guard.harness';
import { TestRole } from '../test/guard-role-mocks';
import { createGlobalValidationPipe } from '../common/pipes/global-validation.pipe';
import { I128_MAX, MAX_MINOR_UNITS_STRING_LENGTH } from '../common/utils/bigint.util';

/**
 * API contract tests for large-integer financial values on `POST /fees/preview`
 * (see `docs/large-integer-financial-values.md`).
 *
 * The contract under test:
 *   - every amount crosses the wire as a base-10 digit string, in both
 *     directions, and is never rounded through an IEEE-754 double;
 *   - accepted amounts span [0, i128 max]; anything else is a 400 that never
 *     reaches the service;
 *   - the endpoint is deterministic, so a retry returns byte-identical output;
 *   - authentication is checked before the amount is even parsed.
 *
 * The app is booted with the production `ValidationPipe` (including
 * `enableImplicitConversion`) and the real `FeesService`, so these tests pin
 * observable HTTP behaviour rather than any one implementation detail.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const U64_MAX = (1n << 64n) - 1n;

/** Independent oracle for the published subscription schedule (0.50% + 0.10% min 10_000). */
function expectedSubscriptionFees(amount: bigint) {
  const bps = (rate: bigint) => (amount * rate + 5_000n) / 10_000n;
  const platform = bps(50n);
  const custodyRaw = bps(10n);
  const custody = custodyRaw < 10_000n ? 10_000n : custodyRaw;
  const sum = platform + custody;
  const total = sum > amount ? amount : sum;
  return { platform, custodyRaw, custody, total, net: amount - total };
}

/** Every `*MinorUnits` field anywhere in a breakdown, with its JSON path. */
function minorUnitFields(body: any): Array<[string, unknown]> {
  const fields: Array<[string, unknown]> = [];
  const walk = (node: any, path: string) => {
    if (Array.isArray(node)) node.forEach((child, i) => walk(child, `${path}[${i}]`));
    else if (node && typeof node === 'object') {
      Object.entries(node).forEach(([key, value]) => {
        if (key.endsWith('MinorUnits')) fields.push([`${path}.${key}`, value]);
        walk(value, `${path}.${key}`);
      });
    }
  };
  walk(body, '$');
  return fields;
}

describe('FeesController large-integer financial value contract', () => {
  let app: INestApplication;
  let previewSpy: jest.SpyInstance;

  beforeAll(async () => {
    app = await buildControllerApp(FeesController, [FeesService], (a) =>
      a.useGlobalPipes(createGlobalValidationPipe()),
    );
    previewSpy = jest.spyOn(app.get(FeesService), 'preview');
    // Bind once so concurrent requests share one listener instead of supertest
    // opening (and racing) an ephemeral server per request.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => previewSpy.mockClear());

  /** Posts a raw JSON body so tests control exactly what the client put on the wire. */
  const postRaw = (rawJson: string, role: TestRole = 'user') =>
    request(app.getHttpServer())
      .post('/fees/preview')
      .set('x-test-role', role)
      .set('content-type', 'application/json')
      .send(rawJson);

  const post = (body: Record<string, unknown>, role: TestRole = 'user') =>
    postRaw(JSON.stringify(body), role);

  describe('normal path: exact round-trip across precision boundaries', () => {
    const boundaries: Array<[string, bigint]> = [
      ['zero', 0n],
      ['one minor unit', 1n],
      ['Number.MAX_SAFE_INTEGER', MAX_SAFE],
      ['MAX_SAFE_INTEGER + 1', MAX_SAFE + 1n],
      ['MAX_SAFE_INTEGER + 2 (not representable as a double)', MAX_SAFE + 2n],
      ['u64 max', U64_MAX],
      ['u64 max + 1', U64_MAX + 1n],
      ['a 20-digit value a double would round', 12_345_678_901_234_567_891n],
      ['i128 max - 1', I128_MAX - 1n],
      ['i128 max', I128_MAX],
    ];

    it.each(boundaries)('%s prices exactly and echoes every amount as a string', async (_label, amount) => {
      const res = await post({ amountMinorUnits: amount.toString(), asset: 'USDC' }).expect(200);
      const expected = expectedSubscriptionFees(amount);

      expect(res.body).toEqual({
        inputAmountMinorUnits: amount.toString(),
        assetDecimals: 7,
        lines: [
          {
            code: 'platformFee',
            label: 'Platform fee',
            basisPoints: 50,
            rawAmountMinorUnits: expected.platform.toString(),
            amountMinorUnits: expected.platform.toString(),
            clamped: null,
          },
          {
            code: 'custodyFee',
            label: 'Custody & reporting fee',
            basisPoints: 10,
            rawAmountMinorUnits: expected.custodyRaw.toString(),
            amountMinorUnits: expected.custody.toString(),
            clamped: expected.custody !== expected.custodyRaw ? 'min' : null,
          },
        ],
        totalFeeMinorUnits: expected.total.toString(),
        netAmountMinorUnits: expected.net.toString(),
      });

      // Wire format, not just the parsed body: the input is a quoted JSON string.
      expect(res.text).toContain(`"inputAmountMinorUnits":"${amount}"`);
      minorUnitFields(res.body).forEach(([path, value]) => {
        expect({ path, type: typeof value }).toEqual({ path, type: 'string' });
        expect(value).toMatch(/^(0|[1-9]\d*)$/);
      });
    });

    it.each(['subscription', 'redemption', 'marketplace'] as const)(
      'the %s schedule conserves value at i128 max (total + net == input, no line exceeds input)',
      async (scheduleName) => {
        const res = await post({ amountMinorUnits: I128_MAX.toString(), asset: 'XLM', scheduleName }).expect(200);
        const total = BigInt(res.body.totalFeeMinorUnits);
        const net = BigInt(res.body.netAmountMinorUnits);

        expect(total + net).toBe(I128_MAX);
        expect(net).toBeGreaterThanOrEqual(0n);
        res.body.lines.forEach((line: { amountMinorUnits: string }) => {
          expect(BigInt(line.amountMinorUnits)).toBeLessThanOrEqual(I128_MAX);
        });
        expect(res.body.lines.reduce((s: bigint, l: any) => s + BigInt(l.amountMinorUnits), 0n)).toBe(total);
      },
    );

    it('canonicalizes zero-padded input without changing its value', async () => {
      const padded = '0'.repeat(MAX_MINOR_UNITS_STRING_LENGTH - 39) + I128_MAX.toString();
      expect(padded).toHaveLength(MAX_MINOR_UNITS_STRING_LENGTH);

      const res = await post({ amountMinorUnits: padded, asset: 'USDC' }).expect(200);
      expect(res.body.inputAmountMinorUnits).toBe(I128_MAX.toString());
    });
  });

  describe('failure path: rejected at the boundary, never priced', () => {
    const rejected: Array<[string, string]> = [
      // JSON numbers: JSON.parse may already have rounded these before any code runs.
      ['an unsafe JSON number', '12345678901234567891'],
      ['a safe JSON number', '1000'],
      ['a JSON number in exponent form', '1e21'],
      ['a fractional JSON number', '100.5'],
      ['a negative JSON number', '-1'],
      // Malformed strings.
      ['an empty string', '""'],
      ['a negative string', '"-1"'],
      ['an explicit plus sign', '"+1"'],
      ['a decimal string', '"100.0"'],
      ['an exponent string', '"1e21"'],
      ['a hex string', '"0x10"'],
      ['a BigInt literal suffix', '"100n"'],
      ['digit-group separators', '"1_000"'],
      ['surrounding whitespace', '" 100 "'],
      ['a trailing newline', '"100\\n"'],
      ['non-ASCII digits', '"١٢٣"'],
      // Out of range.
      ['i128 max + 1', `"${I128_MAX + 1n}"`],
      ['2^128', `"${1n << 128n}"`],
      ['an over-long zero-padded string', `"${'0'.repeat(MAX_MINOR_UNITS_STRING_LENGTH)}1"`],
      ['a 10k-digit string', `"${'9'.repeat(10_000)}"`],
      // Wrong JSON types.
      ['null', 'null'],
      ['a boolean', 'true'],
      ['an array of digits', '["100"]'],
      ['an object', '{"value":"100"}'],
    ];

    it.each(rejected)('%s → 400 with the stable error message', async (_label, rawAmount) => {
      const res = await postRaw(`{"amountMinorUnits":${rawAmount},"asset":"USDC"}`).expect(400);
      expect(res.body.message).toContain('amountMinorUnits must be a non-negative integer string');
      expect(previewSpy).not.toHaveBeenCalled();
    });

    it('a missing amount → 400', async () => {
      await post({ asset: 'USDC' }).expect(400);
      expect(previewSpy).not.toHaveBeenCalled();
    });

    it('does not echo the rejected value back (no lossy number leaks into the error)', async () => {
      const res = await postRaw('{"amountMinorUnits":12345678901234567891,"asset":"USDC"}').expect(400);
      expect(res.text).not.toContain('12345678901234567000');
      expect(res.text).not.toContain('12345678901234567891');
    });
  });

  describe('retry path: deterministic and safe to replay', () => {
    const body = { amountMinorUnits: (I128_MAX - 12_345n).toString(), asset: 'USDC', scheduleName: 'marketplace' };

    it('sequential retries return byte-identical responses', async () => {
      const first = await post(body).expect(200);
      for (let i = 0; i < 5; i++) {
        const retry = await post(body).expect(200);
        expect(retry.text).toBe(first.text);
      }
    });

    it('concurrent retries return byte-identical responses', async () => {
      const responses = await Promise.all(Array.from({ length: 10 }, () => post(body)));
      const texts = new Set(responses.map((r) => r.text));
      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(texts.size).toBe(1);
    });

    it('a client that sent a JSON number recovers by retrying with the same value as a string', async () => {
      const intended = '12345678901234567891';
      await postRaw(`{"amountMinorUnits":${intended},"asset":"USDC"}`).expect(400);

      const recovered = await post({ amountMinorUnits: intended, asset: 'USDC' }).expect(200);
      expect(recovered.body.inputAmountMinorUnits).toBe(intended);
      expect(recovered.body.totalFeeMinorUnits).toBe(
        expectedSubscriptionFees(BigInt(intended)).total.toString(),
      );
    });

    it('a rejected out-of-range request leaves no state behind that changes the next answer', async () => {
      const before = await post(body).expect(200);
      await post({ ...body, amountMinorUnits: (I128_MAX + 1n).toString() }).expect(400);
      const after = await post(body).expect(200);
      expect(after.text).toBe(before.text);
    });
  });

  describe('authorization path', () => {
    it('an unauthenticated caller is rejected with 401 before the amount is parsed', async () => {
      await post({ amountMinorUnits: I128_MAX.toString(), asset: 'USDC' }, 'anon').expect(401);
      expect(previewSpy).not.toHaveBeenCalled();
    });

    it('an unauthenticated caller with a malformed amount still gets 401, not a validation oracle', async () => {
      await postRaw('{"amountMinorUnits":12345678901234567891,"asset":"USDC"}', 'anon').expect(401);
      expect(previewSpy).not.toHaveBeenCalled();
    });

    it.each(['user', 'verified', 'provider', 'admin'] as TestRole[])(
      'an authenticated %s gets the same exact large-integer breakdown',
      async (role) => {
        const amount = (U64_MAX + 1n).toString();
        const res = await post({ amountMinorUnits: amount, asset: 'USDC' }, role).expect(200);
        expect(res.body.inputAmountMinorUnits).toBe(amount);
        expect(res.body.totalFeeMinorUnits).toBe(expectedSubscriptionFees(U64_MAX + 1n).total.toString());
      },
    );
  });
});
