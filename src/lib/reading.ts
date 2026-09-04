import type { ZoteroItem } from "./zoteroTypes";

/**
 * Reading status resolution.
 *
 * Zotero core has no canonical "read" flag, so Citation Atlas derives a
 * three-way status from signals that actually exist in Zotero:
 *
 *   annotated – the item has PDF/EPUB annotation child items in the library
 *               (auto-detected), or carries a configured tag.
 *   read      – item carries a configured "read" tag (e.g. "Read" or the
 *               "Read 2026-01-02" style used by zotero-actions-tags).
 *   unread    – item carries a configured "unread" tag, or (default) no
 *               positive signal was found.
 *
 * The tag names and the fallback are user-configurable.
 */

export type ReadingStatus = "annotated" | "read" | "unread";

export const STATUS_ORDER: ReadingStatus[] = ["annotated", "read", "unread"];

export interface ReadingRules {
	/** detect annotated from real annotation child items */
	autoAnnotated: boolean;
	/** tags that mark an item as annotated */
	annotatedTags: string[];
	/** tags that mark an item as read */
	readTags: string[];
	/** tags that mark an item as unread */
	unreadTags: string[];
	/** match read tags by prefix ("Read" matches "Read 2026-01-02") */
	readTagPrefix: boolean;
	/** status used when nothing matched */
	fallback: ReadingStatus;
}

export const DEFAULT_READING_RULES: ReadingRules = {
	autoAnnotated: true,
	annotatedTags: ["Annotated"],
	readTags: ["Read"],
	unreadTags: ["Unread"],
	readTagPrefix: true,
	fallback: "unread",
};

function tagSet(item: ZoteroItem): Set<string> {
	const tags = new Set<string>();
	for (const t of item.data.tags ?? []) tags.add(t.tag.trim().toLowerCase());
	return tags;
}

function match(tags: Set<string>, names: string[]): boolean {
	for (const n of names) if (tags.has(n.trim().toLowerCase())) return true;
	return false;
}

function matchPrefix(tags: Set<string>, names: string[]): boolean {
	for (const n of names) {
		const needle = n.trim().toLowerCase();
		if (!needle) continue;
		for (const t of tags) if (t.startsWith(needle)) return true;
	}
	return false;
}

/**
 * Keys of paper items that own at least one annotation child item.
 * Annotations hang off attachments; the attachment's parent is the paper
 * (or another top-level item).
 */
export function annotatedPaperKeys(attachments: ZoteroItem[], annotations: ZoteroItem[]): Set<string> {
	const attachmentParent = new Map<string, string>();
	for (const att of attachments) {
		const p = att.data.parentItem;
		if (p) attachmentParent.set(att.key, p);
	}
	const annotated = new Set<string>();
	for (const ann of annotations) {
		if (ann.data.itemType !== "annotation") continue;
		const parentKey = ann.data.parentItem;
		if (!parentKey) continue;
		const grandParent = attachmentParent.get(parentKey);
		if (grandParent) annotated.add(grandParent);
		else annotated.add(parentKey); // annotation attached straight to a top-level item
	}
	return annotated;
}

/** Resolve reading status for one item given precomputed annotation owners. */
export function resolveStatus(
	item: ZoteroItem,
	annotatedKeys: Set<string>,
	rules: ReadingRules
): ReadingStatus {
	const tags = tagSet(item);
	if (rules.autoAnnotated && annotatedKeys.has(item.key)) return "annotated";
	if (rules.annotatedTags.length && match(tags, rules.annotatedTags)) return "annotated";
	if (rules.unreadTags.length && match(tags, rules.unreadTags)) return "unread";
	const readHit = rules.readTags.length && (match(tags, rules.readTags) || (rules.readTagPrefix && matchPrefix(tags, rules.readTags)));
	if (readHit) return "read";
	return rules.fallback;
}

/** Canvas color presets (JSON Canvas spec) with display names. */
export const PALETTE: Record<string, string> = {
	"1": "red",
	"2": "orange",
	"3": "yellow",
	"4": "green",
	"5": "cyan",
	"6": "purple",
};

export function paletteName(color: string | undefined): string {
	if (!color) return "plain";
	return PALETTE[color] ?? color;
}

export interface StatusColorOptions {
	annotated: string; // "1".."6" or ""
	read: string;
	unread: string;
}

export const DEFAULT_STATUS_COLORS: StatusColorOptions = {
	annotated: "1", // red
	read: "4", // green
	unread: "3", // yellow
};

/** Mapping used by the canvas writer ("" means: leave the node uncolored). */
export type ColorForStatus = Record<ReadingStatus, string>;
