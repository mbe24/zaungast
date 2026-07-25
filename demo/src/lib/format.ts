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

// Display-time name shortening (until a real private mode): first name in full, each following
// name-part to its initial. "Firstname Lastname" → "Firstname L."; "Firstname de Surname" → "Firstname d. S.".
export const abbrev = (raw: string): string => {
	const name = raw.replace(/\s*\([^)]*\)\s*$/, '').trim(); // drop a trailing "(Org)" federated suffix
	if (name.includes(',')) {
		// "Surname, Given …" — Teams' format for external/federated contacts → "Surname, G."
		const [last, ...rest] = name.split(',');
		const given = rest.join(',').trim().split(/\s+/).filter(Boolean);
		return given.length ? `${last.trim()}, ${given[0][0]}.` : last.trim();
	}
	const parts = name.split(/\s+/).filter(Boolean);
	if (parts.length <= 1) return name;
	const [first, ...more] = parts;
	return `${first} ${more.map((p) => p[0] + '.').join(' ')}`;
};
