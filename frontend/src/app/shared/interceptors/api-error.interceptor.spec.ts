import { HttpClient } from '@angular/common/http';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { apiErrorInterceptor } from './api-error.interceptor';
import { AppError } from '../errors/api-error';

describe('apiErrorInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([apiErrorInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('normalizes validation errors with an array message', () => {
    let received: AppError | undefined;
    http.get('/api/projects').subscribe({ error: (error: AppError) => received = error });

    controller.expectOne('/api/projects').flush(
      { title: 'Bad Request', status: 400, detail: ['name is required', 'country is required'] },
      { status: 400, statusText: 'Bad Request' },
    );

    expect(received).toEqual({
      status: 400,
      title: 'Bad Request',
      detail: 'name is required, country is required',
    });
  });

  it('preserves contract errors returned in detail', () => {
    let received: AppError | undefined;
    http.post('/api/marketplace/buy', {}).subscribe({ error: (error: AppError) => received = error });

    controller.expectOne('/api/marketplace/buy').flush(
      { title: 'Contract Error', status: 422, detail: 'Insufficient escrow balance' },
      { status: 422, statusText: 'Unprocessable Entity' },
    );

    expect(received?.detail).toBe('Insufficient escrow balance');
    expect(received?.status).toBe(422);
  });

  it('normalizes authentication errors returned with message', () => {
    let received: AppError | undefined;
    http.get('/api/bonds').subscribe({ error: (error: AppError) => received = error });

    controller.expectOne('/api/bonds').flush(
      { statusCode: 401, message: 'Unauthorized' },
      { status: 401, statusText: 'Unauthorized' },
    );

    expect(received).toEqual({
      status: 401,
      title: 'Unauthorized',
      detail: 'Unauthorized',
    });
  });
});