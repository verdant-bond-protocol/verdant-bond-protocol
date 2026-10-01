import { Test, TestingModule } from '@nestjs/testing';
import { FeatureFlagsService, FeatureFlag } from './feature-flags.service';

describe('FeatureFlagsService', () => {
  let service: FeatureFlagsService;
  const originalEnv = process.env;

  beforeEach(async () => {
    jest.resetModules();
    process.env = { ...originalEnv };

    const module: TestingModule = await Test.createTestingModule({
      providers: [FeatureFlagsService],
    }).compile();

    service = module.get<FeatureFlagsService>(FeatureFlagsService);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return safe default when config is missing', () => {
    delete process.env[FeatureFlag.ENABLE_SECONDARY_MARKET];
    expect(service.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET)).toBe(false);
  });

  it('should return true when configured as "true"', () => {
    process.env[FeatureFlag.ENABLE_SECONDARY_MARKET] = 'true';
    expect(service.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET)).toBe(true);
  });

  it('should return true when configured as "1"', () => {
    process.env[FeatureFlag.ENABLE_SECONDARY_MARKET] = '1';
    expect(service.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET)).toBe(true);
  });

  it('should return false when configured as "false"', () => {
    process.env[FeatureFlag.ENABLE_SECONDARY_MARKET] = 'false';
    expect(service.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET)).toBe(false);
  });

  it('should handle getAllFlags', () => {
    process.env[FeatureFlag.ENABLE_SECONDARY_MARKET] = 'true';
    const flags = service.getAllFlags();
    expect(flags[FeatureFlag.ENABLE_SECONDARY_MARKET]).toBe(true);
  });
});
