import { SafeUrlPipe } from './safe-url.pipe';
import { DomSanitizer } from '@angular/platform-browser';

describe('SafeUrlPipe', () => {
  let pipe: SafeUrlPipe;
  let sanitizer: jasmine.SpyObj<DomSanitizer>;

  beforeEach(() => {
    sanitizer = jasmine.createSpyObj('DomSanitizer', ['bypassSecurityTrustUrl']);
    pipe = new SafeUrlPipe(sanitizer);
  });

  it('should allow http and https urls', () => {
    pipe.transform('https://example.com');
    expect(sanitizer.bypassSecurityTrustUrl).toHaveBeenCalledWith('https://example.com/');
  });

  it('should allow ipfs urls', () => {
    pipe.transform('ipfs://QmHash');
    expect(sanitizer.bypassSecurityTrustUrl).toHaveBeenCalledWith('ipfs://QmHash');
  });

  it('should reject javascript protocols', () => {
    pipe.transform('javascript:alert(1)');
    expect(sanitizer.bypassSecurityTrustUrl).toHaveBeenCalledWith('about:blank');
  });

  describe('sensitive-content boundary (#382)', () => {
    it('falls back to about:blank for every scheme outside the allow-list', () => {
      for (const url of [
        'JAVASCRIPT:alert(1)',
        ' javascript:alert(1)',
        'java\tscript:alert(1)',
        'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
        'vbscript:msgbox(1)',
        'file:///etc/passwd',
        'blob:https://example.com/uuid',
      ]) {
        sanitizer.bypassSecurityTrustUrl.calls.reset();
        pipe.transform(url);
        expect(sanitizer.bypassSecurityTrustUrl).toHaveBeenCalledWith('about:blank');
      }
    });

    it('rejects relative and protocol-relative URLs that would resolve against the app origin', () => {
      for (const url of ['//evil.example/x', '/api/admin', '../x']) {
        sanitizer.bypassSecurityTrustUrl.calls.reset();
        pipe.transform(url);
        expect(sanitizer.bypassSecurityTrustUrl).toHaveBeenCalledWith('about:blank');
      }
    });
  });
});
