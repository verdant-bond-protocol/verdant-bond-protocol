import { ValidationPipe } from '@nestjs/common';

/**
 * The app-wide `ValidationPipe` registered in `main.ts`, exported so contract
 * tests exercise exactly the transform/validation options production runs
 * with (in particular `enableImplicitConversion`, which large-integer amount
 * fields must defend against — see `IsMinorUnitsString`).
 */
export function createGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
    validationError: { target: false, value: false },
  });
}
