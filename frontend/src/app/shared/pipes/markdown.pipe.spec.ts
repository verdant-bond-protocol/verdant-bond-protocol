import { SafeMarkdownPipe } from './markdown.pipe';
import { DomSanitizer } from '@angular/platform-browser';

describe('SafeMarkdownPipe', () => {
  let pipe: SafeMarkdownPipe;
  let sanitizer: jasmine.SpyObj<DomSanitizer>;

  beforeEach(() => {
    sanitizer = jasmine.createSpyObj('DomSanitizer', ['bypassSecurityTrustHtml']);
    pipe = new SafeMarkdownPipe(sanitizer);
  });

  it('should render standard markdown tags', () => {
    pipe.transform('**Bold**');
    expect(sanitizer.bypassSecurityTrustHtml).toHaveBeenCalledWith('<p><strong>Bold</strong></p>\n');
  });

  it('should strip script tags inside markdown', () => {
    pipe.transform('<script>alert(1)</script>');
    expect(sanitizer.bypassSecurityTrustHtml).toHaveBeenCalledWith('');
  });

  it('should sanitize javascript links in markdown', () => {
    pipe.transform('[Link](javascript:alert(1))');
    // DOMPurify typically strips javascript links by making the anchor invalid or empty href
    expect(sanitizer.bypassSecurityTrustHtml).toHaveBeenCalledWith('<p><a>Link</a></p>\n');
  });
});
