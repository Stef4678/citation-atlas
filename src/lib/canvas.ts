import type { AtlasModel, ContainerSpec, PaperRecord } from "./exporter";
import { paletteName } from "./reading";
import { canvasId, truncate } from "./util";

/**
 * Builds a JSON Canvas 1.0 (.canvas) file from an AtlasModel.
 * Pure module — no Obsidian imports.
 *
 * Layout model:
 *   • collections/author containers become `group` nodes (spatial boxes);
 *     papers are placed as text cards in a grid inside their group, children
 *     of a container are nested boxes below its own papers.
 *   • group nodes are emitted first (they sit at the bottom of the z-order),
 *     then paper cards, then the legend card.
 *   • relation pairs become edges; when both endpoints have a known year and
 *     `edgeArrows` is on, the arrow points from the newer paper to the older
 *     (cited) one.
 */

export type StatusColorMap = Record<"annotated" | "read" | "unread", string>; // "" = none

export interface CanvasBuildOptions {
	statusColors: StatusColorMap;
	collectionColor: string; // "" = none
	edgeArrows: boolean;
	wrapInRoot: boolean;
	rootLabel: string | null;
	showLegend: boolean;
	showZoteroKey: boolean;
	maxColumns: number;
}

export type CanvasSide = "top" | "right" | "bottom" | "left";
export type CanvasEnd = "none" | "arrow";

export interface CanvasNodeBase {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
}

export interface CanvasTextNode extends CanvasNodeBase {
	type: "text";
	text: string;
}

export interface CanvasGroupNode extends CanvasNodeBase {
	type: "group";
	label: string;
}

export interface CanvasEdge {
	id: string;
	fromNode: string;
	fromSide: CanvasSide;
	toNode: string;
	toSide: CanvasSide;
	fromEnd?: CanvasEnd;
	toEnd?: CanvasEnd;
	label?: string;
	color?: string;
}

export interface CanvasFile {
	nodes: Array<CanvasTextNode | CanvasGroupNode>;
	edges: CanvasEdge[];
	view: { x: number; y: number; zoom: number };
}

export interface CanvasBuildResult {
	canvas: CanvasFile;
	paperNodes: number;
	groupNodes: number;
	edges: number;
	width: number;
	height: number;
}

const CARD_W = 320;
const PAD_X = 26; // inner horizontal padding of a group
const LABEL_BAND = 62; // room reserved at the top of a group for its label
const GRID_GAP_X = 26;
const GRID_GAP_Y = 30;
const GROUP_GAP = 46; // between top-level group boxes
const CHILD_GAP = 40; // between a group's papers and its nested child groups
const GROUP_BOTTOM_PAD = 24;

// ---- text shaping -----------------------------------------------------------

interface ShapedCard {
	key: string;
	text: string;
	height: number;
}

