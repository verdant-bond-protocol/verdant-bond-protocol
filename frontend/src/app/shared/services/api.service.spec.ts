import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { ApiService } from './api.service';
import { AuthService } from '../../auth/auth.service';
import { WalletService } from '../../auth/wallet.service';
import { CreateBondDto } from '../interfaces/bond.interface';
import { AdminIntentService } from './admin-intent.service';
import { Keypair } from '@stellar/stellar-sdk';

describe('ApiService', () => {
  let service: ApiService;
  let httpTesting: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ApiService,
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { token: signal('test-token') } },
        { provide: WalletService, useValue: { address: signal('GTEST') } },
      ],
    });
    service = TestBed.inject(ApiService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpTesting.verify());

  it('posts a typed bond issuance payload', async () => {
    const payload: CreateBondDto = {
      projectId: 'project-1',
      faceValue: 1000,
      couponSchedule: [1750000000],
      creditType: 'Carbon',
      maturityDate: 1781536000,
      totalSupply: 100,
    };

    // Issuance carries a signed admin intent (#166): unlock the admin session.
    const admin = Keypair.random();
    TestBed.inject(AdminIntentService).setAdminSecret(admin.secret());
    service.issueBond(payload).subscribe();

    const request = httpTesting.expectOne('/api/bonds');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(payload);
    const intent = JSON.parse(request.request.headers.get('x-admin-intent') ?? '{}');
    expect(intent.action).toBe('issue_bond');
    request.flush({});

    // The signature must verify (ed25519, WebCrypto) over the canonical UTF-8
    // message the API's IntentGuard checks.
    const message = `${intent.action}|${intent.target}|${intent.chain}|${intent.expiry}|${intent.nonce}`;
    const signature = Uint8Array.from(atob(intent.signature), (c) => c.charCodeAt(0));
    const publicKey = await crypto.subtle.importKey(
      'raw', new Uint8Array(admin.rawPublicKey()), { name: 'Ed25519' }, false, ['verify'],
    );
    expect(
      await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, new TextEncoder().encode(message)),
    ).toBeTrue();
  });

  it('serializes all supported order query filters', () => {
    service.getOrders({ bondId: 3, status: 'Open', page: 2, limit: 10 }).subscribe();

    const request = httpTesting.expectOne((req) => req.url === '/api/marketplace/orders');
    expect(request.request.params.get('bondId')).toBe('3');
    expect(request.request.params.get('status')).toBe('Open');
    expect(request.request.params.get('page')).toBe('2');
    expect(request.request.params.get('limit')).toBe('10');
    request.flush({ data: [], meta: { page: 2, limit: 10, total: 0, totalPages: 1 } });
  });
});