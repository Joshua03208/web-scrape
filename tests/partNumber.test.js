import { describe, it, expect } from 'vitest';
import { normalisePartNumber, buildPartNumberRegex } from '../src/extract/partNumber.js';

describe('normalisePartNumber', () => {
  it('uppercases and strips spaces and dashes', () => {
    expect(normalisePartNumber('133.0440-351 a')).toBe('133.0440351A');
  });
});

describe('buildPartNumberRegex', () => {
  const re = buildPartNumberRegex(['133.', '112.']);
  it('matches a full part number with a known prefix', () => {
    expect('Code: 133.0440.351 here'.match(re)[0]).toBe('133.0440.351');
    expect('112.0021.45'.match(re)[0]).toBe('112.0021.45');
  });
  it('does not match other prefixes', () => {
    expect('999.0440.351'.match(re)).toBeNull();
  });
  it('does not match the bare prefix alone', () => {
    expect('see section 133. for details'.match(re)).toBeNull();
  });
  it('does not match when prefix is inside a longer number', () => {
    expect('5133.0440.351'.match(re)).toBeNull();
  });
});
