/**
 * Strict input size and cardinality limits (issue #540).
 *
 * A single walk over a decoded request body that rejects payloads which are
 * too large, too deep, or too wide before they reach business logic. It is
 * independent of DTO validation so it also protects untyped `@Body()` routes.
 *
 * Limits are checked in this order and the first violation wins, so error
 * messages are deterministic:
 *   total serialized bytes → depth → string length → array length →
 *   object key count → total node count.
 *
 * The walk is iterative (no recursion), so a hostile deeply nested payload
 * cannot overflow the stack while being measured.
 */

import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

export interface InputLimits {
  maxBytes: number;
  maxDepth: number;
  maxStringLength: number;
  maxArrayLength: number;
  maxObjectKeys: number;
  maxTotalNodes: number;
}

export const DEFAULT_INPUT_LIMITS: Readonly<InputLimits> = Object.freeze({
  maxBytes: 256 * 1024,
  maxDepth: 12,
  maxStringLength: 16 * 1024,
  maxArrayLength: 1000,
  maxObjectKeys: 200,
  maxTotalNodes: 20000,
});

export type InputLimitViolationCode =
  | 'payload_too_large'
  | 'too_deep'
  | 'string_too_long'
  | 'array_too_long'
  | 'too_many_keys'
  | 'too_many_nodes'
  | 'unserializable';

export interface InputLimitViolation {
  code: InputLimitViolationCode;
  path: string;
  limit: number;
  actual: number;
}

export function checkInputLimits(value: unknown, overrides: Partial<InputLimits> = {}): InputLimitViolation | null {
  const limits: InputLimits = { ...DEFAULT_INPUT_LIMITS, ...overrides };

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { code: 'unserializable', path: '$', limit: 0, actual: 0 };
  }
  const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
  if (bytes > limits.maxBytes) {
    return { code: 'payload_too_large', path: '$', limit: limits.maxBytes, actual: bytes };
  }

  const stack: Array<{ node: unknown; path: string; depth: number }> = [{ node: value, path: '$', depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { node, path, depth } = stack.pop() as { node: unknown; path: string; depth: number };
    nodes += 1;
    if (nodes > limits.maxTotalNodes) {
      return { code: 'too_many_nodes', path, limit: limits.maxTotalNodes, actual: nodes };
    }
    if (depth > limits.maxDepth) {
      return { code: 'too_deep', path, limit: limits.maxDepth, actual: depth };
    }
    if (typeof node === 'string') {
      if (node.length > limits.maxStringLength) {
        return { code: 'string_too_long', path, limit: limits.maxStringLength, actual: node.length };
      }
    } else if (Array.isArray(node)) {
      if (node.length > limits.maxArrayLength) {
        return { code: 'array_too_long', path, limit: limits.maxArrayLength, actual: node.length };
      }
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push({ node: node[i], path: `${path}[${i}]`, depth: depth + 1 });
    } else if (node !== null && typeof node === 'object') {
      const keys = Object.keys(node as Record<string, unknown>);
      if (keys.length > limits.maxObjectKeys) {
        return { code: 'too_many_keys', path, limit: limits.maxObjectKeys, actual: keys.length };
      }
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        const key = keys[i];
        if (key.length > limits.maxStringLength) {
          return { code: 'string_too_long', path: `${path}.<key>`, limit: limits.maxStringLength, actual: key.length };
        }
        stack.push({ node: (node as Record<string, unknown>)[key], path: `${path}.${key}`, depth: depth + 1 });
      }
    }
  }
  return null;
}

export function assertInputLimits(value: unknown, overrides: Partial<InputLimits> = {}): void {
  const violation = checkInputLimits(value, overrides);
  if (violation) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'input_limit_exceeded',
      message: `Input limit exceeded (${violation.code}) at ${violation.path}: ${violation.actual} > ${violation.limit}`,
      violation,
    });
  }
}

/**
 * Route-level pipe: `@Body(new InputLimitsPipe({ maxArrayLength: 100 }))`.
 * Only bodies are checked; params and queries are already bounded by the
 * HTTP server's URL limits.
 */
@Injectable()
export class InputLimitsPipe implements PipeTransform {
  constructor(private readonly overrides: Partial<InputLimits> = {}) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type === 'body') assertInputLimits(value, this.overrides);
    return value;
  }
}
