/**
 * Offline fixture test for the pure core (no Obsidian APIs involved).
 *
 * Builds a small fake Zotero library (two collections + a nested one, items
 * with read/unread/annotated signals and cross-references), runs the full
 * export pipeline, and sanity-checks the resulting JSON Canvas.
 *
 * Run with: npx tsx test/fixture.ts
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { ZoteroCollection, ZoteroItem } from "../src/lib/zoteroTypes";
import { buildAtlasModel, type AtlasModel } from "../src/lib/exporter";
import { buildCanvas } from "../src/lib/canvas";
import { DEFAULT_READING_RULES, type ReadingRules } from "../src/lib/reading";
import { jsonGet, ZoteroClient, ZoteroError, type RawHttpGet } from "../src/lib/zoteroClient";

const KEY = (i: number) => "ABC" + String(10000 + i * 37).slice(-5).toUpperCase();
const keys = Array.from({ length: 14 }, (_, i) => KEY(i));

function paper(
	i: number,
	partial: Partial<ZoteroItem["data"]> & { title: string; date: string; creators: ZoteroItem["data"]["creators"] },
	extra: Partial<ZoteroItem> = {}
): ZoteroItem {
	return {
		key: keys[i],
		version: 1,
		data: {
			key: keys[i],
			itemType: "journalArticle",
			...partial,
		},
		...extra,
	};
}

const authorsA = [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" }];
const authorsB = [
	{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
	{ creatorType: "author", firstName: "Charles", lastName: "Babbage" },
];
const authorsC = [{ creatorType: "author", name: "Deep Learning Institute" }];

const topItems: ZoteroItem[] = [
	// 0  Attention paper (read)
	paper(0, {
		title: "Attention Is All You Need",
		date: "2017-06-01",
		creators: [{ creatorType: "author", firstName: "Ashish", lastName: "Vaswani" }, ...authorsA],
		tags: [{ tag: "Read" }],
		collections: ["COLL1"],
		relations: { "dc:relation": [`zotero://select/library/items/${keys[1]}`, `zotero://select/library/items/${keys[2]}`] },
		extra: "Citation Key: vaswani2017attention",
	}),
	// 1  older Transformer paper (unread via tag)
	paper(1, {
		title: "Efficient Estimation of Word Representations in Vector Space",
		date: "2013-09-01",
		creators: [...authorsB],
		tags: [{ tag: "Unread" }],
		collections: ["COLL1"],
		relations: { "dc:relation": [`zotero://select/library/items/${keys[2]}`] },
	}),
	// 2  even older (annotated by child annotations on attachment)
	paper(2, {
		title: "A Neural Probabilistic Language Model",
		date: "2003-02-01",
		creators: [...authorsC],
		tags: [],
		collections: ["COLL1"],
		relations: {},
	}),
	// 3  unrelated item in collection 1, plain note in child collection
	paper(3, {
		title: "Deep Residual Learning for Image Recognition",
		date: "2015-12-10",
		creators: [...authorsA],
		tags: [],
		collections: ["COLL2"],
		relations: { "dc:relation": [`zotero://select/library/items/${keys[0]}`] },
	}),
	// 4  item in nested child collection
	paper(4, {
		title: "Improving Language Understanding by Generative Pre-Training",
		date: "2018-06-11",
		creators: [{ creatorType: "author", firstName: "Alec", lastName: "Radford" }, ...authorsB],
		tags: [{ tag: "Read 2026-01-04" }],
		collections: ["COLL3"],
		relations: { "dc:relation": [`zotero://select/library/items/${keys[0]}`] },
	}),
	// 5  loose paper (no collection) cited by 0? not related; by author A for author export
	paper(5, {
		title: "The Analytical Engine",
		date: "1837",
		creators: [...authorsA],
		tags: [],
		collections: [],
		relations: { "dc:relation": [`zotero://select/library/items/${keys[1]}`] },
	}),
	// 6  attachment under paper 2 (PDF)
	{
		key: keys[6],
		version: 1,
		data: {
			key: keys[6],
			itemType: "attachment",
			title: "nplm.pdf",
			parentItem: keys[2],
			tags: [],
			relations: {},
		},
	},
	// 7  annotation under attachment 6 → paper 2 annotated
	{
		key: keys[7],
		version: 1,
		data: {
			key: keys[7],
			itemType: "annotation",
			title: "",
			parentItem: keys[6],
			tags: [],
			relations: {},
			annotationText: "key idea",
		},
	},
];

const collections: ZoteroCollection[] = [
	{
		key: "COLL1",
		version: 1,
		data: { key: "COLL1", name: "Transformers", parentCollection: false },
	},
	{
		key: "COLL2",
		version: 1,
		data: { key: "COLL2", name: "Vision", parentCollection: false },
	},
	{
		key: "COLL3",
		version: 1,
		data: { key: "COLL3", name: "Language Models", parentCollection: "COLL1" },
	},
];

const attachments = [topItems[6] as ZoteroItem];
const annotations = [topItems[7] as ZoteroItem];

/** Minimal fake ZoteroClient: same public surface, backed by the fixture data. */
function fakeClient(): ZoteroClient {
	const api = {
		collections: async () => collections,
		topItems: async () => topItems.filter((i) => !["attachment", "annotation"].includes(i.data.itemType)),
		attachments: async () => attachments,
		annotations: async () => annotations,
		itemsByKey: async (keysReq: string[]) => {
			const wanted = new Set(keysReq);
			return topItems.filter((i) => wanted.has(i.key));
		},
	};
	return api as unknown as ZoteroClient;
}

