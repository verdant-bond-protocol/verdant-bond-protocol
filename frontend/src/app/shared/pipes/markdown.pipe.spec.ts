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

  describe('sensitive-content boundary (#382)', () => {
    const rendered = (markdown: string): string => {
      sanitizer.bypassSecurityTrustHtml.calls.reset();
      pipe.transform(markdown);
      return sanitizer.bypassSecurityTrustHtml.calls.mostRecent().args[0] as string;
    };

    it('drops event-handler and embedded-document vectors in raw HTML', () => {
      const html = rendered('<img src=x onerror="alert(1)"><iframe src="https://evil.example"></iframe><p onclick="alert(1)">hi</p>');
      expect(html).not.toMatch(/onerror|onclick|<img|<iframe|alert/);
      expect(html).toContain('<p>hi</p>');
    });

    it('drops data:, vbscript: and obfuscated javascript: link targets', () => {
      for (const href of ['data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', 'vbscript:msgbox(1)', 'JaVaScRiPt:alert(1)', 'java&#x09;script:alert(1)']) {
        expect(rendered(`<a href="${href}">x</a>`)).not.toContain('href=');
      }
    });

    it('drops style attributes so content cannot overlay the page', () => {
      expect(rendered('<p style="position:fixed;inset:0">x</p>')).not.toContain('style');
    });

    it('forces noopener/noreferrer on any link with a target (no reverse tabnabbing)', () => {
      const html = rendered('<a href="https://example.com" target="_blank">x</a> <a href="https://example.com" target="evilwin" rel="opener">y</a>');
      const links = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a');
      expect(links.length).toBe(2);
      links.forEach((a) => {
        expect(a.getAttribute('target')).toBe('_blank');
        expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      });
    });

    it('leaves links without a target untouched', () => {
      expect(rendered('[docs](https://example.com)')).toBe('<p><a href="https://example.com">docs</a></p>\n');
    });
  });
});
