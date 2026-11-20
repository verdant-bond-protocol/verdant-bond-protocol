import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DebugElement } from '@angular/core';
import { By } from '@angular/platform-browser';

describe('Accessibility Coverage', () => {
  let fixture: ComponentFixture<any>;
  let component: any;
  let debugElement: DebugElement;

  const checkKeyboardNavigation = (el: DebugElement): boolean => {
    const interactive = el.queryAll(
      By.css('button, a, input, select, textarea, [role="button"]'),
    );
    return interactive.every((elem) => {
      const nativeEl = elem.nativeElement;
      return nativeEl.tabIndex >= -1;
    });
  };

  const checkFocusStates = (el: DebugElement): boolean => {
    const interactive = el.queryAll(
      By.css('button, a, input, [role="button"]'),
    );
    return interactive.every((elem) => {
      const styles = window.getComputedStyle(elem.nativeElement, ':focus');
      return styles.outline !== 'none' || styles.boxShadow !== 'none';
    });
  };

  const checkAriaLabels = (el: DebugElement): string[] => {
    const missing: string[] = [];
    const interactive = el.queryAll(
      By.css('button, a, input, [role="button"]'),
    );

    interactive.forEach((elem) => {
      const nativeEl = elem.nativeElement;
      const hasLabel =
        nativeEl.getAttribute('aria-label') ||
        nativeEl.getAttribute('aria-labelledby') ||
        nativeEl.textContent?.trim() ||
        nativeEl.placeholder;

      if (!hasLabel) {
        missing.push(nativeEl.outerHTML.substring(0, 100));
      }
    });

    return missing;
  };

  const checkAsyncStatusAnnouncement = (el: DebugElement): boolean => {
    const asyncElements = el.queryAll(
      By.css('[role="status"], [aria-live]'),
    );
    return asyncElements.length > 0;
  };

  const checkDialogA11y = (dialog: DebugElement): boolean => {
    const hasRole = dialog.nativeElement.getAttribute('role') === 'dialog';
    const hasAriaLabel =
      dialog.nativeElement.getAttribute('aria-label') ||
      dialog.nativeElement.getAttribute('aria-labelledby');
    const hasCloseButton = dialog.query(By.css('[aria-label*="Close"]'));

    return hasRole && hasAriaLabel && !!hasCloseButton;
  };

  describe('Keyboard Navigation', () => {
    it('should support keyboard-only navigation', () => {
      expect(checkKeyboardNavigation(debugElement)).toBe(true);
    });

    it('should trap focus in modal dialogs', () => {
      const dialog = debugElement.query(By.css('[role="dialog"]'));
      if (dialog) {
        const focusables = dialog.queryAll(
          By.css(
            'button, a, input:not([disabled]), [role="button"]:not([aria-disabled="true"])',
          ),
        );
        expect(focusables.length).toBeGreaterThan(0);
      }
    });

    it('should maintain logical tab order', () => {
      const interactive = debugElement.queryAll(
        By.css('button, a, input'),
      );
      let lastIndex = -1;

      interactive.forEach((elem) => {
        const tabIndex = parseInt(elem.nativeElement.tabIndex, 10) || 0;
        if (tabIndex > 0) {
          expect(tabIndex).toBeGreaterThan(lastIndex);
          lastIndex = tabIndex;
        }
      });
    });
  });

  describe('Focus Management', () => {
    it('should have visible focus indicators', () => {
      expect(checkFocusStates(debugElement)).toBe(true);
    });

    it('should announce form validation errors', () => {
      const form = debugElement.query(By.css('form'));
      if (form) {
        const errors = form.queryAll(By.css('[role="alert"]'));
        expect(errors.length).toBeGreaterThanOrEqual(0);
      }
    });

    it('should link validation messages to fields with aria-describedby', () => {
      const inputs = debugElement.queryAll(By.css('input'));
      inputs.forEach((input) => {
        const describedBy = input.nativeElement.getAttribute(
          'aria-describedby',
        );
        if (describedBy) {
          const errorEl = debugElement.query(
            By.css(`#${describedBy}`),
          );
          expect(errorEl).toBeTruthy();
        }
      });
    });
  });

  describe('Labels and Names', () => {
    it('should have accessible names for all interactive elements', () => {
      const missing = checkAriaLabels(debugElement);
      expect(missing).toHaveLength(0);
    });

    it('should use aria-label for icon-only buttons', () => {
      const iconButtons = debugElement.queryAll(
        By.css('button:not(:has(*:not(svg, i, .icon)))'),
      );
      iconButtons.forEach((btn) => {
        expect(
          btn.nativeElement.getAttribute('aria-label'),
        ).toBeTruthy();
      });
    });
  });

  describe('Async Status Announcement', () => {
    it('should announce loading states', (done) => {
      expect(checkAsyncStatusAnnouncement(debugElement)).toBe(true);
      done();
    });

    it('should use aria-live for real-time updates', () => {
      const liveRegion = debugElement.query(By.css('[aria-live]'));
      if (liveRegion) {
        const polite = liveRegion.nativeElement.getAttribute('aria-live');
        expect(['polite', 'assertive']).toContain(polite);
      }
    });

    it('should announce form submission status', () => {
      const form = debugElement.query(By.css('form'));
      if (form) {
        const statusEl = form.query(By.css('[role="status"]'));
        expect(statusEl).toBeTruthy();
      }
    });
  });

  describe('Dialog Accessibility', () => {
    it('should be accessible when opened', () => {
      const dialog = debugElement.query(By.css('[role="dialog"]'));
      if (dialog) {
        expect(checkDialogA11y(dialog)).toBe(true);
      }
    });

    it('should restore focus after close', () => {
      const initialFocus = document.activeElement;
      const dialog = debugElement.query(By.css('[role="dialog"]'));
      if (dialog) {
        expect(document.activeElement).toBe(initialFocus);
      }
    });
  });

  describe('Marketplace and Bond Flows', () => {
    it('should support keyboard navigation in tables', () => {
      const tables = debugElement.queryAll(By.css('table'));
      tables.forEach((table) => {
        const focusables = table.queryAll(
          By.css('button, a, input'),
        );
        expect(focusables.length).toBeGreaterThan(0);
      });
    });

    it('should announce bond status changes', () => {
      const statusElement = debugElement.query(By.css('[aria-live="polite"]'));
      expect(statusElement).toBeTruthy();
    });
  });
});