function rules(over: Partial<ReadingRules> = {}): ReadingRules {
	return { ...DEFAULT_READING_RULES, ...over };
}

function runModel(request: Parameters<typeof buildAtlasModel>[1]): Promise<AtlasModel> {
	return buildAtlasModel(fakeClient(), request, {
		readingRules: rules(),
		sortByYear: true,
		resolveExternals: false,
		maxExternals: 60,
		colorExternals: false,
	});
}

function assert(cond: unknown, message: string): asserts cond {
	if (!cond) throw new Error("FIXTURE FAIL: " + message);
}

async function main(): Promise<void> {
	let failures = 0;
	const check = (cond: unknown, msg: string) => {
		if (!cond) {
			failures++;
			console.error("  ✗ " + msg);
		} else {
			console.log("  ✓ " + msg);
		}
	};

	console.log("== transport error classification ==");
	const okResponse: RawHttpGet = async () => ({ status: 200, text: '[{"key":"COLL1"}]', json: [{ key: "COLL1" }] });
	const emptyResponse: RawHttpGet = async () => ({ status: 200, text: "", json: null });
	const notAllowedResponse: RawHttpGet = async () => ({ status: 200, text: "Request not allowed", json: null });
	const forbiddenResponse: RawHttpGet = async () => ({ status: 403, text: "Forbidden", json: null });
	const notFoundResponse: RawHttpGet = async () => ({ status: 404, text: "Not Found", json: null });
	const htmlResponse: RawHttpGet = async () => ({ status: 500, text: "<html>internal server error</html>", json: null });
	const closedConnection: RawHttpGet = async () => {
		throw new Error("socket hang up");
	};
	{
		const data = await jsonGet("http://x", "/p", okResponse);
		check(Array.isArray(data) && (data as unknown[]).length === 1, "valid JSON body is returned");
	}
	const expectIssue = async (rawGet: RawHttpGet, issue: string, substr: string, label: string) => {
		try {
			await jsonGet("http://x", "/api/users/0/items", rawGet);
			check(false, `${label} (no error thrown)`);
		} catch (err) {
			const okErr = err instanceof ZoteroError && err.issue === issue && err.message.includes(substr);
			check(okErr, `${label} → ${err instanceof ZoteroError ? err.issue + " / " + err.message.slice(0, 70) : "?non-ZoteroError"}`);
		}
	};
	await expectIssue(emptyResponse, "http", "empty response", "HTTP 200 with empty body is a clear error");
	await expectIssue(notAllowedResponse, "forbidden", "Request not allowed", "‘Request not allowed’ page is classified as forbidden");
	await expectIssue(forbiddenResponse, "forbidden", "403", "HTTP 403 points at the server setting");
	await expectIssue(notFoundResponse, "unsupported", "404", "HTTP 404 is classified as unsupported");
	await expectIssue(htmlResponse, "http", "500", "HTTP 500 with HTML body keeps the snippet");
	await expectIssue(closedConnection, "unreachable", "Allow other applications", "closed connection hints at the httpServer setting");

	console.log("== reading status resolution ==");
	const item2 = topItems[2];
	const rulesDef = rules();
	// annotated auto-detect
	{
		const { annotatedPaperKeys, resolveStatus } = await import("../src/lib/reading");
		const owners = annotatedPaperKeys(attachments, annotations);
		check(resolveStatus(item2, owners, rulesDef) === "annotated", "paper with annotation child items → annotated");
		const item0 = topItems[0];
		check(resolveStatus(item0, owners, rulesDef) === "read", "tag Read → read");
		const item1 = topItems[1];
		check(resolveStatus(item1, owners, rulesDef) === "unread", "tag Unread → unread");
		const item4 = topItems[4];
		check(resolveStatus(item4, owners, rulesDef) === "read", "tag 'Read 2026-01-04' with prefix matching → read");
	}

	console.log("== collection export ==");
	const m1 = await runModel({ mode: "collections", collectionKeys: ["COLL1"], includeSubcollections: true, itemKeys: [], authors: [] });
	check(m1.stats.drawnPapers === 4, `COLL1 tree draws 4 papers (got ${m1.stats.drawnPapers})`);
	check(m1.papers.size === 4, "papers map has 4 records");
	check(m1.edges.length === 4, `edges among the 4 papers = 4 (got ${m1.edges.length})`);
	const ownerContainer = m1.containers.find((c) => c.key === "COLL1");
	check(ownerContainer !== undefined && ownerContainer.children.length === 1, "COLL3 appears as a nested child container");
	check(m1.papers.get(keys[2])?.status === "annotated", "annotated status travels into the model");
	check(m1.papers.get(keys[0])?.status === "read", "read status travels into the model");

	console.log("== collection export without subcollections ==");
	const m1b = await runModel({ mode: "collections", collectionKeys: ["COLL1"], includeSubcollections: false, itemKeys: [], authors: [] });
	check(m1b.stats.drawnPapers === 3, "COLL1 alone draws 3 papers (got " + m1b.stats.drawnPapers + ")");

	console.log("== items export ==");
	const m2 = await runModel({ mode: "items", collectionKeys: [], includeSubcollections: false, itemKeys: [keys[0], keys[1]], authors: [] });
	check(m2.stats.drawnPapers === 2, "picked 2 items drawn");
	check(m2.edges.length === 1, "relation 0↔1 resolved when both picked (got " + m2.edges.length + ")");

	console.log("== author export ==");
	const m3 = await runModel({ mode: "authors", collectionKeys: [], includeSubcollections: false, itemKeys: [], authors: ["lovelace, ada"] });
	check(m3.stats.drawnPapers >= 5, "author export includes every Ada Lovelace paper (got " + m3.stats.drawnPapers + ")");

	console.log("== external cited works ==");
	const m4 = await buildAtlasModel(fakeClient(), { mode: "items", collectionKeys: [], includeSubcollections: false, itemKeys: [keys[5]], authors: [] }, {
		readingRules: rules(),
		sortByYear: true,
		resolveExternals: true,
		maxExternals: 10,
		colorExternals: false,
	});
	check(m4.stats.drawnPapers === 2, "picked paper + cited work outside pick drawn (got " + m4.stats.drawnPapers + ")");
	check(m4.stats.externalDrawn === 1, "one external cited work drawn");
	check(m4.edges.length === 1, "edge connects pick to the external work");
	check(m4.papers.get(keys[1])?.external === true, "external record flagged as external");
	check(m4.papers.get(keys[1])?.status === null, "external record has no reading color when colorExternals off");
	const extContainer = m4.containers.find((c) => c.key === "__external__");
	check(extContainer !== undefined && extContainer.paperKeys.includes(keys[1]), "external works live in their own container");

	console.log("== canvas JSON generation ==");
	const res = buildCanvas(m1, {
		statusColors: { annotated: "1", read: "4", unread: "3" },
		collectionColor: "",
		edgeArrows: true,
		wrapInRoot: true,
		rootLabel: "Citation Atlas · fixture",
		showLegend: true,
		showZoteroKey: true,
		maxColumns: 4,
	});
	const { canvas } = res;
	check(Array.isArray(canvas.nodes) && Array.isArray(canvas.edges), "canvas has nodes + edges arrays");
	const ids = new Set<string>();
	let dup = false;
	for (const n of canvas.nodes) {
		if (ids.has(n.id)) dup = true;
		ids.add(n.id);
	}
	check(!dup, "no duplicate node ids");
	const paperNodes = canvas.nodes.filter((n) => n.type === "text" && n.id !== "n-legend");
	const groupNodes = canvas.nodes.filter((n) => n.type === "group");
	check(paperNodes.length === 4, `4 paper text nodes (got ${paperNodes.length})`);
	check(groupNodes.length === 3, `root + COLL1 + COLL3 = 3 groups (got ${groupNodes.length})`);
	check(canvas.edges.length === 4, "4 canvas edges");
	for (const e of canvas.edges) {
		check(ids.has(e.fromNode) && ids.has(e.toNode), `edge endpoints exist (${e.fromNode} → ${e.toNode})`);
	}
	const colored = paperNodes.filter((n) => typeof n.color === "string" && n.color);
	check(colored.length === 4, `all four paper nodes carry status colors (got ${colored.length})`);
	// geometry sanity: no text node sticks out of its group box vertically
	for (const g of groupNodes) {
		for (const p of paperNodes) {
			if (p.type !== "text") continue;
			if (p.x >= g.x && p.y >= g.y && p.x + p.width <= g.x + g.width + 1) {
				check(p.y + p.height <= g.y + g.height + 1, `paper ${p.text.slice(0, 20)} fits inside group ${g.label}`);
			}
		}
	}

	console.log(`== writing example ==`);
	mkdirSync(join(process.cwd(), "examples"), { recursive: true });
	const samplePath = join(process.cwd(), "examples", "citation-atlas-sample.canvas");
	writeFileSync(samplePath, JSON.stringify(canvas, null, 1), "utf8");
	console.log("  wrote " + samplePath);
	console.log(`  stats: ${res.paperNodes} papers · ${res.edges} edges · ${res.width}x${res.height}px · zoom ${canvas.view.zoom}`);

	if (failures) {
		console.error(`\n${failures} fixture assertion(s) FAILED`);
		process.exit(1);
	}
	console.log("\nAll fixture assertions passed ✓");
}

void main();
