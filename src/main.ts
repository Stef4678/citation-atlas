import { Notice, Plugin, TFile, requestUrl } from "obsidian";
import { CitationAtlasSettingTab, DEFAULT_SETTINGS, parseTagList, type CitationAtlasSettings } from "./settings";
import type { ExportDataSource, PickMode } from "./ui/exportModal";
import { CitationExportModal } from "./ui/exportModal";
import { ZoteroClient, type RawHttpGet } from "./lib/zoteroClient";
import { buildAtlasModel, type ExportRequest } from "./lib/exporter";
import { buildCanvas, type StatusColorMap } from "./lib/canvas";
import type { ReadingRules } from "./lib/reading";
import { authorIndex, citationKey } from "./lib/display";
import { casefold, nowStamp, sanitizeFileName, todayStamp, truncate } from "./lib/util";
import type { ZoteroItem } from "./lib/zoteroTypes";

/** HTTP transport that goes through Obsidian's main process (no CORS limits). */
function obsidianTransport(): RawHttpGet {
	return async (url: string) => {
		const res = await requestUrl({
			url,
			method: "GET",
			headers: {
				Accept: "application/json",
				"Zotero-API-Version": "3",
				"User-Agent": "Citation-Atlas-Obsidian/1.0",
			},
		});
		let json: unknown = null;
		try {
			json = res.json;
		} catch {
			json = null;
		}
		return { status: res.status, text: res.text, json };
	};
}

const MODE_NOUN: Record<PickMode, string> = {
	collections: "collection",
	items: "items",
	authors: "author",
};

