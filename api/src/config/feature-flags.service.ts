import { Injectable } from '@nestjs/common';

export enum FeatureFlag {
  ENABLE_SECONDARY_MARKET = 'ENABLE_SECONDARY_MARKET',
}

const DEFAULT_FLAGS: Record<FeatureFlag, boolean> = {
  [FeatureFlag.ENABLE_SECONDARY_MARKET]: false, // Safe default: disabled
};

@Injectable()
export class FeatureFlagsService {
  constructor() {}

  isEnabled(flag: FeatureFlag): boolean {
    const envValue = process.env[flag];
    if (envValue !== undefined) {
      return envValue.toLowerCase() === 'true' || envValue === '1';
    }
    return DEFAULT_FLAGS[flag];
  }

  getAllFlags(): Record<string, boolean> {
    const flags: Record<string, boolean> = {};
    for (const flag of Object.values(FeatureFlag)) {
      flags[flag] = this.isEnabled(flag);
    }
    return flags;
  }
}
