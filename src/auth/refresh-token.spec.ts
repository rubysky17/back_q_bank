import {
  formatRefreshToken,
  hashSecret,
  newSecret,
  parseRefreshToken,
  sameHash,
} from './refresh-token';

const SESSION_ID = '0199e3a4-5b6c-7d8e-9f01-23456789abcd';

describe('refresh token helpers', () => {
  it('round-trips a formatted token', () => {
    const secret = newSecret();
    expect(parseRefreshToken(formatRefreshToken(SESSION_ID, secret))).toEqual({
      sessionId: SESSION_ID,
      secret,
    });
  });

  it.each([
    '',
    'no-dot',
    `not-a-uuid.${'x'.repeat(40)}`,
    `${SESSION_ID}.short`,
  ])('rejects malformed token %j', (token) => {
    expect(parseRefreshToken(token)).toBeNull();
  });

  it('compares hashes in constant time and handles missing values', () => {
    const hash = hashSecret('secret-value');
    expect(sameHash(hash, hashSecret('secret-value'))).toBe(true);
    expect(sameHash(hash, hashSecret('other-value'))).toBe(false);
    expect(sameHash(null, hash)).toBe(false);
  });
});
