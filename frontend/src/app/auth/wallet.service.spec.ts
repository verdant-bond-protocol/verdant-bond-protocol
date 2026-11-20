import { TestBed } from '@angular/core/testing';
import { WalletService } from './wallet.service';
import { FREIGHTER_API, FreighterApi } from './freighter-api.token';
import { environment } from '../../environments/environment';

const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const OTHER_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

describe('WalletService (issue #165: getNetwork is not defined)', () => {
  let freighter: jasmine.SpyObj<FreighterApi>;
  let service: WalletService;

  const onExpectedNetwork = () =>
    Promise.resolve({ network: 'TESTNET', networkPassphrase: environment.networkPassphrase });

  beforeEach(() => {
    freighter = jasmine.createSpyObj<FreighterApi>('FreighterApi', [
      'isConnected',
      'getAddress',
      'getNetwork',
      'signTransaction',
    ]);
    freighter.isConnected.and.resolveTo({ isConnected: true });
    freighter.getAddress.and.resolveTo({ address: ADDRESS });
    freighter.getNetwork.and.callFake(onExpectedNetwork);
    freighter.signTransaction.and.resolveTo({ signedTxXdr: 'signed-xdr' });

    TestBed.configureTestingModule({
      providers: [{ provide: FREIGHTER_API, useValue: freighter }],
    });
    service = TestBed.inject(WalletService);
  });

  afterEach(() => {
    service.disconnect();
  });

  it('connects and reaches the connected status without a ReferenceError', async () => {
    // Before the fix, `getNetwork` was called but never imported, so this line
    // threw `ReferenceError: getNetwork is not defined` and the status was
    // stuck on 'connecting'.
    await expectAsync(service.connect()).toBeResolved();

    expect(freighter.getNetwork).toHaveBeenCalled();
    expect(service.status()).toBe('connected');
    expect(service.isConnected()).toBeTrue();
    expect(service.address()).toBe(ADDRESS);
    expect(service.networkPassphrase()).toBe(environment.networkPassphrase);
    expect(service.errorMessage()).toBeNull();
  });

  it('records the active network passphrase when verifyNetwork succeeds', async () => {
    await service.connect();
    expect(service.networkPassphrase()).toBe(environment.networkPassphrase);
  });

  it('surfaces a testnet/mainnet mismatch with an actionable message', async () => {
    freighter.getNetwork.and.resolveTo({
      network: 'PUBLIC',
      networkPassphrase: OTHER_PASSPHRASE,
    });

    await expectAsync(service.connect()).toBeRejectedWithError(/network mismatch/i);

    expect(service.status()).toBe('network_mismatch');
    expect(service.errorMessage()).toContain('PUBLIC');
    expect(service.errorMessage()).toContain(environment.stellarNetwork);
    expect(service.isConnected()).toBeFalse();
  });

  it('reports an unreadable network instead of silently trusting an empty passphrase', async () => {
    freighter.getNetwork.and.resolveTo({
      network: '',
      networkPassphrase: '',
      error: { code: -1, message: 'User declined access' },
    });

    await expectAsync(service.connect()).toBeRejectedWithError(/read the Freighter network/i);
    expect(service.status()).toBe('error');
  });

  it('verifies the network before signing a challenge', async () => {
    freighter.getNetwork.and.resolveTo({
      network: 'PUBLIC',
      networkPassphrase: OTHER_PASSPHRASE,
    });

    await expectAsync(service.signChallenge('challenge-xdr')).toBeRejectedWithError(/network mismatch/i);
    expect(freighter.signTransaction).not.toHaveBeenCalled();
  });

  it('signs the challenge once the network matches', async () => {
    await expectAsync(service.signChallenge('challenge-xdr')).toBeResolvedTo('signed-xdr');
    expect(freighter.signTransaction).toHaveBeenCalledWith('challenge-xdr', {
      networkPassphrase: environment.networkPassphrase,
    });
  });

  it('detects a network switch made in Freighter after connecting', async () => {
    await service.connect();
    expect(service.status()).toBe('connected');

    freighter.getNetwork.and.resolveTo({
      network: 'PUBLIC',
      networkPassphrase: OTHER_PASSPHRASE,
    });
    await service.refreshAccountState();

    expect(service.status()).toBe('network_mismatch');
    expect(service.errorMessage()).toContain('Switch networks in Freighter');
  });

  it('clears the mismatch banner when the user switches back', async () => {
    await service.connect();
    freighter.getNetwork.and.resolveTo({ network: 'PUBLIC', networkPassphrase: OTHER_PASSPHRASE });
    await service.refreshAccountState();
    expect(service.status()).toBe('network_mismatch');

    freighter.getNetwork.and.callFake(onExpectedNetwork);
    await service.refreshAccountState();

    expect(service.status()).toBe('connected');
    expect(service.errorMessage()).toBeNull();
  });

  it('reports a missing extension without reaching the network check', async () => {
    freighter.isConnected.and.resolveTo({ isConnected: false });

    await expectAsync(service.connect()).toBeRejectedWithError(/Freighter not detected/i);
    expect(service.status()).toBe('missing');
    expect(freighter.getNetwork).not.toHaveBeenCalled();
  });

  it('reports a locked wallet without reaching the network check', async () => {
    freighter.getAddress.and.resolveTo({ address: '' });

    await expectAsync(service.connect()).toBeRejectedWithError(/locked/i);
    expect(service.status()).toBe('locked');
    expect(freighter.getNetwork).not.toHaveBeenCalled();
  });
});
