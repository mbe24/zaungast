// Shared display formatters. Pure and rune-free on purpose: reused across every page (Wrapped, race,
// rhythms) and unit-tested directly. Extracted from per-page copies that had begun to drift.

/** Shared number formatter (locale grouping). */
export const nf = new Intl.NumberFormat();

/** Epoch-ms → locale date, or `empty` when there is no timestamp (ms ≤ 0). */
export const fmtDate = (ms: number, empty = '—'): string =>
	ms > 0 ? new Date(ms).toLocaleDateString() : empty;

/** Epoch-ms → locale date + time, or `empty` when there is no timestamp. */
export const fmtDateTime = (ms: number, empty = '—'): string =>
	ms > 0 ? new Date(ms).toLocaleString() : empty;

// Abbreviate a surname to initials, keeping each part of a compound surname: "Lovelace" → "L.";
// "de Lovelace" → "d. L." (case preserved). Empty → "". The worker composes a display label as
// `given + abbrev(surname)` from the structured Person fields (see wrapped.ts) — we never parse names here.
export const abbrev = (surname: string): string =>
	surname
		.split(/\s+/)
		.filter(Boolean)
		.map((p) => p[0] + '.')
		.join(' ');
