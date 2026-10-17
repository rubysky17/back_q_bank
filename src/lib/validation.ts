import type { Context } from 'hono';
import { z } from 'zod';

import { AppError } from './app-error';

// workerd forbids `new Function`; never let zod try its JIT fast path.
z.config({ jitless: true });

export interface FieldError {
  field: string;
  messages: string[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Any 8-4-4-4-12 hex id (same leniency as the old class-validator @IsUUID), normalised to lowercase. */
export const zId = () =>
  z
    .string()
    .regex(UUID_RE, { error: 'must be a UUID' })
    .transform((value) => value.toLowerCase());

/** Non-empty list of distinct ids. */
export const zIdList = (field: string, max?: number) => {
  const base = z.array(zId()).min(1);
  return (max === undefined ? base : base.max(max)).refine(
    (ids) => new Set(ids).size === ids.length,
    { error: `All ${field}'s elements must be unique` },
  );
};

/** Trimmed string; `max` counts characters after trimming. */
export const zTrimmed = (max: number) => z.string().trim().max(max);

/** Required, non-empty trimmed string. */
export const zName = (max: number) =>
  z.string().trim().min(1, { error: 'should not be empty' }).max(max);

/** `?page=&limit=` with the API's defaults; spread into a list endpoint's query schema. */
export const paginationFields = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

function describe(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined
        ? 'is required'
        : `must be ${issue.expected === 'array' ? 'an' : 'a'} ${issue.expected}`;
    case 'too_small':
      if (issue.origin === 'string') {
        return Number(issue.minimum) <= 1
          ? 'should not be empty'
          : `must be at least ${issue.minimum} characters`;
      }
      if (issue.origin === 'array' || issue.origin === 'set') {
        return `must contain at least ${issue.minimum} elements`;
      }
      return `must not be less than ${issue.minimum}`;
    case 'too_big':
      if (issue.origin === 'string') {
        return `must be at most ${issue.maximum} characters`;
      }
      if (issue.origin === 'array' || issue.origin === 'set') {
        return `must contain no more than ${issue.maximum} elements`;
      }
      return `must not be greater than ${issue.maximum}`;
    case 'invalid_format':
      return issue.format === 'email' ? 'must be an email' : issue.message;
    case 'invalid_value':
      return `must be one of the following values: ${issue.values.join(', ')}`;
    case 'not_multiple_of':
      return `must be a multiple of ${issue.divisor}`;
    default:
      return issue.message;
  }
}

/** zod issues → per-field messages, class-validator style ("email must be an email"). */
export function toFieldErrors(issues: z.core.$ZodIssue[]): FieldError[] {
  const byField = new Map<string, string[]>();
  const add = (field: string, message: string) =>
    byField.set(field, [...(byField.get(field) ?? []), message]);

  for (const issue of issues) {
    const path = issue.path.map(String);
    if (issue.code === 'unrecognized_keys') {
      // One entry per unexpected property, so clients can highlight each.
      for (const key of issue.keys) {
        add([...path, key].join('.'), `property ${key} should not exist`);
      }
      continue;
    }
    const field = path.join('.') || 'body';
    add(field, `${field} ${describe(issue)}`);
  }
  return [...byField].map(([field, messages]) => ({ field, messages }));
}

/** One readable `message` string (first 3 problems) plus per-field `details`. */
export function validationError(issues: z.core.$ZodIssue[]) {
  const details = toFieldErrors(issues);
  const messages = details.flatMap((detail) => detail.messages);
  const shown = messages.slice(0, 3).join('; ');
  const message =
    messages.length > 3 ? `${shown} (+${messages.length - 3} more)` : shown;
  return AppError.badRequest(
    'VALIDATION_ERROR',
    message || 'Invalid request',
    details,
  );
}

export function parseWithSchema<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error.issues);
  return result.data;
}

/** Validates the JSON body. An empty body counts as `{}` (so missing fields are reported). */
export async function parseBody<T>(c: Context, schema: z.ZodType<T>) {
  const text = await c.req.text();
  let input: unknown = {};
  if (text.trim() !== '') {
    try {
      input = JSON.parse(text);
    } catch {
      throw AppError.badRequest(
        'BAD_REQUEST',
        'Request body is not valid JSON',
      );
    }
  }
  return parseWithSchema(schema, input);
}

export function parseQuery<T>(c: Context, schema: z.ZodType<T>): T {
  return parseWithSchema(schema, c.req.query());
}

/** A UUID path parameter; anything else is a 400 (like Nest's ParseUUIDPipe). */
export function idParam(c: Context, name = 'id'): string {
  const value = c.req.param(name);
  if (!value || !UUID_RE.test(value)) {
    throw AppError.badRequest(
      'BAD_REQUEST',
      'Validation failed (uuid is expected)',
    );
  }
  return value.toLowerCase();
}
