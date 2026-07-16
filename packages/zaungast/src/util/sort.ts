// Deterministic, locale-INDEPENDENT string order (UTF-16 code-unit order). Copied from the library
// (it is eight lines of generic comparator with no domain meaning — a public export would be a
// forever-contract; a copy is a paragraph, per plan/b3-facade-review.md §5). The MCP's only use is
// reaction tie-breaking. Written with plain comparisons (not a nested ternary) so it reads clearly.
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
