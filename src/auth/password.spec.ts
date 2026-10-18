import {
  hashPassword,
  MIN_ITERATIONS,
  needsRehash,
  verifyPassword,
} from './password';

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse', MIN_ITERATIONS);
    expect(stored).toMatch(/^pbkdf2-sha256\$10000\$[\w-]+\$[\w-]+$/);
    await expect(verifyPassword('correct horse', stored)).resolves.toBe(true);
    await expect(verifyPassword('correct horsE', stored)).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    const a = await hashPassword('same', MIN_ITERATIONS);
    const b = await hashPassword('same', MIN_ITERATIONS);
    expect(a).not.toBe(b);
  });

  it('never matches the legacy placeholder or malformed hashes', async () => {
    for (const stored of ['!', '', 'pbkdf2-sha256$x$a$b', 'bcrypt$10$a$b']) {
      await expect(verifyPassword('anything', stored)).resolves.toBe(false);
    }
  });

  it('asks for a rehash when the configured cost goes up', async () => {
    const stored = await hashPassword('pw', MIN_ITERATIONS);
    expect(needsRehash(stored, MIN_ITERATIONS)).toBe(false);
    expect(needsRehash(stored, MIN_ITERATIONS * 2)).toBe(true);
    expect(needsRehash('!', MIN_ITERATIONS)).toBe(true);
  });
});