function wikiTarget(path: string): string {
	const p = path.replace(/\.md$/i, "");
	return p.replace(/[|#^\[\]]/g, "");
}

function cardText(paper: PaperRecord, showKey: boolean): string {
	const plainTitle = paper.title.replace(/[\r\n]+/g, " ").trim() || "(untitled)";
	const titlePlain = plainTitle.replace(/\|/g, "·");
	let first: string;
	if (paper.notePath) {
		const target = wikiTarget(paper.notePath);
		const alias = plainTitle.replace(/[|\[\]#^]/g, "").trim() || target;
		first = `**[[${target}|${alias}]]**`;
	} else {
		first = `**${titlePlain}**`;
	}
	const lines = [first, paper.byline || ""];
	if (showKey) lines.push(`zk: ${paper.key}`);
	return lines.join("\n").replace(/\n+$/, "");
}

function estimateTextHeight(text: string, maxCharsPerLine: number): number {
	let lines = 0;
	for (const raw of text.split("\n")) {
		const l = raw.length || 0;
		lines += Math.max(1, Math.ceil(l / maxCharsPerLine));
	}
	return Math.min(320, Math.max(84, 26 + lines * 24 + 6));
}

function shapeCard(paper: PaperRecord, showKey: boolean): ShapedCard {
	const text = cardText(paper, showKey);
	return { key: paper.key, text, height: estimateTextHeight(text, 38) };
}

function colorOrNone(color: string): string | undefined {
	return color ? color : undefined;
}

// ---- measurement ------------------------------------------------------------

interface RowMetrics {
	count: number;
	cols: number;
	rowHeights: number[]; // one entry per row
	gridHeight: number;
	gridWidth: number;
}

function rowMetrics(cards: ShapedCard[], maxCols: number): RowMetrics {
	const n = cards.length;
	if (n === 0) {
		return { count: 0, cols: 1, rowHeights: [], gridHeight: 0, gridWidth: 0 };
	}
	const cols = Math.max(1, Math.min(maxCols, Math.ceil(Math.sqrt(n))));
	const rows = Math.ceil(n / cols);
	const rowHeights: number[] = [];
	for (let r = 0; r < rows; r++) {
		let h = 0;
		for (let c = 0; c < cols; c++) {
			const idx = r * cols + c;
			if (idx < n) h = Math.max(h, cards[idx].height);
		}
		rowHeights.push(h);
	}
	const gridWidth = cols * CARD_W + (cols - 1) * GRID_GAP_X;
	const gridHeight = rowHeights.reduce((a, b) => a + b, 0) + (rows - 1) * GRID_GAP_Y;
	return { count: n, cols, rowHeights, gridHeight, gridWidth };
}

interface BoxMeasure {
	key: string;
	width: number;
	height: number;
	gridWidth: number;
	gridHeight: number;
	rowHeights: number[];
	cols: number;
	cards: ShapedCard[];
	children: BoxMeasure[];
}

function measureBox(container: ContainerSpec, papers: Map<string, PaperRecord>, maxCols: number, showKey: boolean): BoxMeasure {
	const cards = container.paperKeys
		.map((k) => papers.get(k))
		.filter((p): p is PaperRecord => Boolean(p))
		.map((p) => shapeCard(p, showKey));
	const rows = rowMetrics(cards, maxCols);
	const children = container.children.map((c) => measureBox(c, papers, maxCols, showKey));
	const childWidth = children.reduce((a, b) => Math.max(a, b.width), 0);
	const childHeight = children.reduce((a, b) => a + b.height, 0) + (children.length ? (children.length - 1) * CHILD_GAP : 0);
	const width = PAD_X * 2 + Math.max(rows.gridWidth, childWidth, 160);
	const height =
		LABEL_BAND +
		rows.gridHeight +
		(rows.gridHeight && children.length ? CHILD_GAP : 0) +
		childHeight +
		GROUP_BOTTOM_PAD;
	return {
		key: container.key,
		width,
		height,
		gridWidth: rows.gridWidth,
		gridHeight: rows.gridHeight,
		rowHeights: rows.rowHeights,
		cols: rows.cols,
		cards,
		children,
	};
}

// ---- placement --------------------------------------------------------------

interface RenderContext {
	nodes: Array<CanvasTextNode | CanvasGroupNode>;
	paperNodeIds: Map<string, string>;
	paperBoxes: Map<string, { x: number; y: number; w: number; h: number }>;
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

function growBounds(ctx: RenderContext, x: number, y: number, w: number, h: number): void {
	ctx.minX = Math.min(ctx.minX, x);
	ctx.minY = Math.min(ctx.minY, y);
	ctx.maxX = Math.max(ctx.maxX, x + w);
	ctx.maxY = Math.max(ctx.maxY, y + h);
}

function placeCards(
	ctx: RenderContext,
	cards: ShapedCard[],
	cols: number,
	rowHeights: number[],
	originX: number,
	originY: number,
	colorFor: (paper: PaperRecord) => string | undefined,
	papers: Map<string, PaperRecord>
): void {
	if (cards.length === 0) return;
	for (let idx = 0; idx < cards.length; idx++) {
		const card = cards[idx];
		const col = idx % cols;
		const row = Math.floor(idx / cols);
		let yOffset = 0;
		for (let r = 0; r < row; r++) yOffset += rowHeights[r] + GRID_GAP_Y;
		const x = originX + col * (CARD_W + GRID_GAP_X);
		const y = originY + yOffset;
		const paper = papers.get(card.key)!;
		const color = colorFor(paper);
		const nodeId = "n-" + canvasId();
		ctx.nodes.push({
			id: nodeId,
			type: "text",
			x: Math.round(x),
			y: Math.round(y),
			width: CARD_W,
			height: card.height,
			text: card.text,
			...(color ? { color } : {}),
		} as CanvasTextNode);
		ctx.paperNodeIds.set(card.key, nodeId);
		ctx.paperBoxes.set(card.key, { x, y, w: CARD_W, h: card.height });
		growBounds(ctx, x, y, CARD_W, card.height);
	}
}

function renderBox(
	ctx: RenderContext,
	container: ContainerSpec,
	measure: BoxMeasure,
	x: number,
	y: number,
	opts: {
		groupColor?: string;
		colorFor: (p: PaperRecord) => string | undefined;
		papers: Map<string, PaperRecord>;
	}
): void {
	const groupNodeId = "g-" + canvasId();
	ctx.nodes.push({
		id: groupNodeId,
		type: "group",
		x: Math.round(x),
		y: Math.round(y),
		width: Math.round(measure.width),
		height: Math.round(measure.height),
		label: container.label,
		...(opts.groupColor ? { color: opts.groupColor } : {}),
	} as CanvasGroupNode);
	growBounds(ctx, x, y, measure.width, measure.height);

	const cardsOriginX = x + PAD_X;
	const cardsOriginY = y + LABEL_BAND;
	placeCards(ctx, measure.cards, measure.cols, measure.rowHeights, cardsOriginX, cardsOriginY, opts.colorFor, opts.papers);

	// nested child groups below the grid
	let cursorY = cardsOriginY + (measure.gridHeight ? measure.gridHeight + CHILD_GAP : CHILD_GAP * 0.5);
	for (let i = 0; i < container.children.length; i++) {
		const child = container.children[i];
		const childMeasure = measure.children[i];
		renderBox(ctx, child, childMeasure, x + PAD_X, cursorY, opts);
		cursorY += childMeasure.height + CHILD_GAP;
	}
}

// ---- public entry -----------------------------------------------------------

export function buildCanvas(model: AtlasModel, opts: CanvasBuildOptions): CanvasBuildResult {
	const ctx: RenderContext = {
		nodes: [],
		paperNodeIds: new Map(),
		paperBoxes: new Map(),
		minX: Number.POSITIVE_INFINITY,
		minY: Number.POSITIVE_INFINITY,
		maxX: Number.NEGATIVE_INFINITY,
		maxY: Number.NEGATIVE_INFINITY,
	};

	const statusColor = (p: PaperRecord): string | undefined =>
		p.status ? colorOrNone(opts.statusColors[p.status]) : undefined;

	// measure everything first
	const measures = model.containers.map((c) => measureBox(c, model.papers, opts.maxColumns, opts.showZoteroKey));

	const topW = measures.reduce((a, b) => Math.max(a, b.width), 0);
	const topH = measures.reduce((a, b) => a + b.height, 0) + Math.max(0, measures.length - 1) * GROUP_GAP;

	const rootLabel = opts.rootLabel;
	if (opts.wrapInRoot) {
		const w = Math.max(topW, 200) + 2 * 18;
		const h = topH + 2 * 18;
		ctx.nodes.push({
			id: "g-root",
			type: "group",
			x: 0,
			y: 0,
			width: Math.round(w),
			height: Math.round(h),
			label: rootLabel ?? "",
		});
		growBounds(ctx, 0, 0, w, h);
	}

	let yCursor = opts.wrapInRoot ? 18 + LABEL_BAND - 12 : 0;
	for (let i = 0; i < model.containers.length; i++) {
		const container = model.containers[i];
		const m = measures[i];
		renderBox(ctx, container, m, 0, yCursor, {
			groupColor: opts.collectionColor,
			colorFor: statusColor,
			papers: model.papers,
		});
		yCursor += m.height + GROUP_GAP;
	}

	// ---- edges ---------------------------------------------------------------
	const edges: CanvasEdge[] = [];
	for (const [a, b] of model.edges) {
		const idA = ctx.paperNodeIds.get(a);
		const idB = ctx.paperNodeIds.get(b);
		if (!idA || !idB) continue;
		const boxA = ctx.paperBoxes.get(a)!;
		const boxB = ctx.paperBoxes.get(b)!;
		const centerA = { x: boxA.x + boxA.w / 2, y: boxA.y + boxA.h / 2 };
		const centerB = { x: boxB.x + boxB.w / 2, y: boxB.y + boxB.h / 2 };
		const dx = centerB.x - centerA.x;
		const dy = centerB.y - centerA.y;
		let fromNode = idA;
		let toNode = idB;
		let fromSide: CanvasSide;
		let toSide: CanvasSide;
		if (Math.abs(dx) >= Math.abs(dy)) {
			fromSide = dx >= 0 ? "right" : "left";
			toSide = dx >= 0 ? "left" : "right";
		} else {
			fromSide = dy >= 0 ? "bottom" : "top";
			toSide = dy >= 0 ? "top" : "bottom";
		}
		const edge: CanvasEdge = {
			id: "e-" + canvasId(),
			fromNode,
			fromSide,
			toNode,
			toSide,
		};
		if (opts.edgeArrows) {
			const pa = model.papers.get(a);
			const pb = model.papers.get(b);
			if (pa && pb && pa.year !== null && pb.year !== null && pa.year !== pb.year) {
				const older = pa.year < pb.year ? a : b;
				if (older === a) {
					// route the edge the other way so the arrow rests on the older paper
					edge.fromNode = idB;
					edge.fromSide = toSide;
					edge.toNode = idA;
					edge.toSide = fromSide;
					edge.toEnd = "arrow";
				} else {
					edge.toEnd = "arrow";
				}
			}
		}
		edges.push(edge);
	}

	// ---- legend --------------------------------------------------------------
	if (opts.showLegend && model.papers.size > 0) {
		const lines: string[] = [];
		const names: Array<[string, string]> = [
			["annotated", opts.statusColors.annotated],
			["read", opts.statusColors.read],
			["unread", opts.statusColors.unread],
		];
		const used = names.filter(([, c]) => Boolean(c));
		if (used.length) {
			lines.push("**Reading status**");
			for (const [label, color] of used) lines.push(`• ${paletteName(color)} cards — ${label}`);
		}
		const neutral = names.find(([, c]) => !c);
		if (neutral) lines.push(`• plain cards — ${neutral[0]}`);
		if (model.stats.externalDrawn > 0) {
			lines.push(`• “${truncate(model.containers.find((c) => c.key === "__external__")?.label ?? "Cited works", 40)}” — outside selection`);
		}
		if (opts.edgeArrows) lines.push("• arrow points from newer to older (cited) work");
		lines.push("");
		lines.push(`**${opts.rootLabel ?? "Citation Atlas"}**`);
		lines.push(`${model.stats.drawnPapers} papers · ${edges.length} citation links`);
		const text = lines.join("\n");
		const width = 340;
		const height = estimateTextHeight(text, 40);
		let x = 0;
		let y = yCursor + 24;
		// grow the root container if the legend does not fit inside it
		if (opts.wrapInRoot) {
			const root = ctx.nodes.find((n) => n.id === "g-root");
			if (root) {
				const legendBottom = y + height + 20;
				const legendRight = x + width + 20;
				if (legendBottom > root.y + root.height) {
					root.height = Math.round(legendBottom - root.y + 10);
					ctx.maxY = Math.max(ctx.maxY, root.y + root.height);
				}
				if (legendRight > root.x + root.width) {
					root.width = Math.round(legendRight - root.x + 10);
					ctx.maxX = Math.max(ctx.maxX, root.x + root.width);
				}
			}
		}
		ctx.nodes.push({
			id: "n-legend",
			type: "text",
			x,
			y: Math.round(y),
			width,
			height,
			text,
		});
		growBounds(ctx, x, y, width, height);
	}

	const W = Math.max(1, ctx.maxX - ctx.minX);
	const H = Math.max(1, ctx.maxY - ctx.minY);
	const zoom = Math.max(0.15, Math.min(1, 1600 / W, 1000 / H));

	return {
		canvas: {
			nodes: ctx.nodes,
			edges,
			view: { x: 0, y: 0, zoom },
		},
		paperNodes: ctx.paperNodeIds.size,
		groupNodes: ctx.nodes.filter((n) => n.type === "group").length,
		edges: edges.length,
		width: Math.round(W),
		height: Math.round(H),
	};
}
