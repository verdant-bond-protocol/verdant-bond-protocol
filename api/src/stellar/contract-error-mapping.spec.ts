import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { StrKey } from '@stellar/stellar-sdk';
import { ContractService } from './contract.service';
import {
  CONTRACT_ERROR_CLASSIFICATION,
  ContractException,
  ERROR_MAPPINGS,
  StableErrorCode,
  describeContractError,
  stableContractMessage,
} from './contract-errors';
import { Rfc7807ExceptionFilter } from '../common/filters/rfc7807-exception.filter';
import { ErrorCode, ErrorTaxonomy } from '../common/errors/error-codes';

/**
 * Contract error mapping tests for API consumers (#641).
 *
 * `contract-errors.spec.ts` guards Rust ↔ TS discriminant parity. This suite
 * guards what a *consumer* sees: the stable code, its category, whether to
 * retry, and that the code survives every hop from the Soroban RPC response to
 * the RFC 7807 problem body.
 */

const contractAddress = (seed: number) => StrKey.encodeContract(Buffer.alloc(32, seed));

const ADDRESSES = {
  BOND: contractAddress(1),
  COUPON: contractAddress(2),
  ORACLE: contractAddress(3),
  DEX: contractAddress(4),
  REGISTRY: contractAddress(5),
  CREDIT: contractAddress(6),
  UNMAPPED: contractAddress(9),
};

function makeContractService() {
  const config = {
    getBondIssuerAddress: () => ADDRESSES.BOND,
    getCouponEngineAddress: () => ADDRESSES.COUPON,
    getOracleConsumerAddress: () => ADDRESSES.ORACLE,
    getDexRouterAddress: () => ADDRESSES.DEX,
    getProjectRegistryAddress: () => ADDRESSES.REGISTRY,
    getCreditRetirementAddress: () => ADDRESSES.CREDIT,
  };
  const stellar = {
    getNetworkPassphrase: () => 'Test SDF Network ; September 2015',
    getAccount: jest.fn().mockResolvedValue({ sequence: '1' }),
  };
  const service = new ContractService(stellar as any, {} as any, config as any);
  return { service, rpc: service.getSorobanRpc() as any };
}

function simulationError(code: number) {
  // `rpc.Api.isSimulationError` checks for a string `error` field.
  return { error: `HostError: Error(Contract, #${code})`, events: [], _parsed: true };
}

function render(exception: unknown, url = '/api/test') {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host: any = {
    switchToHttp: () => ({
      getResponse: () => ({ status, setHeader: jest.fn() }),
      getRequest: () => ({ url, correlationId: 'corr-641' }),
    }),
  };
  new Rfc7807ExceptionFilter().catch(exception, host);
  return { status: (status.mock.calls[0] as unknown[])[0], body: json.mock.calls[0][0] };
}

async function simulateFailure(address: string, code: number): Promise<ContractException> {
  const { service, rpc } = makeContractService();
  rpc.simulateTransaction = jest.fn().mockResolvedValue(simulationError(code));
  try {
    await service.simulateCall({ contractAddress: address, method: 'probe', args: [] });
  } catch (error) {
    return error as ContractException;
  }
  throw new Error('expected simulateCall to throw');
}

