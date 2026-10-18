import { InputError } from '@backstage/errors';
import { z } from 'zod';

/** Validates request input; every failure becomes a 400 listing each issue. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new InputError(r.error.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  return r.data;
}
