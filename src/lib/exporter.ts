import type { ZoteroClient } from "./zoteroClient";
import type { ZoteroCollection, ZoteroItem } from "./zoteroTypes";
import { extractItemKeyFromUri } from "./zoteroTypes";
import { cardFooter } from "./display";
import { annotatedPaperKeys, resolveStatus, type ReadingRules } from "./reading";
import { casefold, parseYear, unique } from "./util";

/**
 * Assembly of the "atlas model": which papers to draw, which container groups
 * they belong to, and which relation pairs become edges. Pure given the data
 * the injected Zotero client returns (tests can fake the client).
 */

export type ExportMode = "collections" | "items" | "authors";

export interface ExportRequest {
	mode: ExportMode;
	/** keys of collections to use as roots (mode "collections") */
	collectionKeys: string[];
	/** pull in papers of sub-collections, as nested container groups */
	includeSubcollections: boolean;
	/** keys of items picked directly (mode "items") */
	itemKeys: string[];
	/** normalised author labels ("doe, jane") picked (mode "authors") */
	authors: string[];
}

export interface ExportOptions {
	readingRules: ReadingRules;
	/** sort papers inside each container by publication year, then title */
	sortByYear: boolean;
	/** fetch metadata for cited works outside the selection and draw them */
	resolveExternals: boolean;
	maxExternals: number;
	/** apply reading-status colours to external (out-of-selection) papers */
	colorExternals: boolean;
	/** optional vault-side lookup: vault path of the note that represents an item */
	notePathOf?: (item: ZoteroItem) => string | null;
}

export type PaperStatus = "annotated" | "read" | "unread" | null; // null = uncolored

export interface PaperRecord {
	key: string;
	title: string;
	byline: string; // "Doe et al. · 2021"
	year: number | null;
	status: PaperStatus;
	notePath: string | null;
	external: boolean;
}

export interface ContainerSpec {
	key: string;
	label: string;
	/** direct paper members, already ordered for display */
	paperKeys: string[];
	children: ContainerSpec[];
}

export interface AtlasModel {
	containers: ContainerSpec[];
	papers: Map<string, PaperRecord>;
	/** relation pairs between drawn papers, [keyA, keyB] sorted ascending */
	edges: Array<[string, string]>;
	stats: {
		inScope: number;
		drawnPapers: number;
		externalDrawn: number;
		externalOmitted: number;
		edges: number;
	};
	warnings: string[];
}

/** Normalised author id: folded, whitespace-collapsed, lowercase. */
function normAuthor(raw: string): string {
	return casefold(raw).replace(/\s+/g, " ").trim();
}

function isPaper(item: ZoteroItem): boolean {
	return !["attachment", "note", "annotation"].includes(item.data.itemType);
}

function yearOf(item: ZoteroItem): number | null {
	return parseYear(item.data.date);
}

function normCreator(c: { lastName?: string; firstName?: string; name?: string }): string | null {
	if (!c.lastName && !c.name) return null;
	const label = creatorLabel(c);
	if (!label) return null;
	return casefold(label).replace(/\s+/g, " ").trim() || null;
}

/** Human label with original spelling, e.g. "Lovelace, Ada" or an org name. */
function creatorLabel(c: { lastName?: string; firstName?: string; name?: string }): string | null {
	if (c.name) return c.name;
	if (!c.lastName) return null;
	return c.firstName ? `${c.lastName}, ${c.firstName}` : c.lastName;
}

/** All library-item keys a paper references through any relation predicate. */
export function relatedKeys(item: ZoteroItem): string[] {
	const out: string[] = [];
	for (const list of Object.values(item.data.relations ?? {})) {
		for (const uri of list) {
			const key = extractItemKeyFromUri(uri);
			if (key) out.push(key);
		}
	}
	return unique(out);
}

