import { IpfsUploadPolicy, FileScanHook } from './ipfs-upload.policy';

const PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.alloc(1024, 1),
]);

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100, 2),
]);

const OVERSIZED = Buffer.alloc(10 * 1024 * 1024 + 1, 7);

describe('IpfsUploadPolicy', () => {
  it('accepts a valid pdf with matching mime and extension', async () => {
    const policy = new IpfsUploadPolicy();
    const mime = await policy.validate({ buffer: PDF, mimetype: 'application/pdf', filename: 'report.pdf' });
    expect(mime).toBe('application/pdf');
  });

  it('accepts a valid png', async () => {
    const policy = new IpfsUploadPolicy();
    const mime = await policy.validate({ buffer: PNG, mimetype: 'image/png', filename: 'evidence.png' });
    expect(mime).toBe('image/png');
  });

  describe('size', () => {
    it('rejects oversized files before upload', async () => {
      const policy = new IpfsUploadPolicy();
      await expect(
        policy.validate({ buffer: OVERSIZED, mimetype: 'application/pdf', filename: 'big.pdf' }),
      ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    });

    it('honors a custom size limit', async () => {
      const policy = new IpfsUploadPolicy({ maxFileBytes: 100 });
      await expect(
        policy.validate({ buffer: PDF, mimetype: 'application/pdf', filename: 'report.pdf' }),
      ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    });

    it('rejects empty files', async () => {
      const policy = new IpfsUploadPolicy();
      await expect(
        policy.validate({ buffer: Buffer.alloc(0), mimetype: 'application/pdf', filename: 'empty.pdf' }),
      ).rejects.toMatchObject({ code: 'EMPTY_FILE' });
    });
  });

  describe('mime allow-list', () => {
    it('rejects unsupported MIME types', async () => {
      const policy = new IpfsUploadPolicy();
      await expect(
        policy.validate({ buffer: PDF, mimetype: 'text/html', filename: 'page.html' }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_MIME' });
    });
  });

  describe('extension mismatch', () => {
    it('rejects a declared pdf with a non-matching extension', async () => {
      const policy = new IpfsUploadPolicy();
      await expect(
        policy.validate({ buffer: PDF, mimetype: 'application/pdf', filename: 'report.txt' }),
      ).rejects.toMatchObject({ code: 'EXTENSION_MISMATCH' });
    });

    it('rejects explicitly blocked extensions', async () => {
      const policy = new IpfsUploadPolicy();
      await expect(
        policy.validate({ buffer: Buffer.from('MZ...'), mimetype: 'application/octet-stream', filename: 'payload.exe' }),
      ).rejects.toMatchObject({ code: 'BLOCKED_EXTENSION' });
    });
  });

  describe('content sniffing', () => {
    it('rejects when content bytes contradict the declared mime', async () => {
      const policy = new IpfsUploadPolicy();
      await expect(
        policy.validate({ buffer: PDF, mimetype: 'image/png', filename: 'fake.png' }),
      ).rejects.toMatchObject({ code: 'CONTENT_MISMATCH' });
    });
  });

  describe('active content detection', () => {
    it('rejects an SVG containing a script element', async () => {
      const policy = new IpfsUploadPolicy();
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      await expect(
        policy.validate({ buffer: svg, mimetype: 'image/svg+xml', filename: 'icon.svg' }),
      ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT' });
    });

    it('rejects an SVG with an inline event-handler attribute', async () => {
      const policy = new IpfsUploadPolicy();
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect onmouseover="evil()" /></svg>');
      await expect(
        policy.validate({ buffer: svg, mimetype: 'image/svg+xml', filename: 'shape.svg' }),
      ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT' });
    });

    it('rejects an SVG with an XML entity declaration (XXE vector)', async () => {
      const policy = new IpfsUploadPolicy();
      const svg = Buffer.from('<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg></svg>');
      await expect(
        policy.validate({ buffer: svg, mimetype: 'image/svg+xml', filename: 'bomb.svg' }),
      ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT' });
    });

    it('rejects an SVG with a non-fragment href (external resource load)', async () => {
      const policy = new IpfsUploadPolicy();
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/sprite.svg#icon" /></svg>');
      await expect(
        policy.validate({ buffer: svg, mimetype: 'image/svg+xml', filename: 'ref.svg' }),
      ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT' });
    });

    it('accepts an SVG with only an intra-document fragment href', async () => {
      const policy = new IpfsUploadPolicy();
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><use href="#localSymbol" /></svg>');
      const mime = await policy.validate({ buffer: svg, mimetype: 'image/svg+xml', filename: 'safe.svg' });
      expect(mime).toBe('image/svg+xml');
    });

    it('rejects a text/plain file whose content would be sniffed as HTML by a browser', async () => {
      const policy = new IpfsUploadPolicy();
      const html = Buffer.from('<!DOCTYPE HTML><html><body>xss</body></html>');
      await expect(
        policy.validate({ buffer: html, mimetype: 'text/plain', filename: 'doc.txt' }),
      ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT' });
    });
  });

  describe('scan hook', () => {
    it('blocks unsafe files when a scan hook rejects them', async () => {
      const hook: FileScanHook = {
        scan: async () => ({ safe: false, reason: 'detected malware signature' }),
      };
      const policy = new IpfsUploadPolicy({ scanEnabled: true, scanHook: hook });
      await expect(
        policy.validate({ buffer: PDF, mimetype: 'application/pdf', filename: 'report.pdf' }),
      ).rejects.toMatchObject({ code: 'SCAN_REJECTED', message: expect.stringContaining('malware') });
    });

    it('accepts files the scan hook approves', async () => {
      const hook: FileScanHook = { scan: async () => ({ safe: true }) };
      const policy = new IpfsUploadPolicy({ scanEnabled: true, scanHook: hook });
      const mime = await policy.validate({ buffer: PDF, mimetype: 'application/pdf', filename: 'report.pdf' });
      expect(mime).toBe('application/pdf');
    });

    it('fails closed when scanning is enabled but no hook is configured', async () => {
      const policy = new IpfsUploadPolicy({ scanEnabled: true });
      await expect(
        policy.validate({ buffer: PDF, mimetype: 'application/pdf', filename: 'report.pdf' }),
      ).rejects.toMatchObject({ code: 'SCAN_UNAVAILABLE' });
    });
  });
});
