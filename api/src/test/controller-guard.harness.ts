import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { KycGuard } from '../common/guards/kyc.guard';
import { ProviderGuard } from '../common/guards/provider.guard';
import { IntentGuard } from '../common/guards/intent.guard';
import { RiskGuard } from '../common/risk/risk.guard';
import { fakeJwtAuthGuard, fakeAdminGuard, fakeKycGuard, fakeProviderGuard, fakeIntentGuard, fakeRiskGuard } from './guard-role-mocks';

/**
 * Boots a single controller with all auth guards replaced by header-driven
 * fakes so behavioural role tests can run without a database or passport. The
 * real guard wiring is still asserted by `route-authorization.matrix.spec.ts`.
 *
 * `configure` runs before `init()`, which is the only point where app-wide
 * pipes and filters (e.g. the `ValidationPipe` from `main.ts`) take effect.
 */
export async function buildControllerApp(
  controller: any,
  providers: any[],
  configure?: (app: INestApplication) => void,
): Promise<INestApplication> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    controllers: [controller],
    providers,
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(fakeJwtAuthGuard)
    .overrideGuard(AdminGuard)
    .useValue(fakeAdminGuard)
    .overrideGuard(KycGuard)
    .useValue(fakeKycGuard)
    .overrideGuard(ProviderGuard)
    .useValue(fakeProviderGuard)
    .overrideGuard(IntentGuard)
    .useValue(fakeIntentGuard)
    .overrideGuard(RiskGuard)
    .useValue(fakeRiskGuard)
    .compile();

  const app = moduleRef.createNestApplication();
  configure?.(app);
  await app.init();
  return app;
}
