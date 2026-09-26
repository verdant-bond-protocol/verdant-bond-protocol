import { TestBed } from '@angular/core/testing';
import { Router, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';
import { Keypair } from '@stellar/stellar-sdk';
import { adminGuard, authGuard, AUTH_REASON_PARAM, RETURN_URL_PARAM } from './auth.guard';
import { WalletService } from '../wallet.service';
import { AuthService } from '../auth.service';
import { FREIGHTER_API } from '../freighter-api.token';
import { AdminAccessService } from '../../shared/services/admin-access.service';

const ADMIN_ADDRESS = Keypair.random().publicKey();
const OTHER_ADDRESS = Keypair.random().publicKey();

describe('route guards (issue #168)', () => {
  let wallet: WalletService;
  let auth: AuthService;
  let adminAccess: AdminAccessService;

  const stateFor = (url: string) => ({ url }) as RouterStateSnapshot;

  const run = (guard: typeof authGuard, url: string) =>
    TestBed.runInInjectionContext(() => guard({} as never, stateFor(url)));

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: FREIGHTER_API, useValue: {} },
        {
          provide: AuthService,
          useValue: { isAuthenticated: () => authenticated },
        },
      ],
    });

    wallet = TestBed.inject(WalletService);
    auth = TestBed.inject(AuthService);
    adminAccess = TestBed.inject(AdminAccessService);
    adminAccess.adminAddress.set(ADMIN_ADDRESS);
  });

  let authenticated = false;
  beforeEach(() => {
    authenticated = false;
    wallet.isConnected.set(false);
    wallet.address.set(null);
  });

  const expectRedirect = (result: boolean | UrlTree | RedirectCommand, url: string, reason: string) => {
    let tree: UrlTree;
    if (result instanceof RedirectCommand) {
      tree = result.redirectTo;
    } else {
      expect(result instanceof UrlTree).toBeTrue();
      tree = result as UrlTree;
    }
    expect(TestBed.inject(Router).serializeUrl(tree)).toContain('/auth');
    expect(tree.queryParams[RETURN_URL_PARAM]).toBe(url);
    expect(tree.queryParams[AUTH_REASON_PARAM]).toBe(reason);
  };

  it('redirects an anonymous visitor away from a private route', () => {
    expectRedirect(run(authGuard, '/dashboard'), '/dashboard', 'wallet');
  });

  it('redirects a connected but unauthenticated wallet to sign in', () => {
    wallet.isConnected.set(true);
    wallet.address.set(OTHER_ADDRESS);

    expectRedirect(run(authGuard, '/marketplace/sell'), '/marketplace/sell', 'session');
  });

  it('admits a connected and authenticated wallet', () => {
    wallet.isConnected.set(true);
    wallet.address.set(OTHER_ADDRESS);
    authenticated = true;

    expect(run(authGuard, '/dashboard')).toBeTrue();
    expect(auth.isAuthenticated()).toBeTrue();
  });

  it('refuses a non-admin wallet on an admin route', () => {
    wallet.isConnected.set(true);
    wallet.address.set(OTHER_ADDRESS);
    authenticated = true;

    expectRedirect(run(adminGuard, '/bonds/issue'), '/bonds/issue', 'admin');
  });

  it('admits the configured admin wallet', () => {
    wallet.isConnected.set(true);
    wallet.address.set(ADMIN_ADDRESS);
    authenticated = true;

    expect(run(adminGuard, '/bonds/issue')).toBeTrue();
  });

  it('refuses every wallet when no admin address is configured (#167)', () => {
    adminAccess.adminAddress.set(null);
    wallet.isConnected.set(true);
    wallet.address.set(ADMIN_ADDRESS);
    authenticated = true;

    expectRedirect(run(adminGuard, '/bonds/issue'), '/bonds/issue', 'admin');
  });

  it('asks an anonymous visitor to connect before mentioning admin access', () => {
    expectRedirect(run(adminGuard, '/bonds/issue'), '/bonds/issue', 'wallet');
  });
});
