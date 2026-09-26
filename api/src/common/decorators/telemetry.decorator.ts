import { applyDecorators } from '@nestjs/common';

export function Telemetry(
  operationName: string,
  options?: {
    actorType?: 'user' | 'service' | 'system' | 'admin';
  },
) {
  return function (
    target: any,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const startTime = Date.now();
      const telemetry = (this as any).telemetry;

      try {
        const result = await originalMethod.apply(this, args);
        telemetry?.emit({
          operation: operationName,
          actorType: options?.actorType || 'system',
          result: 'success',
          durationMs: Date.now() - startTime,
          correlationId: (this as any).correlationId || 'unknown',
        });
        return result;
      } catch (error) {
        telemetry?.emit({
          operation: operationName,
          actorType: options?.actorType || 'system',
          result: 'failure',
          durationMs: Date.now() - startTime,
          correlationId: (this as any).correlationId || 'unknown',
          error: (error as Error).message,
          errorCode: (error as any).code || (error as any).statusCode,
        });
        throw error;
      }
    };

    return descriptor;
  };
}
