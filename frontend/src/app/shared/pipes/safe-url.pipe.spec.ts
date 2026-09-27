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
});
