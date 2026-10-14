import type { ValidationError } from 'class-validator';

import { AppError } from './app-error.js';

export interface FieldError {
  field: string;
  messages: string[];
}

function flatten(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own: FieldError[] = error.constraints
      ? [{ field, messages: Object.values(error.constraints) }]
      : [];
    return [...own, ...flatten(error.children ?? [], field)];
  });
}

/** ValidationPipe factory: one readable `message` string plus per-field `details`. */
export function validationExceptionFactory(errors: ValidationError[]) {
  const details = flatten(errors);
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
