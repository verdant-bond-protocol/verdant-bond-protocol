import { BondsController } from './bonds.controller';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { IntentGuard } from '../common/guards/intent.guard';
import { ForbiddenException } from '@nestjs/common';

describe('BondsController guards & authorization', () => {
  const GUARDS_METADATA = '__guards__';

  it('guards POST /:id/sweep-undistributed with JWT + Permissions + Intent guards', () => {
    const guards: unknown[] = Reflect.getMetadata(
      GUARDS_METADATA,
      BondsController.prototype.sweepUndistributed,
    );
    expect(guards).toEqual([JwtAuthGuard, PermissionsGuard, IntentGuard]);
  });

  it('guards GET /held/:address with JwtAuthGuard', () => {
    const guards: unknown[] = Reflect.getMetadata(
      GUARDS_METADATA,
      BondsController.prototype.findHeldByAddress,
    );
    expect(guards).toEqual([JwtAuthGuard]);
  });

  it('exposes GET /:id/holders as a public endpoint by documented on-chain intent', () => {
    const guards: unknown[] = Reflect.getMetadata(
      GUARDS_METADATA,
      BondsController.prototype.getHolders,
    );
    expect(guards).toBeUndefined();
  });

  it('exposes GET /:id/undistributed as a read-only public endpoint', () => {
    const guards: unknown[] = Reflect.getMetadata(
      GUARDS_METADATA,
      BondsController.prototype.getUndistributedTotal,
    );
    expect(guards).toBeUndefined();
  });

  it('exposes GET /:id/claimable-credits as a read-only public endpoint', () => {
    const guards: unknown[] = Reflect.getMetadata(
      GUARDS_METADATA,
      BondsController.prototype.getClaimableCredits,
    );
    expect(guards).toBeUndefined();
  });

  describe('findHeldByAddress authorization', () => {
    let mockBondsService: any;
    let controller: BondsController;
    const userWallet = 'GUSER123456789012345678901234567890123456789012345678901';
    const otherWallet = 'GOTHER12345678901234567890123456789012345678901234567890';
    const adminWallet = 'GADMIN12345678901234567890123456789012345678901234567890';

    beforeEach(() => {
      process.env.STELLAR_PUBLIC_KEY = adminWallet;
      mockBondsService = {
        findHeldByAddress: jest.fn().mockResolvedValue([{ bondId: 1, balance: '100' }]),
        getHolders: jest.fn().mockResolvedValue({ totalHolders: 1, holders: [] }),
      };
      controller = new BondsController(mockBondsService);
    });

    it('allows authenticated user to view their own holdings', async () => {
      const req = { user: { walletAddress: userWallet } };
      const res = await controller.findHeldByAddress(userWallet, req);

      expect(mockBondsService.findHeldByAddress).toHaveBeenCalledWith(userWallet);
      expect(res).toEqual([{ bondId: 1, balance: '100' }]);
    });

    it('allows admin to view any wallet holdings', async () => {
      const req = { user: { walletAddress: adminWallet } };
      const res = await controller.findHeldByAddress(otherWallet, req);

      expect(mockBondsService.findHeldByAddress).toHaveBeenCalledWith(otherWallet);
      expect(res).toEqual([{ bondId: 1, balance: '100' }]);
    });

    it('throws ForbiddenException when a non-admin queries another wallet holdings', async () => {
      const req = { user: { walletAddress: userWallet } };

      await expect(controller.findHeldByAddress(otherWallet, req)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockBondsService.findHeldByAddress).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when unauthenticated (no req.user)', async () => {
      const req = {};

      await expect(controller.findHeldByAddress(userWallet, req)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockBondsService.findHeldByAddress).not.toHaveBeenCalled();
    });
  });
});
