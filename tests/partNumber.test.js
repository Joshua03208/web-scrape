import { describe, it, expect } from 'vitest';
import { normalisePartNumber, buildPartNumberRegex } from '../src/extract/partNumber.js';

describe('normalisePartNumber', () => {
  it('uppercases and strips spaces, dashes and dots', () => {
    expect(normalisePartNumber('133.0440-351 a')).toBe('1330440351A');
    expect(normalisePartNumber('133.0440.351')).toBe('1330440351');
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
  it('does not match a price that starts with the prefix digits', () => {
    expect('£133.50'.match(re)).toBeNull();
    expect('£ 133.50'.match(re)).toBeNull();
  });
  it('still matches a part number after a colon or space', () => {
    expect('Product Code: 133.0008.411'.match(re)[0]).toBe('133.0008.411');
  });
  it('does not match a suffix-currency price', () => {
    expect('133.50 GBP'.match(re)).toBeNull();
    expect('shipping 133.50 GBP today'.match(re)).toBeNull();
  });
  it('does not match with extra spaces after a currency symbol', () => {
    expect('£   133.50'.match(re)).toBeNull();
  });
  it('matches a part number at the end of a sentence', () => {
    expect('order 133.0440.351.'.match(re)[0]).toBe('133.0440.351');
  });
  it('keeps letter suffixes on part numbers (cold/hot variants)', () => {
    expect('133.0438.152C'.match(re)[0]).toBe('133.0438.152C');
    expect('Code: 133.0069.376H here'.match(re)[0]).toBe('133.0069.376H');
  });
  it('does not glom a following word onto the code', () => {
    expect('133.0440.351 COLD'.match(re)[0]).toBe('133.0440.351');
  });
});
