// Use Case 1 — "Your Teams, Wrapped". Computes the year-in-review stats from a built store using ONLY
// the public libzaungast/web facade (no coupling to internal SQL): meta for totals, people.find for top
// people, and a per-conversation walk of messages.inConversation for the timestamp-based stats
// (activity/day, busiest day, hour histogram, night-owl, streak, first message). Runs in the worker,
// where the store is resident; returns a plain, structured-clone-safe object.
import type { TeamsStore, StoreMeta } from 'libzaungast/web';
import { abbrev } from './format';

export interface WrappedData {
	meta: StoreMeta;
	totals: { messages: number; people: number; conversations: number; reactions: number; mine: number };
	span: { firstTs: number; lastTs: number };
	// key = the person's MRI (stable, unique — used as the chart's category/colour key so same-named people
	// never merge); label = the display name (given + abbreviated surname, or the raw name when there are
	// no structured parts). Same shape for the race.
	topPeople: { key: string; label: string; messages: number }[];
	messagesPerDay: { date: number; count: number }[]; // date = epoch ms at local midnight
	busiestDay: { date: number; count: number } | null;
	hourHistogram: { hour: number; count: number }[]; // 24 buckets, local hour
	// Bivariate weekly-rhythm heatmap: per Monday-anchored week, a flat 7×70 fine grid (cell = day*70 +
	// fineSlot; day 0=Sun..6=Sat; fineSlot 0=night 23–02, 1..68=06:00..22:00 in 15-min steps, 69=early
	// 02–06). A = human chat messages; B = calendar occupancy (meetings + calls). The page rolling-means
	// over 4 weeks, convolves along the minute axis for soft transitions, and animates week by week.
	rhythmWeeks: number[]; // Sunday-midnight (week start) epoch ms per week
	rhythmA: number[][]; // [weekIndex] → 7×70 fine chat counts (day*70 + fineSlot)
	rhythmB: number[][]; // [weekIndex] → 7×70 fine calendar-occupancy counts
	nightOwlPct: number; // share of messages sent 22:00–05:59
	longestStreak: number; // longest run of consecutive days with ≥1 message
	firstMessage: { ts: number; senderLabel: string; content: string; where: string } | null;
	convMix: { kind: string; count: number }[];
	// Bar-chart-race data: a daily time axis + top 1:1 partners with their per-day message counts
	// (both sides) aligned to it. The UI applies a rolling window frame-by-frame.
	raceDays: number[]; // day-start epoch ms
	racePeople: { key: string; label: string; daily: number[] }[];
}

const DAY = 86_400_000;
const BIG = 1_000_000; // effectively "all rows"

// Bivariate weekly-rhythm heatmap. The worker always emits all 7 days (Sun=0..Sat=6); the page chooses
// how many to render. A (chat) counts human messages only unless A_INCLUDE_BOTS is flipped.
const HOUR_QUARTERS = 4; // 15-min sub-hour resolution — the cell's vertical (minutes-within-hour) axis
const QUARTER_MS = 15 * 60_000;
// Per-day fine slots: 0 = night 23–02 (aggregate), 1..68 = 06:00..22:00 in 15-min steps, 69 = early
// 02–06 (aggregate). The page renders each hour as its 4 quarter slots stacked top→bottom.
export const FINE_PER_DAY = 2 + 17 * HOUR_QUARTERS; // 70 — the rhythm page imports this (single source)
const RHYTHM_CELLS = 7 * FINE_PER_DAY;
const A_INCLUDE_BOTS = false; // flip to true to fold bot messages into Activity A
const fineOf = (dt: Date): number => {
	const h = dt.getHours();
	if (h >= 6 && h <= 22) return 1 + (h - 6) * HOUR_QUARTERS + Math.floor(dt.getMinutes() / 15);
	return h >= 23 || h < 2 ? 0 : FINE_PER_DAY - 1; // night / early buffers
};
const cellOf = (dt: Date): number => dt.getDay() * FINE_PER_DAY + fineOf(dt); // day 0=Sun..6=Sat
// Week anchored to SUNDAY (Sun→Sat), so the Sunday shown is the day BEFORE that week's Monday — the row
// reads left→right chronologically and each week is one coherent smoothed/animated unit.
const weekStartMs = (ts: number): number => {
	const dt = new Date(ts);
	return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - dt.getDay()).getTime();
};

