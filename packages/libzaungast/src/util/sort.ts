// Deterministic, locale-INDEPENDENT string order (UTF-16 code-unit order). Use wherever order
// must be reproducible across machines/locales — filename scans, and especially anything feeding
// a hash or cache signature — where the default `.sort()` is flagged and `localeCompare` would be
// a portability bug (locale collation differs per machine). Written with plain comparisons (not a
// nested ternary) so it reads clearly and satisfies S3358.
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
