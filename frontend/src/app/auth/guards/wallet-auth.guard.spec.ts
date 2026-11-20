import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { walletAuthGuard } from './wallet-auth.guard';
import { AuthService } from '../auth.service';

describe('walletAuthGuard', () => {
  let router: Router;

  function setup(sessionReady: boolean) {
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { sessionReady: () => sessionReady } },
      ],
    });
    router = TestBed.inject(Router);
  }

  it('allows navigation when the session is ready', () => {
    setup(true);
    const result = TestBed.runInInjectionContext(() =>
      walletAuthGuard({} as any, { url: '/bonds/issue' } as any),
    );
    expect(result).toBe(true);
  });

  it('redirects to /auth with returnUrl when the session is not ready', () => {
    setup(false);
    const result = TestBed.runInInjectionContext(() =>
      walletAuthGuard({} as any, { url: '/bonds/issue' } as any),
    ) as UrlTree;

    expect(result instanceof UrlTree).toBe(true);
    expect(router.serializeUrl(result)).toBe('/auth?returnUrl=%2Fbonds%2Fissue');
  });
});
