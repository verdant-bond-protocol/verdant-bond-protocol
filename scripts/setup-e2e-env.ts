import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { Keypair } from '@stellar/stellar-sdk';

const envPath = path.resolve(__dirname, '../.env');

function fundAccount(address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = `https://friendbot.stellar.org/?addr=${address}`;
    console.log(`Funding account ${address} via Friendbot...`);
    
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`✓ Account ${address} funded successfully.`);
          resolve();
        } else {
          reject(new Error(`Friendbot failed with status ${res.statusCode}: ${data}`));
        }
      });
    }).on('error', (err) => reject(err));
  });
}

async function fundWithRetry(address: string, retries = 5): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await fundAccount(address);
      return;
    } catch (err: any) {
      console.warn(`Friendbot failed (attempt ${i + 1}/${retries}): ${err.message}. Retrying...`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    }
  }
  throw new Error(`Failed to fund account ${address} after ${retries} attempts`);
}

async function setup() {
  console.log("=== Setting up E2E Test environment ===");

  // 1. Generate keys
  const admin = Keypair.random();
  const user = Keypair.random();
  const investor = Keypair.random();
  const provider = Keypair.random();

  console.log("Generated Admin:", admin.publicKey());
  console.log("Generated User:", user.publicKey());
  console.log("Generated Investor:", investor.publicKey());
  console.log("Generated Provider:", provider.publicKey());

  // 2. Fund all wallets
  await fundWithRetry(admin.publicKey());
  await fundWithRetry(user.publicKey());
  await fundWithRetry(investor.publicKey());
  await fundWithRetry(provider.publicKey());

  // 3. Write .env
  const envContent = `
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_PUBLIC_KEY=${admin.publicKey()}

ADMIN_SECRET_KEY=${admin.secret()}
USER_SECRET_KEY=${user.secret()}
INVESTOR_SECRET_KEY=${investor.secret()}
PROVIDER_SECRET_KEY=${provider.secret()}

ORACLE_PROVIDER_WHITELIST=${provider.publicKey()}
DEFAULT_PROVIDER_ADDRESS=${provider.publicKey()}

JWT_SECRET=dev-jwt-secret-key-that-is-very-long-and-secure
JWT_EXPIRY=15m
JWT_REFRESH_SECRET=dev-refresh-jwt-secret-key-that-is-very-long-and-secure
JWT_REFRESH_EXPIRY=7d
KYC_PROVIDER_URL=https://kyc.mock-provider.com
KYC_API_KEY=mock-key

DATABASE_URL=postgresql://nbs:nbs@localhost:5432/verdant_bond
REDIS_URL=redis://localhost:6379

PORT=3000
NODE_ENV=test
LOG_LEVEL=debug
`;

  fs.writeFileSync(envPath, envContent.trim() + '\n');
  console.log("✓ Root .env file created successfully.");
  
  // Also copy to api/.env so NestJS can load it
  const apiEnvPath = path.resolve(__dirname, '../api/.env');
  fs.writeFileSync(apiEnvPath, envContent.trim() + '\n');
  console.log("✓ API .env file created successfully.");
}

setup().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
