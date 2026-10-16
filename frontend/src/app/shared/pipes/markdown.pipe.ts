import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * A DOMPurify instance private to this pipe, so the hook below cannot leak
 * into (or be removed by) any other DOMPurify user in the app.
 *
 * Untrusted markdown may carry `target` and `rel` on links. Browsers imply
 * `noopener` only for `target="_blank"` without `rel="opener"`; a named target
 * (`target="win"`) or `rel="opener"` hands the opened page `window.opener`,
 * letting it navigate this tab elsewhere (reverse tabnabbing, #382). Any link
 * with a `target` therefore opens a fresh tab with no opener and no referrer.
 */
const purifier = DOMPurify(window);
purifier.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('target')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

@Pipe({
  name: 'safeMarkdown',
  standalone: true,
})
export class SafeMarkdownPipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) {}

  transform(value: string | null | undefined): SafeHtml {
    if (!value) {
      return '';
    }

    // Parse markdown securely
    const rawHtml = marked.parse(value) as string;

    // Purify the resulting HTML to prevent XSS attacks
    const cleanHtml = purifier.sanitize(rawHtml, {
      ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre'],
      ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
    });

    return this.sanitizer.bypassSecurityTrustHtml(cleanHtml);
  }
}
