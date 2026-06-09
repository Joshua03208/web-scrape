export function buildSearchUrl(pattern, baseUrl, query, page) {
  const filled = pattern
    .replaceAll('{query}', encodeURIComponent(query))
    .replaceAll('{page}', String(page));
  return new URL(filled, baseUrl).href;
}