describe('Contract error mapping for API consumers (#641)', () => {
  describe('classification table', () => {
    it('classifies every stable code (compile-time exhaustive, asserted at runtime too)', () => {
      for (const code of Object.values(StableErrorCode)) {
        expect(CONTRACT_ERROR_CLASSIFICATION[code]).toBeDefined();
      }
    });

    it('files every mapped code under the category its prefix names', () => {
      for (const [category, entries] of Object.entries(ERROR_MAPPINGS)) {
        for (const { code } of Object.values(entries)) {
          expect(describeContractError(code, 1).category).toBe(category);
        }
      }
    });

    it('only marks nonce and pause errors as automatically retryable', () => {
      const retryable = Object.values(StableErrorCode)
        .filter((code) => describeContractError(code, 1).retryable)
        .sort();
      expect(retryable).toEqual(
        [
          StableErrorCode.BOND_INVALID_NONCE,
          StableErrorCode.BOND_MIGRATION_IN_PROGRESS,
          StableErrorCode.CREDIT_INVALID_NONCE,
          StableErrorCode.DEX_INVALID_NONCE,
          StableErrorCode.DEX_LEDGER_VOLUME_EXCEEDED,
          StableErrorCode.DEX_ORACLE_PAUSED,
          StableErrorCode.GOV_INVALID_NONCE,
          StableErrorCode.ORACLE_INVALID_NONCE,
          StableErrorCode.REGISTRY_INVALID_NONCE,
        ].sort(),
      );
    });

    it('agrees with the Rust variant names in contracts/shared/src/errors.rs', () => {
      const source = fs.readFileSync(path.resolve(__dirname, '../../../contracts/shared/src/errors.rs'), 'utf8');
      const enumToCategory: Record<string, string> = {
        BondError: 'BOND', OracleError: 'ORACLE', DEXError: 'DEX',
        RegistryError: 'REGISTRY', CreditError: 'CREDIT', GovernanceError: 'GOVERNANCE',
      };
      const enumRegex = /#\[contracterror\]\s*pub\s*enum\s+(\w+)\s*\{([^}]+)\}/g;
      let checked = 0;
      let match: RegExpExecArray | null;
      while ((match = enumRegex.exec(source)) !== null) {
        const category = enumToCategory[match[1]];
        const variantRegex = /(\w+)\s*=\s*(\d+)/g;
        let variant: RegExpExecArray | null;
        while ((variant = variantRegex.exec(match[2])) !== null) {
          const [, name, value] = variant;
          const { code } = ERROR_MAPPINGS[category][Number(value)];
          const descriptor = describeContractError(code, Number(value));
          if (name === 'Unauthorized' || name === 'NotSigner') {
            expect({ name, errorClass: descriptor.errorClass }).toEqual({ name, errorClass: 'authorization' });
          }
          if (name === 'InvalidNonce') {
            expect({ name, strategy: descriptor.retryStrategy }).toEqual({ name, strategy: 'resync_nonce' });
          }
          if (/NotFound$/.test(name)) {
            expect({ name, errorClass: descriptor.errorClass }).toEqual({ name, errorClass: 'not_found' });
          }
          if (name === 'NotInitialized') {
            expect({ name, errorClass: descriptor.errorClass }).toEqual({ name, errorClass: 'configuration' });
          }
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(50);
    });

    it('treats unknown strings and unmapped raw codes as non-retryable UNKNOWN', () => {
      expect(describeContractError('NOT_A_REAL_CODE', 42)).toEqual({
        code: StableErrorCode.UNKNOWN_CONTRACT_ERROR,
        category: 'UNKNOWN',
        errorClass: 'unknown',
        retryStrategy: 'none',
        retryable: false,
      });
    });

    it('treats a contract-less submission rejection as a retryable transport failure', () => {
      expect(describeContractError(StableErrorCode.UNKNOWN_CONTRACT_ERROR)).toMatchObject({
        errorClass: 'submission',
        retryable: true,
        retryStrategy: 'backoff',
      });
    });
  });

  describe('RPC → ContractException (failure path)', () => {
    const cases: Array<[keyof typeof ADDRESSES, number, StableErrorCode]> = [
      ['BOND', 13, StableErrorCode.BOND_REDEMPTION_UNDERFUNDED],
      ['COUPON', 18, StableErrorCode.BOND_ORACLE_STALE], // coupon engine shares BondError
      ['ORACLE', 8, StableErrorCode.ORACLE_CHALLENGE_WINDOW_EXPIRED],
      ['DEX', 5, StableErrorCode.DEX_ORDER_ALREADY_FILLED],
      ['REGISTRY', 5, StableErrorCode.REGISTRY_INVALID_STATUS_TRANSITION],
      ['CREDIT', 3, StableErrorCode.CREDIT_INSUFFICIENT_CREDITS],
    ];

    it.each(cases)('%s contract error #%d maps to %s', async (contract, raw, expected) => {
      const error = await simulateFailure(ADDRESSES[contract], raw);
      expect(error).toBeInstanceOf(ContractException);
      expect(error.code).toBe(expected);
      expect(error.rawErrorCode).toBe(raw);
      expect(error.method).toBe('probe');
    });

    it('maps the same discriminant differently per contract (codes overlap across enums)', async () => {
      const bond = await simulateFailure(ADDRESSES.BOND, 4);
      const dex = await simulateFailure(ADDRESSES.DEX, 4);
      expect(bond.code).toBe(StableErrorCode.BOND_NOT_FOUND);
      expect(dex.code).toBe(StableErrorCode.DEX_ORDER_NOT_FOUND);
    });

    it('falls back to UNKNOWN_CONTRACT_ERROR for an unconfigured contract address', async () => {
      const error = await simulateFailure(ADDRESSES.UNMAPPED, 2);
      expect(error.code).toBe(StableErrorCode.UNKNOWN_CONTRACT_ERROR);
      expect(error.descriptor.retryable).toBe(false);
    });

    it('falls back to UNKNOWN_CONTRACT_ERROR for a discriminant newer than the API (enum drift)', async () => {
      const error = await simulateFailure(ADDRESSES.BOND, 999);
      expect(error.code).toBe(StableErrorCode.UNKNOWN_CONTRACT_ERROR);
      expect(error.descriptor.errorClass).toBe('unknown');
    });

    it('maps an on-ledger FAILED transaction that carries a contract code (post-simulation race)', async () => {
      const { service, rpc } = makeContractService();
      process.env.SOROBAN_POLL_INTERVAL_MS = '1';
      rpc.simulateTransaction = jest.fn().mockResolvedValue({ result: {}, transactionData: {}, minResourceFee: '0', _parsed: true });
      rpc.prepareTransaction = jest.fn().mockResolvedValue({ sign: jest.fn() });
      rpc.sendTransaction = jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'abc' });
      rpc.getTransaction = jest.fn().mockResolvedValue({ status: 'FAILED', errorResult: 'Error(Contract, #5)' });

      await expect(
        service.sendTransaction({
          contractAddress: ADDRESSES.DEX,
          method: 'execute_purchase',
          args: [],
          sourceSecretKey: 'SBK2VIYYSVG76E7VC3QHYARNFLY2EAQXDHRC7BMXBBGIFG74ARPRMNQM',
        }),
      ).rejects.toMatchObject({ code: StableErrorCode.DEX_ORDER_ALREADY_FILLED, rawErrorCode: 5 });
      delete process.env.SOROBAN_POLL_INTERVAL_MS;
    });
  });

  describe('normal path', () => {
    it('returns the simulation retval and throws nothing when the contract succeeds', async () => {
      const { service, rpc } = makeContractService();
      const retval = { ok: true };
      rpc.simulateTransaction = jest.fn().mockResolvedValue({ result: { retval }, _parsed: true });
      await expect(
        service.simulateCall({ contractAddress: ADDRESSES.BOND, method: 'get_bond', args: [] }),
      ).resolves.toBe(retval);
    });
  });

  describe('ContractException → RFC 7807 body', () => {
    it('authorization path: exposes the stable code and forbids automatic retry', async () => {
      const { status, body } = render(await simulateFailure(ADDRESSES.BOND, 2), '/bonds/1/redeem');
      expect(status).toBe(400);
      expect(body).toMatchObject({
        code: ErrorCode.SETTLEMENT_FAILED, // unchanged top-level code (backwards compatible)
        retryable: false,
        detail: stableContractMessage(StableErrorCode.BOND_UNAUTHORIZED),
        contract: {
          address: ADDRESSES.BOND,
          method: 'probe',
          rawErrorCode: 2,
          code: StableErrorCode.BOND_UNAUTHORIZED,
          category: 'BOND',
          errorClass: 'authorization',
          retryStrategy: 'none',
        },
      });
      expect(body.remediation).toMatch(/Do not retry/);
    });

    it('retry path: a stale nonce is retryable and keeps the SETTLEMENT_FAILED retry copy', async () => {
      const { body } = render(await simulateFailure(ADDRESSES.DEX, 3));
      expect(body.retryable).toBe(true);
      expect(body.detail).toBe(ErrorTaxonomy[ErrorCode.SETTLEMENT_FAILED].safeMessage);
      expect(body.contract).toMatchObject({ code: StableErrorCode.DEX_INVALID_NONCE, retryStrategy: 'resync_nonce' });
    });

    it('failure path: an underfunded pool tells the consumer to wait for a state change', async () => {
      const { body } = render(await simulateFailure(ADDRESSES.BOND, 13));
      expect(body.retryable).toBe(false);
      expect(body.contract).toMatchObject({
        code: StableErrorCode.BOND_REDEMPTION_UNDERFUNDED,
        errorClass: 'insufficient_funds',
        retryStrategy: 'after_state_change',
      });
      expect(body.remediation).toMatch(/Retry only after/);
    });

    it('never leaks the raw exception detail for a non-retryable code', () => {
      const leaky = new ContractException(
        StableErrorCode.CREDIT_UNAUTHORIZED,
        'HostError: secret-ish internal diagnostic GABC…',
        ADDRESSES.CREDIT,
        'retire',
        2,
      );
      const { body } = render(leaky);
      expect(JSON.stringify(body)).not.toContain('secret-ish');
    });
  });

  describe('service propagation (codes are not re-wrapped away)', () => {
    it('BondsService.mapBondError keeps the ContractException for unmapped bond codes', () => {
      const { BondsService } = jest.requireActual('../bonds/bonds.service');
      const underfunded = new ContractException(StableErrorCode.BOND_REDEMPTION_UNDERFUNDED, 'underfunded', ADDRESSES.BOND, 'redeem', 13);
      const mapped = (BondsService.prototype as any).mapBondError.call({}, underfunded, 1);
      expect(mapped).toBe(underfunded);
      expect(mapped).toBeInstanceOf(BadRequestException); // still a 400 for existing callers
    });

    it('DexService.mapDexError turns already-filled / not-found ContractExceptions into 409 / 404', () => {
      const { DexService } = jest.requireActual('../marketplace/dex.service');
      const map = (e: unknown) => (DexService.prototype as any).mapDexError.call({}, e);
      expect(map(new ContractException(StableErrorCode.DEX_ORDER_ALREADY_FILLED, 'filled', ADDRESSES.DEX, 'execute_purchase', 5)))
        .toBeInstanceOf(ConflictException);
      expect(map(new ContractException(StableErrorCode.DEX_ORDER_NOT_FOUND, 'missing', ADDRESSES.DEX, 'execute_purchase', 4)))
        .toBeInstanceOf(NotFoundException);
      const unauthorized = new ContractException(StableErrorCode.DEX_UNAUTHORIZED, 'nope', ADDRESSES.DEX, 'execute_purchase', 2);
      expect(map(unauthorized)).toBe(unauthorized);
    });
  });
});
