/**
 * Small shared helpers, kept free of any Obsidian imports so the core can be
 * unit-tested under plain Node.
 */

/** Random 16-character lowercase hex id, the shape Obsidian itself uses. */
export function canvasId(): string {
	let out = "";
	const bytes = new Uint8Array(16);
	if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
		crypto.getRandomValues(bytes);
		for (let i = 0; i < bytes.length; i++) out += (bytes[i] & 0x0f).toString(16);
	} else {
		for (let i = 0; i < 16; i++) out += Math.floor(Math.random() * 16).toString(16);
	}
	return out;
}

/** Truncate a string at word boundary, appending an ellipsis when cut. */
export function truncate(s: string, max: number): string {
	const clean = s.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	const cut = clean.slice(0, max);
	const lastSpace = cut.lastIndexOf(" ");
	return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/** Remove characters that are illegal in Obsidian file names. */
export function sanitizeFileName(s: string, fallback = "citation-map"): string {
	const cleaned = s
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.\s]+$/g, "");
	return cleaned.length > 0 ? cleaned : fallback;
}

/** First 4-digit year inside a Zotero date string, or null. */
export function parseYear(rawDate: string | undefined): number | null {
	if (!rawDate) return null;
	const m = rawDate.match(/\b(1[89]\d{2}|20\d{2})\b/);
	return m ? parseInt(m[0], 10) : null;
}

/** Sort-comparable number for a date, defaults to 0 when unknown. */
export function yearKey(year: number | null): number {
	return year === null ? 0 : year;
}

export function pad2(n: number): string {
	return n < 10 ? "0" + n : String(n);
}

/** today as YYYY-MM-DD (local time) */
export function todayStamp(): string {
	const d = new Date();
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function nowStamp(): string {
	const d = new Date();
	return `${todayStamp()} ${pad2(d.getHours())}.${pad2(d.getMinutes())}`;
}

export function unique<T>(arr: T[]): T[] {
	return [...new Set(arr)];
}

export function casefold(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ");
}

/** True when `name` contains every whitespace-separated term of `query`. */
export function fuzzyMatch(name: string, query: string): boolean {
	const q = casefold(query)
		.split(" ")
		.filter(Boolean);
	if (q.length === 0) return true;
	const n = casefold(name);
	return q.every((term) => n.includes(term));
}
