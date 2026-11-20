import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ProjectCreateComponent } from './project-create.component';
import { ApiService } from '../../shared/services/api.service';
import { PendingTransactionsService } from '../../shared/services/pending-transactions.service';

describe('ProjectCreateComponent', () => {
  let component: ProjectCreateComponent;
  let fixture: ComponentFixture<ProjectCreateComponent>;

  const validValue = {
    name: 'Amazon Reforestation Phase 3',
    methodology: 'VERRA-VCS',
    country: 'BR',
    totalAreaHa: 10000,
    carbonSequestrationEstimate: 50000,
    blueCarbon: false,
    locationLat: -3.4653,
    locationLng: -62.2159,
  };

  beforeEach(async () => {
    const apiService = {
      registerProject: jasmine.createSpy('registerProject').and.returnValue(of({ id: 'p1' })),
    };

    await TestBed.configureTestingModule({
      imports: [ProjectCreateComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: apiService },
        { provide: PendingTransactionsService, useValue: jasmine.createSpyObj('PendingTransactionsService', ['register']) },
      ],
    }).compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(ProjectCreateComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('accepts a fully valid submission unchanged', () => {
    component.form.patchValue(validValue);
    expect(component.form.valid).toBe(true);
  });

  it('rejects an unrecognized methodology', () => {
    component.form.patchValue({ ...validValue, methodology: 'VM0015' });
    expect(component.form.get('methodology')?.valid).toBe(false);
  });

  it('rejects a malformed country code', () => {
    component.form.patchValue({ ...validValue, country: 'Brazil' });
    expect(component.form.get('country')?.hasError('invalidCountryCode')).toBe(true);
  });

  it('rejects out-of-range latitude/longitude', () => {
    component.form.patchValue({ ...validValue, locationLat: 95, locationLng: -200 });
    expect(component.form.get('locationLat')?.hasError('latitudeOutOfRange')).toBe(true);
    expect(component.form.get('locationLng')?.hasError('longitudeOutOfRange')).toBe(true);
  });

  it('rejects zero/negative numeric fields', () => {
    component.form.patchValue({ ...validValue, totalAreaHa: 0, carbonSequestrationEstimate: -5 });
    expect(component.form.get('totalAreaHa')?.valid).toBe(false);
    expect(component.form.get('carbonSequestrationEstimate')?.valid).toBe(false);
  });

  it('rejects a missing location', () => {
    component.form.patchValue({ ...validValue, locationLat: null, locationLng: null });
    expect(component.form.valid).toBe(false);
  });
});
