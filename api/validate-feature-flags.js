const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./dist/app.module');
const { FeatureFlagsService, FeatureFlag } = require('./dist/config/feature-flags.service');
const { DexService } = require('./dist/marketplace/dex.service');

async function validate() {
  console.log('--- Feature Flag Validation Script ---');
  
  // Set default env if needed to run the app, but we only care about the service testing
  process.env.BOND_ISSUER_ADDRESS = 'test';
  process.env.COUPON_ENGINE_ADDRESS = 'test';
  process.env.DEX_ROUTER_ADDRESS = 'test';
  process.env.PROJECT_REGISTRY_ADDRESS = 'test';
  process.env.ORACLE_CONSUMER_ADDRESS = 'test';
  process.env.CREDIT_RETIREMENT_ADDRESS = 'test';
  
  console.log('1. Testing Disabled State (Default)');
  delete process.env.ENABLE_SECONDARY_MARKET;
  
  try {
    const app = await NestFactory.createApplicationContext(AppModule);
    const featureFlagsService = app.get(FeatureFlagsService);
    const dexService = app.get(DexService);
    
    console.log('Flag ENABLE_SECONDARY_MARKET is:', featureFlagsService.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET));
    if (featureFlagsService.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET) !== false) {
      throw new Error('Default should be false');
    }
    
    let caught = false;
    try {
      await dexService.buyBondTokens({ orderId: 1, amount: '10', maxPrice: '10' }, 'test');
    } catch (err) {
      caught = true;
      console.log('Expected error caught on buyBondTokens when disabled:', err.message);
    }
    if (!caught) throw new Error('buyBondTokens did not throw when disabled');
    
    console.log('\n2. Testing Enabled State');
    process.env.ENABLE_SECONDARY_MARKET = 'true';
    
    // We can't re-instantiate process.env easily without restarting process for NestJS sometimes,
    // but our FeatureFlagsService reads dynamically.
    console.log('Flag ENABLE_SECONDARY_MARKET is:', featureFlagsService.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET));
    if (featureFlagsService.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET) !== true) {
      throw new Error('Should be true');
    }
    
    console.log('\nValidation successful!');
    process.exit(0);
  } catch (err) {
    console.error('Validation failed:', err);
    process.exit(1);
  }
}

validate();
