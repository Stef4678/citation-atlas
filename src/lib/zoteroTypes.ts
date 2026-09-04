/**
 * TypeScript shapes for the JSON returned by the Zotero Web API v3 / Local API
 * (http://127.0.0.1:23119/api/). Only the fields Citation Atlas needs are typed;
 * unknown extra fields are preserved via index signatures.
 */

export interface ZoteroCreator {
	creatorType?: string;
	firstName?: string;
	lastName?: string;
	name?: string;
}

export interface ZoteroTag {
	tag: string;
	type?: number;
}

/** relations: map of predicate (e.g. "dc:relation") to URI strings */
export type ZoteroRelations = Record<string, string[]>;

export interface ZoteroItemData {
	key?: string;
	version?: number;
	itemType: string;
	title?: string;
	date?: string;
	dateAdded?: string;
	dateModified?: string;
	creators?: ZoteroCreator[];
	tags?: ZoteroTag[];
	collections?: string[];
	relations?: ZoteroRelations;
	extra?: string;
	abstractNote?: string;
	publicationTitle?: string;
	DOI?: string;
	url?: string;
	parentItem?: string;
	[key: string]: unknown;
}

export interface ZoteroItem {
	key: string;
	version: number;
	data: ZoteroItemData;
	meta?: {
		numChildren?: number;
		creatorSummary?: string;
		parsedDate?: string;
		[key: string]: unknown;
	};
}

export interface ZoteroCollectionData {
	key?: string;
	version?: number;
	name: string;
	parentCollection: string | false;
	relations?: ZoteroRelations;
	dateAdded?: string;
	dateModified?: string;
	[key: string]: unknown;
}

export interface ZoteroCollection {
	key: string;
	version: number;
	data: ZoteroCollectionData;
}

/** Zotero item types we never want to show as "papers". */
export const NON_PAPER_TYPES = new Set<string>(["attachment", "note", "annotation"]);

export function isPaperItem(item: ZoteroItem): boolean {
	return !NON_PAPER_TYPES.has(item.data.itemType);
}

/** Zotero relation URIs point at other library items through /items/<KEY>. */
export function extractItemKeyFromUri(uri: string): string | null {
	const m = uri.match(/\/items\/([A-Z0-9]{8})(?:$|[?#/])/i);
	if (m) return m[1].toUpperCase();
	const q = uri.match(/itemKey=([A-Z0-9]{8})/i);
	if (q) return q[1].toUpperCase();
	return null;
}
