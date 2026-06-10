import { describe, it, expect } from 'vitest';
import { buildImageFilename, dedupeImageUrls, extFromUrl, safeFolderName, pickProductImages } from '../src/crawler/imageHarvest.js';

describe('buildImageFilename', () => {
  it('uses the plain name for a single image', () => {
    expect(buildImageFilename('FRANKE-', '133.0440.351', 0, 1, 'jpg')).toBe('FRANKE-133.0440.351.jpg');
  });
  it('indexes from _0 when there are several', () => {
    expect(buildImageFilename('FRANKE-', '133.0440.351', 0, 3, 'jpg')).toBe('FRANKE-133.0440.351_0.jpg');
    expect(buildImageFilename('FRANKE-', '133.0440.351', 2, 3, 'jpg')).toBe('FRANKE-133.0440.351_2.jpg');
  });
});

describe('dedupeImageUrls', () => {
  it('keeps the largest cache variant of the same photo', () => {
    const out = dedupeImageUrls([
      'https://x/image/cache/catalog/valve-228x228.jpg',
      'https://x/image/cache/catalog/valve-500x500.jpg',
      'https://x/image/cache/catalog/other-228x228.jpg',
    ]);
    expect(out).toEqual([
      'https://x/image/cache/catalog/valve-500x500.jpg',
      'https://x/image/cache/catalog/other-228x228.jpg',
    ]);
  });
  it('prefers the original over any resized variant', () => {
    const out = dedupeImageUrls([
      'https://x/image/cache/catalog/valve-1000x1000.jpg',
      'https://x/image/catalog/valve.jpg',
    ]);
    expect(out).toEqual(['https://x/image/catalog/valve.jpg']);
  });
});

describe('pickProductImages', () => {
  const urls = [
    'https://x/image/cache/catalog/shopimages/133.0440.351-600x315w.jpg', // main
    'https://x/image/cache/catalog/shopimages/133.0440.351-2-74x74w.jpg', // gallery thumb
    'https://x/image/cache/catalog/shopimages/120.0551.219-150x150.jpg',  // related product
    'https://x/image/cache/catalog/central-logo-135x150.jpg',             // site furniture
    'https://x/some/other/link',
  ];
  it('keeps only images named after the product code', () => {
    const out = pickProductImages(urls, '133.0440.351');
    expect(out).toHaveLength(2);
    expect(out.every((u) => u.includes('133.0440.351'))).toBe(true);
  });
  it('handles size variants with a letter suffix', () => {
    const out = pickProductImages([
      'https://x/image/cache/catalog/shopimages/133.1-74x74w.jpg',
      'https://x/image/cache/catalog/shopimages/133.1-600x315w.jpg',
    ], '133.1');
    expect(out).toEqual(['https://x/image/cache/catalog/shopimages/133.1-600x315w.jpg']);
  });
  it('returns empty when nothing matches the code', () => {
    expect(pickProductImages(urls, '999.9999.999')).toEqual([]);
  });
});

describe('helpers', () => {
  it('extFromUrl', () => {
    expect(extFromUrl('https://x/a.JPG?v=2')).toBe('jpg');
    expect(extFromUrl('https://x/a.jpeg')).toBe('jpg');
    expect(extFromUrl('https://x/a.webp')).toBe('webp');
    expect(extFromUrl('https://x/no-ext')).toBe('jpg');
  });
  it('safeFolderName strips path characters', () => {
    expect(safeFolderName('133.0440.351')).toBe('133.0440.351');
    expect(safeFolderName('a/b\\c:d')).toBe('a_b_c_d');
  });
});
