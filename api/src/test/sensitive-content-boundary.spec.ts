/**
 * Sensitive-content boundary tests (#382).
 *
 * Each block feeds hostile input across one trust boundary and asserts the
 * boundary holds: untrusted content cannot execute, escape its sandbox, leak a
 * private field, or bypass an allow-list. Rendering (the Angular side of the
 * boundary) is covered by frontend/src/app/shared/pipes/*.spec.ts.
 */
import { ForbiddenException } from '@nestjs/common';
import * as crypto from 'crypto';
import { ExportStreamPipeline } from '../exports/services/export-stream.pipeline';
import { ExportRole, ExportType, ExportableRecord } from '../exports/interfaces/export.interface';
import { WebhookVerificationService, WebhookVerificationConfig } from '../webhooks/webhook-verification.service';
import { IpfsUploadPolicy } from '../projects/ipfs-upload.policy';

describe('Sensitive-content boundaries (#382)', () => {
  describe('exports: private fields never leave the boundary', () => {
    const pipeline = new ExportStreamPipeline();
    const investor = { userId: 'alice', role: ExportRole.INVESTOR };

    const record = (data: Record<string, any>, owner: { ownerUserId?: string } = { ownerUserId: 'alice' }): ExportableRecord => ({
      id: 'rec-1',
      type: ExportType.PORTFOLIO,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      ...owner,
      data,
    });

    it('strips forbidden fields nested inside objects and arrays', () => {
      const sanitized = pipeline.sanitizeRecordForCaller(
        record({
          bondId: 7,
          investor: { name: 'Alice', ssn: '000-11-2222', kyc: { passportNumber: 'P-1', rawKycDocument: 'scan' } },
          signers: [{ address: 'GABC', privateKey: 'S-SECRET' }],
        }),
        investor,
      );

      const serialized = JSON.stringify(sanitized);
      expect(serialized).not.toMatch(/000-11-2222|P-1|scan|S-SECRET/);
      expect(sanitized.data).toEqual({ bondId: 7, investor: { name: 'Alice', kyc: {} }, signers: [{ address: 'GABC' }] });
    });

    it('matches forbidden field names case-insensitively', () => {
      const sanitized = pipeline.sanitizeRecordForCaller(
        record({ SSN: '000-11-2222', PrivateKey: 'S-SECRET', SIGNINGSEED: 'seed', memo: 'ok' }),
        investor,
      );
      expect(sanitized.data).toEqual({ memo: 'ok' });
    });

    it('does not let a "__proto__" key from parsed JSON rewrite the exported object', () => {
      const hostile = JSON.parse('{"__proto__": {"isAdmin": true}, "memo": "ok"}');
      const sanitized = pipeline.sanitizeRecordForCaller(record(hostile), investor);

      expect(Object.getPrototypeOf(sanitized.data)).toBe(Object.prototype);
      expect((sanitized.data as any).isAdmin).toBeUndefined();
      expect(sanitized.data).toEqual({ memo: 'ok' });
    });

    it('refuses an investor a record whose owner is unknown (fail closed)', () => {
      expect(() => pipeline.sanitizeRecordForCaller(record({ memo: 'x' }, {}), investor)).toThrow(
        ForbiddenException,
      );
    });

    it('keeps the role allow-list: an investor cannot stream KYC PII', async () => {
      async function* source() {
        yield [record({ ssn: '000-11-2222' })];
      }
      await expect(
        pipeline.streamExport('exp-1', ExportType.KYC_PII, source(), { caller: investor }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('never exports signing material, even to an admin', () => {
      const sanitized = pipeline.sanitizeRecordForCaller(
        record({ nested: { signingSeed: 'seed', privateKey: 'key' }, ssn: '000-11-2222' }),
        { userId: 'root', role: ExportRole.ADMIN },
      );
      expect(sanitized.data).toEqual({ nested: {}, ssn: '000-11-2222' });
    });
  });

  describe('webhooks: forged, tampered and replayed deliveries are rejected', () => {
    const config: WebhookVerificationConfig = {
      secret: 'webhook-secret',
      replayWindowMs: 60 * 60 * 1000, // 1h: wider than the service's 5-minute default
      signatureHeader: 'x-webhook-signature',
      timestampHeader: 'x-webhook-timestamp',
    };
    const sign = (id: string, timestamp: number, payload: unknown, secret = config.secret) =>
      crypto.createHmac('sha256', secret).update(`${id}.${timestamp}.${JSON.stringify(payload)}`).digest('hex');

    let service: WebhookVerificationService;
    beforeEach(() => {
      service = new WebhookVerificationService();
    });
    afterEach(() => jest.useRealTimers());

    it('rejects a replay at any point inside a configured window longer than the default', () => {
      jest.useFakeTimers({ now: new Date('2026-10-16T12:00:00Z') });
      const timestamp = Date.now();
      const payload = { event: 'coupon.distributed', bondId: 1 };
      const event = { id: 'evt-1', timestamp, payload, signature: sign('evt-1', timestamp, payload) };

      expect(service.verifyWebhook(event, config).valid).toBe(true);

      // 11 minutes later the old fixed 10-minute retention had already
      // forgotten the id, while the 1h window still accepted the timestamp.
      jest.setSystemTime(timestamp + 11 * 60 * 1000);
      expect(service.verifyWebhook(event, config)).toEqual({ valid: false, error: 'Event already processed', duplicate: true });

      jest.setSystemTime(timestamp + config.replayWindowMs);
      expect(service.verifyWebhook(event, config).valid).toBe(false);

      // Once the window has passed, the timestamp check rejects it on its own.
      jest.setSystemTime(timestamp + config.replayWindowMs + 1);
      expect(service.verifyWebhook(event, config)).toEqual({
        valid: false,
        error: 'Event timestamp outside replay window',
      });
    });

    it('rejects a payload tampered with after signing', () => {
      const timestamp = Date.now();
      const signature = sign('evt-2', timestamp, { amount: '10' });
      const result = service.verifyWebhook({ id: 'evt-2', timestamp, payload: { amount: '10000' }, signature }, config);
      expect(result).toEqual({ valid: false, error: 'Invalid signature' });
    });

    it('rejects a signature made with another secret', () => {
      const timestamp = Date.now();
      const payload = { amount: '10' };
      const result = service.verifyWebhook(
        { id: 'evt-3', timestamp, payload, signature: sign('evt-3', timestamp, payload, 'attacker-secret') },
        config,
      );
      expect(result.valid).toBe(false);
    });

    it('does not let an unsigned delivery burn a legitimate event id', () => {
      const timestamp = Date.now();
      const payload = { amount: '10' };
      service.verifyWebhook({ id: 'evt-4', timestamp, payload, signature: 'forged' }, config);

      const genuine = { id: 'evt-4', timestamp, payload, signature: sign('evt-4', timestamp, payload) };
      expect(service.verifyWebhook(genuine, config).valid).toBe(true);
    });

    it('answers a failed delivery without echoing the expected signature or secret', () => {
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();
      const timestamp = Date.now();
      const body = { id: 'evt-5', amount: '10' };

      service.createVerificationMiddleware(config)(
        { headers: { 'x-webhook-signature': 'forged', 'x-webhook-timestamp': String(timestamp) }, body },
        res,
        next,
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      const answered = JSON.stringify(res.json.mock.calls[0][0]);
      expect(answered).not.toContain(sign('evt-5', timestamp, body));
      expect(answered).not.toContain(config.secret);
    });
  });

  describe('downloads: published files cannot carry active content', () => {
    const policy = new IpfsUploadPolicy();
    const upload = (content: string, mimetype: string, filename: string) =>
      policy.validate({ buffer: Buffer.from(content), mimetype, filename });

    it('accepts a static SVG that only references its own fragments', async () => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<defs><path id="p" d="M0 0L1 1"/></defs><use xlink:href="#p"/></svg>';
      await expect(upload(svg, 'image/svg+xml', 'map.svg')).resolves.toBe('image/svg+xml');
    });

    it.each([
      ['a script element', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
      ['a namespaced script element', '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg:svg>'],
      ['an event handler', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
      ['an embedded HTML document', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://evil.example"/></foreignObject></svg>'],
      ['a javascript: link', '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a></svg>'],
      ['an entity-encoded javascript: link', '<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="&#106;avascript:alert(1)"><text>x</text></a></svg>'],
      ['an external reference', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.example/p.png"/></svg>'],
      ['an XML entity declaration', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>'],
    ])('rejects an SVG with %s', async (_label, svg) => {
      await expect(upload(svg, 'image/svg+xml', 'map.svg')).rejects.toMatchObject({ code: 'ACTIVE_CONTENT' });
    });

    it.each([
      ['an XML prolog that pushes the SVG past the sniff window', '<?xml version="1.0"?>\n<!-- ' + 'x'.repeat(80) + ' -->\n<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'application/octet-stream', 'a.bin'],
      ['XHTML with a script in a .txt', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>', 'text/plain', 'a.txt'],
      ['an animation that rewrites href to javascript:', '<svg xmlns="http://www.w3.org/2000/svg"><a><set attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>', 'image/svg+xml', 'a.svg'],
    ])('rejects %s', async (_label, content, mimetype, filename) => {
      await expect(upload(content, mimetype, filename)).rejects.toMatchObject({ code: 'ACTIVE_CONTENT' });
    });

    it('rejects active SVG smuggled under a generic binary type', async () => {
      await expect(
        upload('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', 'application/octet-stream', 'x.bin'),
      ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT' });
    });

    it.each([
      ['text/plain', 'notes.txt', '<!DOCTYPE html><html><script>alert(1)</script></html>'],
      ['text/plain', 'readme.md', '  \n<script>alert(1)</script>'],
      ['application/octet-stream', 'blob.bin', '<iframe src="https://evil.example"></iframe>'],
      ['text/plain', 'notes.txt', '<!-- x --><p>click</p>'],
    ])('rejects %s (%s) that a browser would sniff as HTML', async (mimetype, filename, content) => {
      await expect(upload(content, mimetype, filename)).rejects.toMatchObject({ code: 'ACTIVE_CONTENT' });
    });

    it('still accepts plain text and JSON that merely mention markup', async () => {
      await expect(upload('Use <b> for bold text.', 'text/plain', 'notes.txt')).resolves.toBe('text/plain');
      await expect(upload('Embed it with <svg onload=...> at your own risk.', 'text/plain', 'notes.txt')).resolves.toBe('text/plain');
      await expect(upload('{"note":"<script> is escaped"}', 'application/json', 'meta.json')).resolves.toBe(
        'application/json',
      );
    });

    it('keeps the executable-extension block-list ahead of type checks', async () => {
      await expect(upload('console.log(1)', 'text/plain', 'payload.js')).rejects.toMatchObject({
        code: 'BLOCKED_EXTENSION',
      });
    });
  });
});