export default class CitationAtlasPlugin extends Plugin {
	settings: CitationAtlasSettings = DEFAULT_SETTINGS;
	private client?: ZoteroClient;
	private clientBase = "";
	private exportRunning = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new CitationAtlasSettingTab(this.app, this));

		const open = (mode: PickMode) => () => {
			const dataSource = this.dataSource();
			new CitationExportModal(this.app, dataSource, (m, keys, includeSub) => this.runExport(m, keys, includeSub), mode).open();
		};

		this.addCommand({
			id: "export-collection",
			name: "Export a Zotero collection to a citation-map canvas",
			callback: open("collections"),
		});
		this.addCommand({
			id: "export-items",
			name: "Export picked Zotero items to a citation-map canvas",
			callback: open("items"),
		});
		this.addCommand({
			id: "export-author",
			name: "Export an author's Zotero papers to a citation-map canvas",
			callback: open("authors"),
		});
		this.addCommand({
			id: "reload-zotero",
			name: "Reload Zotero data (clear cached library snapshot)",
			callback: () => {
				this.client?.clearCache();
				new Notice("Citation Atlas: Zotero cache cleared. Next export will re-read the library.");
			},
		});

		this.addRibbonIcon("network", "Citation Atlas — export citation-map canvas", open("collections"));
	}

	onunload(): void {
		this.client = undefined;
	}

	// ------------------------------------------------------------------ data

	ensureClient(): ZoteroClient {
		if (!this.client || this.clientBase !== this.settings.zoteroBaseUrl) {
			this.clientBase = this.settings.zoteroBaseUrl;
			this.client = new ZoteroClient(this.settings.zoteroBaseUrl, obsidianTransport());
		}
		return this.client;
	}

	async testZotero(): Promise<boolean> {
		try {
			await this.ensureClient().ping();
			return true;
		} catch (err) {
			new Notice("Citation Atlas: " + (err instanceof Error ? err.message : String(err)), 7000);
			return false;
		}
	}

	private dataSource(): ExportDataSource {
		const client = () => this.ensureClient();
		return {
			collections: () => client().collections(),
			topItems: () => client().topItems(),
			authors: async () => {
				const items = await client().topItems();
				return authorIndex(items);
			},
			clearCache: () => client().clearCache(),
		};
	}

	// ------------------------------------------------------------ note lookup

	private buildNoteIndex(): Map<string, string[]> {
		const idx = new Map<string, string[]>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const base = file.basename;
			if (!base || base.startsWith("#")) continue;
			if (base.startsWith(".")) continue;
			const norm = casefold(base).replace(/\s+/g, " ").trim();
			if (!norm) continue;
			const list = idx.get(norm) ?? [];
			list.push(file.path);
			idx.set(norm, list);
		}
		for (const paths of idx.values()) paths.sort((a, b) => a.length - b.length || a.localeCompare(b));
		return idx;
	}

	private notePathOf(item: ZoteroItem, idx: Map<string, string[]>): string | null {
		const mode = this.settings.linkNoteMode;
		if (mode === "off") return null;
		const candidates: string[] = [];
		const add = (s: string | null | undefined) => {
			if (!s) return;
			const norm = casefold(s).replace(/\s+/g, " ").trim();
			if (norm && !candidates.includes(norm)) candidates.push(norm);
		};
		if (mode === "citekey" || mode === "both") add(citationKey(item));
		if (mode === "title" || mode === "both") {
			add(item.data.title);
			add(item.key);
		}
		for (const c of candidates) {
			const matches = idx.get(c);
			if (matches && matches.length) return matches[0];
		}
		return null;
	}

	// ---------------------------------------------------------------- export

	private readingRules(): ReadingRules {
		const s = this.settings;
		return {
			autoAnnotated: s.autoAnnotated,
			annotatedTags: parseTagList(s.annotatedTags),
			readTags: parseTagList(s.readTags),
			unreadTags: parseTagList(s.unreadTags),
			readTagPrefix: s.readTagPrefix,
			fallback: s.stateFallback,
		};
	}

	private statusColors(): StatusColorMap {
		const s = this.settings;
		return {
			annotated: s.colorAnnotated ?? DEFAULT_SETTINGS.colorAnnotated,
			read: s.colorRead ?? DEFAULT_SETTINGS.colorRead,
			unread: s.colorUnread ?? DEFAULT_SETTINGS.colorUnread,
		};
	}

	async runExport(mode: PickMode, keys: string[], includeSub: boolean): Promise<void> {
		if (this.exportRunning) throw new Error("Another export is already running.");
		this.exportRunning = true;
		try {
			const s = this.settings;
			const client = this.ensureClient();
			const request: ExportRequest = {
				mode,
				collectionKeys: mode === "collections" ? keys : [],
				includeSubcollections: mode === "collections" ? includeSub : false,
				itemKeys: mode === "items" ? keys : [],
				authors: mode === "authors" ? keys : [],
			};
			const noteIndex = s.linkNoteMode === "off" ? null : this.buildNoteIndex();
			const model = await buildAtlasModel(client, request, {
				readingRules: this.readingRules(),
				sortByYear: s.sortByYear,
				resolveExternals: s.resolveExternals,
				maxExternals: Math.max(0, s.maxExternals),
				colorExternals: s.colorExternals,
				notePathOf: noteIndex ? (item) => this.notePathOf(item, noteIndex) : undefined,
			});

			if (model.papers.size === 0) {
				throw new Error("Nothing to draw — no papers matched your selection.");
			}

			const tokens = {
				mode: MODE_NOUN[mode],
				date: todayStamp(),
				time: nowStamp(),
				count: String(model.papers.size),
			};
			const expand = (pattern: string) =>
				pattern.replace(/\{(\w+)\}/g, (_, k: string) => tokens[k as keyof typeof tokens] ?? "");

			const rootLabel = s.wrapInRoot ? (expand(s.rootLabel || "Citation Atlas") || "Citation Atlas") : null;

			const { canvas, paperNodes, edges } = buildCanvas(model, {
				statusColors: this.statusColors(),
				collectionColor: s.collectionColor,
				edgeArrows: s.edgeArrows,
				wrapInRoot: s.wrapInRoot,
				rootLabel,
				showLegend: s.showLegend,
				showZoteroKey: s.showZoteroKey,
				maxColumns: Math.max(1, Math.min(6, s.maxColumns)),
			});

			const path = await this.writeCanvasFile(expand(s.fileNamePattern || "Citation Atlas - {mode} - {date}"), canvas);

			for (const w of model.warnings) new Notice("Citation Atlas: " + truncate(w, 260), 6000);

			if (s.openAfterExport) await this.openCanvasFile(path);

			const extra = model.stats.externalDrawn ? ` · ${model.stats.externalDrawn} cited works outside the selection` : "";
			new Notice(
				`Citation Atlas: ${paperNodes} papers · ${edges} citation links → ${path}${extra}`,
				7000
			);
		} finally {
			this.exportRunning = false;
		}
	}

	private async writeCanvasFile(baseName: string, canvas: unknown): Promise<string> {
		const folder = this.settings.outputFolder.replace(/^\/+|\/+$/g, "");
		const name = sanitizeFileName(baseName);
		await this.ensureFolder(folder);
		let candidate = folder ? `${folder}/${name}.canvas` : `${name}.canvas`;
		let i = 2;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = folder ? `${folder}/${name}-${i}.canvas` : `${name}-${i}.canvas`;
			i++;
		}
		const json = JSON.stringify(canvas, null, 1);
		await this.app.vault.create(candidate, json);
		return candidate;
	}

	private async ensureFolder(folder: string): Promise<void> {
		if (!folder) return;
		const parts = folder.split("/").filter(Boolean);
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(cur)) {
				await this.app.vault.createFolder(cur);
			}
		}
	}

	private async openCanvasFile(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		try {
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file);
		} catch {
			// fall back to link navigation for older Obsidian builds
			void this.app.workspace.openLinkText(path, "", false);
		}
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<CitationAtlasSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
