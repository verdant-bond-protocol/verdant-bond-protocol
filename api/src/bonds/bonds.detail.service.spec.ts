import { Test } from '@nestjs/testing';
import { BondsService } from './bonds.service';
import { HolderIndexService } from './holder-index.service';
import { ContractService } from '../stellar/contract.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { RedisService } from '../common/services/redis.service';
import { SigningKeyProvider } from '../common/services/signing-key.provider';
import { ConfigService } from '../config/config.service';
import { BondResponse, HolderResponse, CreditTypeEnum, BondStatusEnum, BondMaturityStatusEnum } from './interfaces/bond.interface';

const dummyBond: BondResponse = {
  id: 7,
  projectId: 'abc',
  faceValue: '1000',
  couponSchedule: ['10', '20'],
  creditType: CreditTypeEnum.Carbon,
  maturityDate: Math.floor(Date.now() / 1000) + 1000,
  totalSupply: '1000',
  totalSubscribed: '400',
  status: BondStatusEnum.Active,
  maturityStatus: BondMaturityStatusEnum.Active,
  createdAt: new Date().toISOString(),
};

const dummyHolders: HolderResponse[] = [
  { address: 'GAAA', balance: '200' },
  { address: 'GBBB', balance: '200' },
];

function buildModule() {
  return Test.createTestingModule({
    providers: [
      BondsService,

      { provide: ContractService, useValue: { invokeContractMethod: jest.fn(), simulateCall: jest.fn() } },
      { provide: StellarService, useValue: { getKeypairFromSecret: jest.fn() } },
      { provide: NonceService, useValue: { next: jest.fn().mockResolvedValue(1) } },
      { provide: RedisService, useValue: { get: jest.fn(), setEx: jest.fn(), del: jest.fn(), sMembers: jest.fn().mockResolvedValue([]) } },
      { provide: SigningKeyProvider, useValue: { adminSecret: jest.fn(), investorSecret: jest.fn() } },
      {
        provide: ConfigService,
        useValue: { getBondIssuerAddress: jest.fn().mockReturnValue('C'), getCouponEngineAddress: jest.fn().mockReturnValue('E') },
      },
      {
        provide: HolderIndexService,
        useValue: { addHolder: jest.fn(), removeHolder: jest.fn(), getHolders: jest.fn().mockResolvedValue([]) },
      },
    ],
  }).compile();
}

describe('BondsService.getBondDetail (issue #4 refresh model)', () => {
  it('returns an atomic snapshot of bond, holders, coupon, and maturity with a server timestamp', async () => {
    const moduleRef = await buildModule();
    const svc = moduleRef.get(BondsService) as any;

    const bondSpy = jest.spyOn(svc as any, 'buildBondResponse').mockResolvedValue(dummyBond);
    const holdersSpy = jest.spyOn(svc, 'getHolders').mockResolvedValue({ bondId: 7, holders: dummyHolders, total: dummyHolders.length });
    const couponSpy = jest.spyOn(svc, 'getUndistributedTotal').mockResolvedValue({ bondId: 7, undistributedTotal: '123' });

    const detail = await svc.getBondDetail(7);

    expect(bondSpy).toHaveBeenCalledWith(7);
    expect(holdersSpy).toHaveBeenCalledWith(7);
    expect(couponSpy).toHaveBeenCalledWith(7);
    expect(detail.bond).toEqual(dummyBond);
    expect(detail.holders).toEqual(dummyHolders);
    expect(detail.coupon.undistributedTotal).toBe('123');
    expect(detail.maturity.date).toBe(dummyBond.maturityDate);
    expect(detail.maturity.reached).toBe(false);
    expect(typeof detail.loadedAt).toBe('string');
    expect(Number.isNaN(Date.parse(detail.loadedAt))).toBe(false);
  });

  it('marks maturity reached when the bond status is Matured', async () => {
    const moduleRef = await buildModule();
    const svc = moduleRef.get(BondsService) as any;

    jest.spyOn(svc as any, 'buildBondResponse').mockResolvedValue({ ...dummyBond, status: BondStatusEnum.Matured });
    jest.spyOn(svc, 'getHolders').mockResolvedValue({ bondId: 7, holders: [], total: 0 });
    jest.spyOn(svc, 'getUndistributedTotal').mockResolvedValue({ bondId: 7, undistributedTotal: '0' });

    const detail = await svc.getBondDetail(7);
    expect(detail.maturity.reached).toBe(true);
    expect(detail.maturity.secondsUntil).toBe(0);
  });

  it('refreshes consistently after a mutation: a second call re-reads the source of truth', async () => {
    const moduleRef = await buildModule();
    const svc = moduleRef.get(BondsService) as any;

    const bondSpy = jest.spyOn(svc as any, 'buildBondResponse').mockResolvedValue(dummyBond);
    const holdersSpy = jest.spyOn(svc, 'getHolders').mockResolvedValue({ bondId: 7, holders: [], total: 0 });
    const couponSpy = jest.spyOn(svc, 'getUndistributedTotal').mockResolvedValue({ bondId: 7, undistributedTotal: '0' });

    await svc.getBondDetail(7);
    await svc.getBondDetail(7);

    // No caching on the service side: every reload hits the chain again, so the
    // frontend always receives fresh post-mutation data.
    expect(bondSpy).toHaveBeenCalledTimes(2);
    expect(holdersSpy).toHaveBeenCalledTimes(2);
    expect(couponSpy).toHaveBeenCalledTimes(2);
  });
});
