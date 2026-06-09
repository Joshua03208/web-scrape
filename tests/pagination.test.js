import { describe, it, expect } from 'vitest';
import { buildSearchUrl } from '../src/extract/pagination.js';

describe('buildSearchUrl', () => {
  const base = 'https://central-servicesuk.co.uk/';
  const pattern = 'index.php?route=product/search&search={query}&page={page}';

  it('substitutes query and page, resolving against base url', () => {
    expect(buildSearchUrl(pattern, base, '133.', 2)).toBe(
      'https://central-servicesuk.co.uk/index.php?route=product/search&search=133.&page=2'
    );
  });
  it('URL-encodes the query', () => {
    expect(buildSearchUrl(pattern, base, 'a b&c', 1)).toContain('search=a%20b%26c');
  });
  it('accepts absolute patterns', () => {
    expect(buildSearchUrl('https://other.com/s?q={query}&p={page}', base, 'x', 3)).toBe(
      'https://other.com/s?q=x&p=3'
    );
  });
});