export function computeWrapped(store: TeamsStore): WrappedData {
	const meta = store.meta;
	const convs = store.conversations.list({ n: BIG });

	// Corrected display names. The library now recovers given/surname for federated externals (whose
	// message senderName is the ugly "Surname, Given (Org)"), so compose the natural "Given Surname";
	// fall back to whatever name we have when the structured parts are missing (guests, bots).
	const displayNames = new Map<string, string>();
	// Structured name parts (given/surname) per MRI, so the UI can render "Given <surname-initials>" from
	// real fields instead of parsing a display string. Empty parts → the caller falls back to the name.
	const parts = new Map<string, { given: string; surname: string }>();
	for (const p of store.people.find({ n: BIG }).rows) {
		displayNames.set(p.mri, p.givenName && p.surname ? `${p.givenName} ${p.surname}` : p.name);
		parts.set(p.mri, { given: p.givenName, surname: p.surname });
	}
	const nameOf = (mri: string | null, fallback: string | null): string =>
		(mri ? displayNames.get(mri) : undefined) || fallback || mri || '';
	// Display label: given name in full + abbreviated surname, from the structured parts. Falls back to the
	// full display name when there's no surname (single-name guests, bots, profile-less senders).
	const labelOf = (mri: string | null, fallback: string | null): string => {
		const p = mri ? parts.get(mri) : undefined;
		return p?.surname ? `${p.given} ${abbrev(p.surname)}`.trim() : nameOf(mri, fallback);
	};

	const perDay = new Map<number, number>();
	// "Top people" = who you exchange the most DIRECT (1:1) messages with. NOT global authored count
	// (people.find's msgCount), which over-ranks anyone who broadcasts in channels/groups you're barely
	// in. Keyed by the 1:1 partner's MRI; value = total messages exchanged (both sides) in that 1:1.
	const talk = new Map<string, { name: string; count: number }>();
	// "People you talked to" = distinct non-self, non-bot people who posted in a conversation where you
	// ALSO posted (1:1s, group chats, channels). Requires your participation, so it's far below
	// meta.counts.people (everyone who merely appears in the cache).
	const talkedTo = new Set<string>();
	// Per-1:1-partner daily message counts (both sides), for the bar-chart race.
	const partnerDays = new Map<string, Map<number, number>>();
	const hours = new Array(24).fill(0) as number[];
	// Per Sunday-week fine rhythm grids (7×70). A = chat, B = calendar occupancy.
	const rhythmAMap = new Map<number, number[]>();
	const rhythmBMap = new Map<number, number[]>();
	const bumpRhythm = (map: Map<number, number[]>, ts: number): void => {
		const wk = weekStartMs(ts);
		let arr = map.get(wk);
		if (!arr) map.set(wk, (arr = new Array(RHYTHM_CELLS).fill(0)));
		arr[cellOf(new Date(ts))]++;
	};
	let reactions = 0;
	let mine = 0;
	let firstTs = Number.POSITIVE_INFINITY; // earliest message involving you — anchors span + the race axis
	let firstToMeTs = Number.POSITIVE_INFINITY; // earliest message addressed TO you — for the display card
	let lastTs = 0;
	let first: WrappedData['firstMessage'] = null;

	for (const c of convs) {
		const res = store.messages.inConversation(c.id, { limit: BIG });
		if (!res.ok) continue;
		const where = c.topic ?? c.participantNames ?? c.handle;
		const oneToOne = c.kind === '1:1';
		const isChannel = c.kind === 'channel';
		// A real human conversation (not a Teams service thread like 48:calllogs, kind 'other'), so call
		// logs / app notifications can't anchor "your first message".
		const isReal = oneToOne || isChannel || c.kind === 'group' || c.kind === 'meeting';
		// 1:1 volume (both sides) for top-people; co-participation for "people you talked to".
		let convTotal = 0;
		const convSenders = oneToOne ? new Map<string, { name: string; count: number }>() : null;
		let youPosted = false;
		const others = new Set<string>();
		const mineIds = new Set<string>(); // your message ids in this conv → detect replies addressed to you
		for (const m of res.rows) {
			const d = new Date(m.ts);
			const dayKey = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
			perDay.set(dayKey, (perDay.get(dayKey) ?? 0) + 1);
			hours[d.getHours()]++;
			// Activity A: human chat messages in real conversations (bots excluded unless A_INCLUDE_BOTS).
			if (isReal && (A_INCLUDE_BOTS || !m.senderIsBot)) bumpRhythm(rhythmAMap, m.ts);
			for (const g of m.reactions) reactions += g.users.length;
			if (m.isMine) {
				mine++;
				youPosted = true;
				mineIds.add(m.id);
			}
			if (m.ts > lastTs) lastTs = m.ts;
			// Span + race anchor: your earliest message in a real human conversation (sent, or received in
			// a non-channel), with content — so call logs / app threads / system events don't anchor it and
			// pre-join channel history is skipped.
			if (isReal && (m.isMine || !isChannel) && m.content.trim() && m.ts < firstTs) firstTs = m.ts;
			// "First cached message" (the card): the earliest message actually addressed TO you — a direct
			// message (1:1), an @mention of you anywhere, or a reply in a channel thread you started — NOT a
			// plain broadcast to a group/channel you merely belong to. res.rows is oldest→newest, so any
			// thread root you authored is already in mineIds by the time its reply appears.
			const toMe =
				!m.isMine &&
				m.content.trim().length > 0 &&
				(oneToOne || m.mentionsMe || (m.rootId !== m.id && mineIds.has(m.rootId)));
			if (toMe && m.ts < firstToMeTs) {
				firstToMeTs = m.ts;
				// A "burst": this message + the same sender's follow-ups sent within 60s of each other.
				// People who press Enter mid-thought split one message across several lines; keep them as
				// one entry so a short opener ("hi") doesn't leave the card looking empty.
				const lines: string[] = [];
				let prev = m.ts;
				let started = false;
				for (const n of res.rows) {
					if (n.id === m.id) started = true;
					if (!started) continue;
					if (n.senderMri !== m.senderMri || n.ts - prev > 60_000) break;
					if (n.content.trim()) lines.push(n.content);
					prev = n.ts;
				}
				first = {
					ts: m.ts,
					senderLabel: labelOf(m.senderMri, m.senderName),
					content: lines.join('\n'),
					where,
				};
			}
			const isOther = !m.senderIsBot && !!m.senderMri && m.senderMri !== meta.selfMri;
			if (isOther) others.add(m.senderMri as string);
			if (convSenders) {
				convTotal++; // total 1:1 volume (both sides)
				if (isOther) {
					const mri = m.senderMri as string;
					const cur = convSenders.get(mri);
					if (cur) cur.count++;
					else convSenders.set(mri, { name: nameOf(mri, m.senderName ?? store.people.nameFor(mri) ?? mri), count: 1 });
				}
			}
		}
		// "People you talked to": co-participants in any conversation where you also posted.
		if (youPosted) for (const mri of others) talkedTo.add(mri);
		// Top-people = the 1:1's total volume (both sides) attributed to the partner (dominant sender).
		if (convSenders && convSenders.size) {
			let partner: { mri: string; name: string; count: number } | null = null;
			for (const [mri, info] of convSenders)
				if (!partner || info.count > partner.count) partner = { mri, ...info };
			if (partner) {
				const existing = talk.get(partner.mri);
				if (existing) existing.count += convTotal;
				else talk.set(partner.mri, { name: partner.name, count: convTotal });
				// Bucket this 1:1's messages (both sides) by day under the partner, for the race.
				let dm = partnerDays.get(partner.mri);
				if (!dm) partnerDays.set(partner.mri, (dm = new Map()));
				for (const m of res.rows) {
					const d = Math.floor(m.ts / DAY) * DAY;
					dm.set(d, (dm.get(d) ?? 0) + 1);
				}
			}
		}
	}

	const messagesPerDay = [...perDay.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([date, count]) => ({ date, count }));

	const busiestDay = messagesPerDay.reduce<{ date: number; count: number } | null>(
		(best, d) => (!best || d.count > best.count ? d : best),
		null,
	);

	let longestStreak = 0;
	let run = 0;
	let prev = 0;
	for (const { date } of messagesPerDay) {
		run = prev && date - prev === DAY ? run + 1 : 1;
		if (run > longestStreak) longestStreak = run;
		prev = date;
	}

	const totalMsgs = hours.reduce((a, b) => a + b, 0);
	const nightOwl = hours.slice(0, 6).reduce((a, b) => a + b, 0) + hours.slice(22).reduce((a, b) => a + b, 0);
	const nightOwlPct = totalMsgs ? nightOwl / totalMsgs : 0;

	const topPeople = [...talk.entries()]
		.sort((a, b) => b[1].count - a[1].count)
		.slice(0, 10)
		.map(([mri, info]) => ({ key: mri, label: labelOf(mri, info.name), messages: info.count }));

	// Race: a daily axis over the cache span + the top partners' per-day counts aligned to it. We track
	// far more than we ever show (10) so short-burst people — active intensely for a while, then gone —
	// can still surface during their window even if their all-time total is modest. Cheap: it's just more
	// day-arrays, and rolling/ranking happen client-side.
	const RACE_PARTNERS = 100;
	const raceDays: number[] = [];
	if (lastTs > 0) {
		const from = Math.floor((Number.isFinite(firstTs) ? firstTs : lastTs) / DAY) * DAY;
		for (let d = from; d <= Math.floor(lastTs / DAY) * DAY; d += DAY) raceDays.push(d);
	}
	const racePeople = [...talk.entries()]
		.sort((a, b) => b[1].count - a[1].count)
		.slice(0, RACE_PARTNERS)
		.map(([mri, info]) => {
			const dm = partnerDays.get(mri) ?? new Map<number, number>();
			return { key: mri, label: labelOf(mri, info.name), daily: raceDays.map((d) => dm.get(d) ?? 0) };
		});

	// Activity B: calendar occupancy — meetings (not appointments / all-day / cancelled) + calls, each
	// filling every hour slot it spans (a 2h meeting hits both hours; a missed/0-length call → its start
	// hour). Guarded at 48 hours so a stray multi-day entry can't fill the whole grid.
	const occupy = (start: number, end: number): void => {
		if (!(start > 0)) return;
		const t = new Date(start);
		t.setMinutes(Math.floor(t.getMinutes() / 15) * 15, 0, 0); // snap to the quarter-hour
		let cur = t.getTime();
		let guard = 0;
		do {
			bumpRhythm(rhythmBMap, cur);
			cur += QUARTER_MS;
		} while (cur < end && ++guard < 200);
	};
	for (const e of store.events.list({ limit: BIG }))
		if (e.kind === 'meeting' && !e.isCancelled && !e.isAllDay)
			occupy(e.startTs, Math.max(e.endTs, e.startTs));
	for (const c of store.calls.list({ limit: BIG })) occupy(c.startTs, c.startTs + (c.durationMs || 0));

	// Weekly axis (Monday-anchored) over the message span; align both grids to it (empty weeks → zeros).
	const rhythmWeeks: number[] = [];
	if (lastTs > 0) {
		const to = weekStartMs(lastTs);
		for (let wk = weekStartMs(Number.isFinite(firstTs) ? firstTs : lastTs); wk <= to; wk = weekStartMs(wk + 8 * DAY))
			rhythmWeeks.push(wk);
	}
	const zeroCells = (): number[] => new Array(RHYTHM_CELLS).fill(0);
	const rhythmA = rhythmWeeks.map((wk) => rhythmAMap.get(wk) ?? zeroCells());
	const rhythmB = rhythmWeeks.map((wk) => rhythmBMap.get(wk) ?? zeroCells());

	const mix = new Map<string, number>();
	for (const c of convs) mix.set(c.kind, (mix.get(c.kind) ?? 0) + 1);
	const convMix = [...mix.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, count }));

	return {
		meta,
		totals: {
			messages: meta.counts.messages,
			people: talkedTo.size,
			conversations: meta.counts.conversations,
			reactions,
			mine,
		},
		span: { firstTs: Number.isFinite(firstTs) ? firstTs : 0, lastTs },
		topPeople,
		messagesPerDay,
		busiestDay,
		hourHistogram: hours.map((count, hour) => ({ hour, count })),
		rhythmWeeks,
		rhythmA,
		rhythmB,
		nightOwlPct,
		longestStreak,
		firstMessage: first,
		convMix,
		raceDays,
		racePeople,
	};
}
