// LocationDto uses @Type()/@ValidateNested(), which need the reflect-metadata
// polyfill (normally loaded implicitly via Nest's bootstrap, but jest specs
// run outside of that) to resolve the nested class at validation time.
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateProjectDto } from './create-project.dto';

describe('CreateProjectDto', () => {
  const validPayload = {
    name: 'Amazon Reforestation Phase 3',
    methodology: 'VERRA-VCS',
    country: 'BR',
    location: { lat: -3.4653, lng: -62.2159 },
    totalAreaHa: 10000,
    carbonSequestrationEstimate: 50000,
    blueCarbon: false,
  };

  it('accepts a valid payload', async () => {
    const dto = plainToInstance(CreateProjectDto, validPayload);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects an unrecognized methodology code', async () => {
    const dto = plainToInstance(CreateProjectDto, { ...validPayload, methodology: 'VM0015' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'methodology')).toBe(true);
  });

  it('rejects a malformed country code', async () => {
    const dto = plainToInstance(CreateProjectDto, { ...validPayload, country: 'Brazil' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'country')).toBe(true);
  });

  it('rejects an out-of-range latitude', async () => {
    const dto = plainToInstance(CreateProjectDto, {
      ...validPayload,
      location: { lat: 95, lng: -62.2159 },
    });
    const errors = await validate(dto);
    const locationError = errors.find((e) => e.property === 'location');
    expect(locationError).toBeDefined();
  });

  it('rejects an out-of-range longitude', async () => {
    const dto = plainToInstance(CreateProjectDto, {
      ...validPayload,
      location: { lat: -3.4653, lng: 200 },
    });
    const errors = await validate(dto);
    const locationError = errors.find((e) => e.property === 'location');
    expect(locationError).toBeDefined();
  });

  it('rejects a missing location', async () => {
    const payload: Record<string, unknown> = { ...validPayload };
    delete payload.location;
    const dto = plainToInstance(CreateProjectDto, payload);
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'location')).toBe(true);
  });

  it('rejects zero/negative numeric fields', async () => {
    const dto = plainToInstance(CreateProjectDto, {
      ...validPayload,
      totalAreaHa: 0,
      carbonSequestrationEstimate: -5,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'totalAreaHa')).toBe(true);
    expect(errors.some((e) => e.property === 'carbonSequestrationEstimate')).toBe(true);
  });
});
