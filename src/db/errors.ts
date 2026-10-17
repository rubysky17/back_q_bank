/** Messages of the error and its causes (Drizzle wraps D1 errors in DrizzleQueryError.cause). */
function messages(error: unknown): string[] {
  const found: string[] = [];
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    if (current instanceof Error) found.push(current.message);
    else if (typeof current === 'string') found.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return found;
}

/**
 * SQLite reports the columns of the violated unique index, e.g.
 * "UNIQUE constraint failed: Attempt.userId, Attempt.examId". Pass them to match one index only.
 */
export function isUniqueViolation(error: unknown, columns?: string) {
  return messages(error).some(
    (message) =>
      message.includes('UNIQUE constraint failed') &&
      (columns === undefined || message.includes(columns)),
  );
}

export function isForeignKeyViolation(error: unknown) {
  return messages(error).some((message) =>
    message.includes('FOREIGN KEY constraint failed'),
  );
}
