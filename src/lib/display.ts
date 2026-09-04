import type { ZoteroItem } from "./zoteroTypes";
import { NON_PAPER_TYPES } from "./zoteroTypes";
import { casefold, parseYear, truncate } from "./util";

/**
 * Human-readable rendering helpers for Zotero items — used both by the picker
 * modals and by the canvas card texts.
 */

/** "Doe" | "Doe & Smith" | "Doe et al." (first three creators, then et al.) */
export function shortCreators(item: ZoteroItem, max = 3): string {
	const creators = (item.data.creators ?? []).filter(
		(c) => (c.lastName && c.firstName !== undefined) || c.name
	);
	if (creators.length === 0) return "";
	const names = creators.slice(0, max).map((c) => c.lastName || c.name || "");
	if (creators.length === 1) return names[0];
	if (creators.length === 2) return names[0] + " & " + names[1];
	return names[0] + " et al.";
}

export function creatorsFull(item: ZoteroItem): string[] {
	return (item.data.creators ?? [])
		.filter((c) => c.lastName || c.name)
		.map((c) => {
			if (c.name) return c.name;
			const last = c.lastName ?? "";
			const first = c.firstName ?? "";
			return first && last ? `${last}, ${first}` : last || first;
		});
}

/** One-line summary used in lists: "Doe et al. — 2021 — Title". */
export function itemListLine(item: ZoteroItem, maxTitle = 120): string {
	const title = truncate(item.data.title?.trim() || "[Untitled]", maxTitle);
	const by = shortCreators(item);
	const year = parseYear(item.data.date);
	const parts: string[] = [];
	if (by) parts.push(by);
	if (year !== null) parts.push(String(year));
	const head = parts.join(" · ");
	return head ? `${head} — ${title}` : title;
}

/**
 * Authors that show on the card + a normalised key for the author index.
 * Includes every role (authors, editors, …) but counts each item once.
 */
export interface AuthorEntry {
	label: string; // "Doe, Jane"
	normalized: string; // lower-cased, folded
	items: number;
	roles: Set<string>;
}

export function authorIndex(items: ZoteroItem[]): AuthorEntry[] {
	const byNorm = new Map<string, AuthorEntry>();
	for (const item of items) {
		if (NON_PAPER_TYPES.has(item.data.itemType)) continue;
		for (const c of item.data.creators ?? []) {
			if (!c.lastName && !c.name) continue;
			const label = c.name
				? c.name
				: `${c.lastName}, ${c.firstName ?? ""}`.replace(/,\s*$/, "");
			const norm = casefold(label).replace(/\s+/g, " ").trim();
			if (!norm) continue;
			let entry = byNorm.get(norm);
			if (!entry) {
				entry = { label, normalized: norm, items: 0, roles: new Set() };
				byNorm.set(norm, entry);
			}
			entry.items += 1;
			if (c.creatorType) entry.roles.add(c.creatorType);
		}
	}
	const entries = [...byNorm.values()];
	entries.sort((a, b) => b.items - a.items || a.label.localeCompare(b.label));
	return entries;
}

/**
 * Better BibTeX stores "Citation Key: name2020" in the Extra field; Zotero 9+
 * has a native citation-key column that is exposed through `extra` by BBT only.
 */
export function citationKey(item: ZoteroItem): string | null {
	const extra = item.data.extra;
	if (!extra) return null;
	const m = extra.match(/^Citation\s*Key:\s*([^\n\r]+)$/m);
	return m ? m[1].trim() : null;
}

/** Deterministic byline + year for a canvas card footer. */
export function cardFooter(item: ZoteroItem): string {
	const by = shortCreators(item, 2);
	const year = parseYear(item.data.date);
	const typeLabel = prettyItemType(item.data.itemType);
	const bits: string[] = [];
	if (by) bits.push(by);
	if (year !== null) bits.push(String(year));
	const base = bits.join(" · ");
	if (typeLabel && typeLabel !== "Paper") return base ? `${base} · ${typeLabel}` : typeLabel;
	return base;
}

const TYPE_LABELS: Record<string, string> = {
	journalArticle: "Journal article",
	book: "Book",
	bookSection: "Book section",
	conferencePaper: "Conference paper",
	preprint: "Preprint",
	report: "Report",
	thesis: "Thesis",
	blogPost: "Blog post",
	webpage: "Web page",
	document: "Document",
	dataset: "Dataset",
	encyclopediaArticle: "Encyclopedia article",
	dictionaryEntry: "Dictionary entry",
	newspaperArticle: "Newspaper article",
	magazineArticle: "Magazine article",
	manuscript: "Manuscript",
	letter: "Letter",
	interview: "Interview",
	film: "Film",
	presentation: "Presentation",
	videoRecording: "Video",
	audioRecording: "Audio",
	podcast: "Podcast",
	tvBroadcast: "TV broadcast",
	radioBroadcast: "Radio broadcast",
	computerProgram: "Software",
	patent: "Patent",
	statute: "Statute",
	case: "Case",
	bill: "Bill",
	hearing: "Hearing",
	email: "Email",
	instantMessage: "Instant message",
	note: "Note",
	attachment: "Attachment",
	annotation: "Annotation",
};

export function prettyItemType(t: string): string {
	return TYPE_LABELS[t] ?? (t ? t.charAt(0).toUpperCase() + t.slice(1) : "Item");
}
