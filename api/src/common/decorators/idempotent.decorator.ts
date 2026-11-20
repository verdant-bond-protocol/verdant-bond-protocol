import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotent';

/**
 * Marks a state-changing endpoint as idempotent (#114). When a client sends an
 * `Idempotency-Key` header, the same key replays the original result instead
 * of re-executing the mutation.
 */
export const Idempotent = (): MethodDecorator => SetMetadata(IDEMPOTENT_KEY, true);
