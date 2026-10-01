import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

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
    const cleanHtml = DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre'],
      ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
    });

    return this.sanitizer.bypassSecurityTrustHtml(cleanHtml);
  }
}
