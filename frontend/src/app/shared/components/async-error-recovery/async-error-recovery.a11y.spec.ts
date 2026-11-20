import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AsyncErrorRecoveryComponent } from './async-error-recovery.component';
import { axeViolations } from '../../testing/axe';

/**
 * Accessibility regression coverage for async error recovery (WCAG 2.1 A/AA):
 * failures are announced assertively, progress politely, and the retry path
 * stays labelled, keyboard-operable and safe to repeat.
 *
 * The four paths are exercised against a real component lifecycle:
 *   normal — the operation succeeds on first load;
 *   failure — a transient error is announced and offers a retry;
 *   retry — a second attempt recovers and re-announces the outcome;
 *   authorization — a 403 offers a sign-in link instead of a pointless retry.
 */
describe('AsyncErrorRecoveryComponent accessibility', () => {
  let fixture: ComponentFixture<AsyncErrorRecoveryComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AsyncErrorRecoveryComponent],
    }).compileComponents();
  });

  async function mount(operation: () => Promise<unknown>): Promise<ComponentFixture<AsyncErrorRecoveryComponent>> {
    const created = TestBed.createComponent(AsyncErrorRecoveryComponent);
    created.componentRef.setInput('operation', operation);
    created.detectChanges();
    await created.whenStable();
    created.detectChanges();
    return created;
  }

  async function expectNoViolations(target: ComponentFixture<AsyncErrorRecoveryComponent>): Promise<void> {
    const element: HTMLElement = target.nativeElement;
    document.body.appendChild(element);
    try {
      expect(await axeViolations(element)).toEqual([]);
    } finally {
      element.remove();
    }
  }

  const httpError = (status: number, detail: string) =>
    new HttpErrorResponse({ status, statusText: 'Error', error: { title: 'Error', detail } });

  it('announces a successful load in a polite live region', async () => {
    fixture = await mount(async () => 'ok');
    const component = fixture.componentInstance;
    const element: HTMLElement = fixture.nativeElement;

    expect(component.phase()).toBe('recovered');
    const live = element.querySelector('.live-region') as HTMLElement;
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.getAttribute('aria-atomic')).toBe('true');
    expect(live.textContent).toContain('Request completed.');
    expect(element.querySelector('.success-banner')?.getAttribute('role')).toBe('status');
    await expectNoViolations(fixture);
  });

  it('announces a failure assertively and offers a named retry button', async () => {
    fixture = await mount(async () => { throw httpError(503, 'Service temporarily unavailable'); });
    const element: HTMLElement = fixture.nativeElement;

    const banner = element.querySelector('.error-banner') as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.getAttribute('aria-live')).toBe('assertive');
    expect(banner.textContent).toContain('Service temporarily unavailable');
    expect((element.querySelector('.live-region') as HTMLElement).textContent)
      .toContain('Service temporarily unavailable');

    const retry = element.querySelector('.retry-button') as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    expect(retry.textContent?.trim()).toBe('Try again');
    expect(retry.getAttribute('aria-describedby')).toBe(fixture.componentInstance.messageId);
    expect(element.querySelector(`#${fixture.componentInstance.messageId}`)).not.toBeNull();
    await expectNoViolations(fixture);
  });

  it('keeps retry announced and disabled while in flight, then announces recovery', async () => {
    let calls = 0;
    const operation = jasmine.createSpy('operation').and.callFake(() => {
      calls++;
      return calls === 1
        ? Promise.reject(httpError(0, 'Network offline'))
        : Promise.resolve('ok');
    });
    fixture = await mount(operation);
    const recoveredSpy = jasmine.createSpy('recovered');
    fixture.componentInstance.recovered.subscribe(recoveredSpy);

    const retry = fixture.nativeElement.querySelector('.retry-button') as HTMLButtonElement;
    retry.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.phase()).toBe('recovering');
    expect(retry.disabled).toBe(true); // cannot trigger a second concurrent retry
    expect((fixture.nativeElement.querySelector('.recovery') as HTMLElement).getAttribute('aria-busy'))
      .toBe('true');
    expect((fixture.nativeElement.querySelector('.live-region') as HTMLElement).textContent)
      .toContain('Retry attempt 1 in progress.');

    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.phase()).toBe('recovered');
    expect((fixture.nativeElement.querySelector('.live-region') as HTMLElement).textContent)
      .toContain('Recovered on attempt 1.');
    expect(recoveredSpy).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    await expectNoViolations(fixture);
  });

  it('offers an accessible sign-in path for an authorization failure', async () => {
    fixture = await mount(async () => { throw httpError(403, 'Permission denied'); });
    const element: HTMLElement = fixture.nativeElement;

    const link = element.querySelector('.sign-in-link') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.textContent?.trim()).toBe('Sign in to continue');
    expect(link.getAttribute('href')).toBe('/auth');
    expect((element.querySelector('.retry-button') as HTMLButtonElement).textContent?.trim())
      .toBe('Try again after signing in');
    expect((element.querySelector('.live-region') as HTMLElement).textContent)
      .toContain('You do not have permission.');
    await expectNoViolations(fixture);
  });

  it('does not start a second retry from a rapid double click', async () => {
    let calls = 0;
    const operation = () => {
      calls++;
      return calls === 1 ? Promise.reject(httpError(0, 'temporary')) : Promise.resolve('ok');
    };
    fixture = await mount(operation);
    const retry = fixture.nativeElement.querySelector('.retry-button') as HTMLButtonElement;
    retry.click();
    retry.click(); // before change detection updates `disabled`
    await fixture.whenStable();
    fixture.detectChanges();
    expect(calls).toBe(2); // initial load + one retry
  });

  it('uses a distinct error description id per component instance', async () => {
    const first = await mount(async () => { throw httpError(500, 'first'); });
    const second = await mount(async () => { throw httpError(500, 'second'); });
    expect(first.componentInstance.messageId).not.toBe(second.componentInstance.messageId);
    expect(first.nativeElement.querySelector(`#${first.componentInstance.messageId}`)).not.toBeNull();
    expect(second.nativeElement.querySelector(`#${second.componentInstance.messageId}`)).not.toBeNull();
  });

  it('falls back to a readable detail when the error carries no message', async () => {
    fixture = await mount(async () => { throw new Error(''); });
    expect((fixture.nativeElement.querySelector('.error-banner') as HTMLElement).textContent)
      .toContain('Request failed');
  });
});