export async function buildAtlasModel(
	client: ZoteroClient,
	request: ExportRequest,
	options: ExportOptions
): Promise<AtlasModel> {
	const warnings: string[] = [];

	// ---- 1. load the library slices we need ---------------------------------
	const [collections, topItems, attachments, annotations] = await Promise.all([
		client.collections(),
		client.topItems(),
		options.readingRules.autoAnnotated ? client.attachments() : Promise.resolve([] as ZoteroItem[]),
		options.readingRules.autoAnnotated ? client.annotations() : Promise.resolve([] as ZoteroItem[]),
	]);

	const papersById = new Map<string, ZoteroItem>();
	for (const it of topItems) if (isPaper(it)) papersById.set(it.key, it);

	const annotatedKeys = options.readingRules.autoAnnotated
		? annotatedPaperKeys(attachments, annotations)
		: new Set<string>();
	const statusOf = (item: ZoteroItem): PaperStatus =>
		resolveStatus(item, annotatedKeys, options.readingRules);

	const collectionByKey = new Map(collections.map((c) => [c.key, c]));
	const childrenOf = new Map<string, string[]>();
	for (const c of collections) {
		const p = c.data.parentCollection;
		if (typeof p === "string" && p) {
			const list = childrenOf.get(p) ?? [];
			list.push(c.key);
			childrenOf.set(p, list);
		}
	}

	// ---- 2. in-scope keys ----------------------------------------------------
	let scopeKeys: string[] = [];
	let scopeFromCollections = false;

	if (request.mode === "items") {
		scopeKeys = request.itemKeys.filter((k) => {
			if (papersById.has(k)) return true;
			warnings.push(`Item ${k} was not found and was skipped.`);
			return false;
		});
	} else if (request.mode === "authors") {
		const wanted = new Set(request.authors.map(normAuthor));
		scopeKeys = [...papersById.values()]
			.filter((item) =>
				(item.data.creators ?? []).some((c) => {
					const n = normCreator(c);
					return n !== null && wanted.has(n);
				})
			)
			.map((i) => i.key);
		if (scopeKeys.length === 0) warnings.push("No papers were found for the selected author(s).");
	} else {
		// collections
		const selected = new Set<string>();
		const orderedRootKeys: string[] = [];
		for (const key of request.collectionKeys) {
			if (!collectionByKey.has(key)) {
				warnings.push(`Collection "${key}" no longer exists and was skipped.`);
				continue;
			}
			if (selected.has(key)) continue;
			selected.add(key);
			orderedRootKeys.push(key);
			if (request.includeSubcollections) {
				const stack = [...(childrenOf.get(key) ?? [])];
				while (stack.length) {
					const cur = stack.pop()!;
					if (selected.has(cur)) continue;
					selected.add(cur);
					stack.push(...(childrenOf.get(cur) ?? []));
				}
			}
		}
		scopeFromCollections = true;
		scopeKeys = [...papersById.values()]
			.filter((item) => (item.data.collections ?? []).some((c) => selected.has(c)))
			.map((i) => i.key);
		if (scopeKeys.length === 0 && request.collectionKeys.length > 0)
			warnings.push("The chosen collections contain no papers.");
	}

	// ---- 3. container structure ----------------------------------------------
	const cmpPapers = (a: ZoteroItem, b: ZoteroItem): number => {
		if (options.sortByYear) {
			const ya = yearOf(a);
			const yb = yearOf(b);
			if (ya !== null && yb !== null && ya !== yb) return ya - yb;
			if (ya === null && yb !== null) return 1;
			if (yb === null && ya !== null) return -1;
		}
		return (a.data.title ?? "").localeCompare(b.data.title ?? "");
	};
	const keysSorted = (items: ZoteroItem[]): string[] => [...items].sort(cmpPapers).map((i) => i.key);

	const containers: ContainerSpec[] = [];

	if (request.mode === "collections") {
		const buildTree = (c: ZoteroCollection): ContainerSpec => {
			const papers = topItems.filter(
				(it) => isPaper(it) && (it.data.collections ?? []).includes(c.key)
			);
			const spec: ContainerSpec = {
				key: c.key,
				label: c.data.name || "(unnamed collection)",
				paperKeys: keysSorted(papers),
				children: [],
			};
			if (request.includeSubcollections) {
				spec.children = (childrenOf.get(c.key) ?? [])
					.map((k) => collectionByKey.get(k))
					.filter((x): x is ZoteroCollection => Boolean(x))
					.map(buildTree);
			}
			return spec;
		};
		for (const key of request.collectionKeys) {
			const c = collectionByKey.get(key);
			if (!c) continue;
			if (request.includeSubcollections) containers.push(buildTree(c));
			else containers.push({ ...buildTree(c), children: [] });
		}
	} else if (request.mode === "authors") {
		const scope = new Set(scopeKeys);
		const labels = new Map<string, string>();
		for (const item of papersById.values()) {
			for (const c of item.data.creators ?? []) {
				const n = normCreator(c);
				const raw = creatorLabel(c);
				if (n && raw && !labels.has(n)) labels.set(n, raw);
			}
		}
		for (const raw of request.authors) {
			const norm = normAuthor(raw);
			containers.push({
				key: "author:" + norm,
				label: labels.get(norm) ?? prettyAuthor(raw),
				paperKeys: [],
				children: [],
			});
		}
		// first matching author container wins
		for (const item of [...papersById.values()]) {
			if (!scope.has(item.key)) continue;
			const normals = (item.data.creators ?? []).map(normCreator).filter(Boolean) as string[];
			const owner = containers.find((c) => normals.includes(c.key.slice("author:".length)));
			if (owner) owner.paperKeys.push(item.key);
		}
		for (const c of containers) {
			const byKey = c.paperKeys.map((k) => papersById.get(k)!).filter(Boolean);
			c.paperKeys = keysSorted(byKey);
		}
	} else {
		containers.push({ key: "picked", label: "Picked papers", paperKeys: keysSorted(scopeKeys.map((k) => papersById.get(k)!).filter(Boolean)), children: [] });
		if (containers[0].paperKeys.length === 0)
			warnings.push("No items selected — nothing to draw.");
	}

	// ---- 4. assign each paper to its first container (DFS order) -------------
	const assigned = new Map<string, string>(); // paperKey -> container key
	const orderedContainerKeys: string[] = [];
	{
		const walk = (c: ContainerSpec) => {
			orderedContainerKeys.push(c.key);
			for (const k of c.paperKeys) if (!assigned.has(k)) assigned.set(k, c.key);
			for (const child of c.children) walk(child);
		};
		for (const c of containers) walk(c);
	}
	// papers of nested subcollections that are not direct members of an ancestor
	// have already been captured by the assignment loop above.
	if (scopeFromCollections) {
		// make sure no in-scope paper is silently dropped when collections overlap
		for (const k of scopeKeys) if (!assigned.has(k)) assigned.set(k, containers[0]?.key ?? "");
	}
	const drawnKeys = [...assigned.keys()];
	const drawnSet = new Set(drawnKeys);
	void scopeFromCollections;

	// ---- 5. external references (optional) -----------------------------------
	const externalKeys: string[] = [];
	if (options.resolveExternals && options.maxExternals > 0 && drawnKeys.length) {
		const referenced = new Set<string>();
		for (const k of drawnKeys) {
			const item = papersById.get(k);
			if (!item) continue;
			for (const t of relatedKeys(item)) if (!drawnSet.has(t)) referenced.add(t);
		}
		let omitted = 0;
		let candidates = [...referenced];
		if (candidates.length > options.maxExternals) {
			omitted = candidates.length - options.maxExternals;
			candidates = candidates.slice(0, options.maxExternals);
		}
		if (candidates.length) {
			const fetched = await client.itemsByKey(candidates);
			const fetchedByKey = new Map(fetched.map((i) => [i.key, i]));
			for (const k of candidates) {
				const item = fetchedByKey.get(k);
				if (!item || !isPaper(item)) continue;
				externalKeys.push(k);
				papersById.set(k, item);
				drawnSet.add(k);
			}
		}
		if (omitted > 0) warnings.push(`More than ${options.maxExternals} out-of-selection cited works were referenced; ${omitted} were omitted.`);
	}

	// ---- 6. final edges across the complete drawn set -------------------------
	const allKeys = [...drawnKeys, ...externalKeys];
	const allSet = new Set(allKeys);
	const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
	const edges = new Map<string, [string, string]>();
	for (const k of allKeys) {
		const item = papersById.get(k);
		if (!item) continue;
		for (const t of relatedKeys(item)) {
			if (!allSet.has(t) || t === k) continue;
			edges.set(pairKey(k, t), k < t ? [k, t] : [t, k]);
		}
	}

	// ---- 7. external container + final paper records --------------------------
	if (externalKeys.length) {
		containers.push({
			key: "__external__",
			label: `Cited works outside selection (${externalKeys.length})`,
			paperKeys: externalKeys,
			children: [],
		});
		orderedContainerKeys.push("__external__");
		for (const k of externalKeys) assigned.set(k, "__external__");
	}

	const orderKeys: string[] = [];
	for (const c of containers) {
		for (const k of c.paperKeys) orderKeys.push(k);
		for (const child of c.children) {
			collectContainerKeys(child, orderKeys);
		}
	}

	const papers = new Map<string, PaperRecord>();
	for (const k of orderKeys) {
		const item = papersById.get(k);
		if (!item) continue;
		const external = externalKeys.includes(k);
		papers.set(k, {
			key: k,
			title: item.data.title?.trim() || "(untitled)",
			byline: cardFooter(item),
			year: yearOf(item),
			status: external && !options.colorExternals ? null : statusOf(item),
			notePath: options.notePathOf ? options.notePathOf(item) : null,
			external,
		});
	}
	// papers that were drawn but ended up unassigned (should not happen)
	for (const k of drawnKeys) if (!papers.has(k)) papers.delete(k);

	return {
		containers,
		papers,
		edges: [...edges.values()].sort((a, b) => a[0].localeCompare(b[0])),
		stats: {
			inScope: scopeKeys.length,
			drawnPapers: papers.size,
			externalDrawn: externalKeys.length,
			externalOmitted: 0,
			edges: edges.size,
		},
		warnings,
	};
}

function collectContainerKeys(c: ContainerSpec, out: string[]): void {
	for (const k of c.paperKeys) out.push(k);
	for (const child of c.children) collectContainerKeys(child, out);
}

function prettyAuthor(norm: string): string {
	return norm
		.split(" ")
		.map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
		.join(" ");
}
