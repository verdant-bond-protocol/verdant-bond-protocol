import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { IssueBondComponent } from './issue-bond.component';
import { ApiService } from '../../shared/services/api.service';
import { PendingTransactionsService } from '../../shared/services/pending-transactions.service';

/**
 * Accessibility regression coverage (#373) for the dense bond-issuance form:
 * every control is programmatically labelled, validation feedback is announced
 * to assistive tech, and submission feedback uses an assertive live region.
 *
 * These assertions are intentionally attribute-level (rather than a full axe
 * sweep) so a visual/contrast change cannot make the regression suite flaky;
 * the broader axe sweep lives in dashboard.a11y.spec.ts.
 */
describe('IssueBondComponent accessibility (#373)', () => {
  let fixture: ComponentFixture<IssueBondComponent>;
  let component: IssueBondComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [IssueBondComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiService, useValue: { issueBond: () => of({ id: 'b1' }) } },
        { provide: PendingTransactionsService, useValue: jasmine.createSpyObj('PendingTransactionsService', ['register']) },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(IssueBondComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('labels every form control with a matching <label for>', () => {
    const element: HTMLElement = fixture.nativeElement;
    const controls = Array.from(element.querySelectorAll<HTMLElement>('form input, form select'));

    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const id = control.getAttribute('id');
      expect(id).withContext(`control ${control.tagName} should have an id`).toBeTruthy();
      const label = element.querySelector(`label[for="${id}"]`);
      expect(label).not.toBeNull();
      expect(label!.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it('never hides interactive controls from assistive technology', () => {
    const element: HTMLElement = fixture.nativeElement;
    const controls = Array.from(element.querySelectorAll('input, select, button, a'));

    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.getAttribute('aria-hidden')).not.toBe('true');
      const tabindex = control.getAttribute('tabindex');
      if (tabindex !== null) expect(Number(tabindex)).toBeGreaterThanOrEqual(0);
    }
  });

  it('gives the submit control an accessible name and keeps it keyboard-operable', () => {
    const submit = fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement;
    const now = Math.floor(Date.now() / 1000);

    expect(submit).not.toBeNull();
    expect(submit.textContent?.trim().length).toBeGreaterThan(0);
    expect(submit.disabled).toBe(true);

    component.form.patchValue({
      projectId: 'p1',
      faceValue: 1000,
      totalSupply: 10,
      maturityDate: '2099-01-01',
      couponSchedule: `${now + 3600}, ${now + 7200}`,
    });
    fixture.detectChanges();
    expect(submit.disabled).toBe(false);
  });

  it('announces field-level validation failures via role=alert', () => {
    component.form.get('projectId')!.markAsTouched();
    fixture.detectChanges();

    const alerts = Array.from(fixture.nativeElement.querySelectorAll('.form-error')) as HTMLElement[];
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it('announces submission errors in an assertive live region', () => {
    component.error.set('Failed to issue bond');
    fixture.detectChanges();

    const banner = fixture.nativeElement.querySelector('.error-banner') as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.getAttribute('aria-live')).toBe('assertive');
    expect(banner.textContent).toContain('Failed to issue bond');
  });

  it('announces success in a polite live region', () => {
    component.success.set(true);
    fixture.detectChanges();

    const banner = fixture.nativeElement.querySelector('.success-banner') as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('aria-live')).toBe('polite');
  });
});
