import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';

@Pipe({
  name: 'safeUrl',
  standalone: true,
})
export class SafeUrlPipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) {}

  transform(value: string | null | undefined): SafeUrl {
    if (!value) {
      return this.sanitizer.bypassSecurityTrustUrl('about:blank');
    }

    try {
      const url = new URL(value);
      if (['http:', 'https:', 'ipfs:'].includes(url.protocol)) {
        return this.sanitizer.bypassSecurityTrustUrl(url.href);
      }
    } catch {
      // If it's a relative URL or invalid
    }
    
    // Default fallback for potentially unsafe inputs
    return this.sanitizer.bypassSecurityTrustUrl('about:blank');
  }
}
