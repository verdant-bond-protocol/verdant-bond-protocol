#!/usr/bin/env node
/**
 * Release Gate Verification Script (#473)
 *
 * Pre-release gate verification tool for CI/CD and deployment pipelines.
 * Evaluates contract/API schema compatibility, callable interface coverage,
 * and storage fixture alignment.
 *
 * Usage:
 *   npm run release:gate
 *   npm run release:gate -- --json
 */
import 'reflect-metadata';
import { ConfigService } from '../src/config/config.service';
import { ContractService } from '../src/stellar/contract.service';
import { StellarService } from '../src/stellar/stellar.service';
import { NonceService } from '../src/common/services/nonce.service';
import { ReleaseGateService } from '../src/status/release-gate/release-gate.service';
import { ReleaseGateStatus } from '../src/status/release-gate/release-gate.interface';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');

  const configService = new ConfigService();
  const stellarService = new StellarService();
  const contractService = new ContractService(stellarService, {} as any, configService);
  const releaseGateService = new ReleaseGateService(configService, contractService);

  let evaluation;
  try {
    evaluation = await releaseGateService.evaluateReleaseGate(true);
  } catch (err: any) {
    if (isJson) {
      console.log(JSON.stringify({ error: 'Release gate evaluation threw unexpected error', details: err?.message }, null, 2));
    } else {
      console.error(`[ERROR] Release gate evaluation failed: ${err?.message}`);
    }
    process.exit(1);
  }

  if (isJson) {
    console.log(JSON.stringify(evaluation, null, 2));
  } else {
    console.log('\n================================================================================');
    console.log('       VERDANT BOND PROTOCOL - CONTRACT & API RELEASE GATE (#473)              ');
    console.log('================================================================================');
    console.log(`Evaluated At : ${evaluation.evaluatedAt}`);
    console.log(`Gate Status  : ${evaluation.gateStatus}`);
    console.log(`Schema Ver   : ${evaluation.schemaVersion}`);
    console.log(`Compatible   : ${evaluation.overallCompatible ? 'YES' : 'NO'}`);
    console.log('--------------------------------------------------------------------------------');
    console.log('CONTRACT COMPATIBILITY MATRIX:');
    console.log('--------------------------------------------------------------------------------');

    for (const [contractName, report] of Object.entries(evaluation.contracts)) {
      const icon = report.status === 'COMPATIBLE' ? '[PASS]' : '[FAIL]';
      const addrSnippet = report.address ? `${report.address.slice(0, 16)}...` : 'UNCONFIGURED';
      console.log(
        `${icon} ${contractName.padEnd(18)} | Addr: ${addrSnippet.padEnd(19)} | Deployed v${report.deployedSchemaVersion} (Expected v${report.expectedSchemaVersion}) | Status: ${report.status}`,
      );
    }

    console.log('--------------------------------------------------------------------------------');
    console.log(
      `STORAGE FIXTURES: ${evaluation.storageValidation.verified ? '[PASS] Verified' : '[FAIL] Mismatch'} (${evaluation.storageValidation.fixtureCount} entries checked)`,
    );

    if (evaluation.violations.length > 0) {
      console.log('--------------------------------------------------------------------------------');
      console.log('VIOLATIONS DETECTED:');
      for (const violation of evaluation.violations) {
        console.log(` - ${violation}`);
      }
    }

    if (evaluation.rollbackRecommendations.length > 0) {
      console.log('--------------------------------------------------------------------------------');
      console.log('RECOMMENDED ACTIONS / ROLLBACK GUIDANCE:');
      for (const rec of evaluation.rollbackRecommendations) {
        console.log(` -> ${rec}`);
      }
    }

    if (evaluation.bypass?.bypassed) {
      console.log('--------------------------------------------------------------------------------');
      console.log(`[ATTENTION] Release Gate is currently BYPASSED by ${evaluation.bypass.bypassedBy}`);
      console.log(`Reason: ${evaluation.bypass.reason}`);
    }

    console.log('================================================================================\n');
  }

  if (evaluation.gateStatus === ReleaseGateStatus.COMPATIBLE || evaluation.gateStatus === ReleaseGateStatus.BYPASSED) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[CRITICAL] Unhandled error during release gate execution:', err);
  process.exit(1);
});
