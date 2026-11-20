import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Keypair } from '@stellar/stellar-sdk';
import { RegisterProviderDto } from './register-provider.dto';

describe('RegisterProviderDto', () => {
  const validAddress = Keypair.random().publicKey();

  it('accepts a valid Stellar address and non-empty methodology', async () => {
    const dto = plainToInstance(RegisterProviderDto, {
      providerAddress: validAddress,
      methodology: 'VERRA-VCS',
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects a malformed provider address', async () => {
    const dto = plainToInstance(RegisterProviderDto, {
      providerAddress: 'not-a-stellar-address',
      methodology: 'VERRA-VCS',
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'providerAddress')).toBe(true);
  });

  it('rejects an empty methodology', async () => {
    const dto = plainToInstance(RegisterProviderDto, {
      providerAddress: validAddress,
      methodology: '',
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'methodology')).toBe(true);
  });
});
