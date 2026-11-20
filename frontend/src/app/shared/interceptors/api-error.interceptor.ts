import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import { normalizeApiError } from '../errors/api-error';

export const apiErrorInterceptor: HttpInterceptorFn = (request, next) => next(request).pipe(
  catchError((error: HttpErrorResponse) =>
    throwError(() => normalizeApiError(error)),
  ),
);