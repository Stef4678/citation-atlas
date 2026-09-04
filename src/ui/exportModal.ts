import { App, Modal, Notice, setIcon } from "obsidian";
import type { AuthorEntry } from "../lib/display";
import { itemListLine } from "../lib/display";
import type { ZoteroCollection, ZoteroItem } from "../lib/zoteroTypes";
import { NON_PAPER_TYPES } from "../lib/zoteroTypes";
import { fuzzyMatch, truncate } from "../lib/util";
import { ZoteroError } from "../lib/zoteroClient";

export type PickMode = "collections" | "items" | "authors";

export interface ExportDataSource {
	collections(): Promise<ZoteroCollection[]>;
	topItems(): Promise<ZoteroItem[]>;
	authors(): Promise<AuthorEntry[]>;
	clearCache(): void;
}

const MODE_TABS: Array<{ mode: PickMode; label: string }> = [
	{ mode: "collections", label: "Collections" },
	{ mode: "items", label: "Items" },
	{ mode: "authors", label: "Authors" },
];

interface RowData {
	id: string;
	primary: string;
	secondary: string;
	meta: string;
}

function collectionPathLabel(key: string, byKey: Map<string, ZoteroCollection>, depth = 0): string {
	if (depth > 10) return "(?)";
	const c = byKey.get(key);
	if (!c) return "";
	const parent = c.data.parentCollection;
	const own = c.data.name || "(unnamed collection)";
	if (typeof parent === "string" && parent && byKey.has(parent)) {
		return collectionPathLabel(parent, byKey, depth + 1) + " / " + own;
	}
	return own;
}

function describeZoteroError(err: unknown): string {
	if (err instanceof ZoteroError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * One dialog to pick collections, individual items, or authors, then export a
 * canvas map. Selections persist while the dialog is open so you can compare
 * tabs before exporting.
 */
export class CitationExportModal extends Modal {
	private dataSource: ExportDataSource;
	private onExport: (mode: PickMode, keys: string[], includeSub: boolean) => Promise<void>;

	private mode: PickMode = "collections";
	private query = "";
	private includeSub = true;
	private busy = false;

	private cacheCollections?: Promise<ZoteroCollection[]>;
	private cacheItems?: Promise<ZoteroItem[]>;
	private cacheAuthors?: Promise<AuthorEntry[]>;

	// resolved copies of the cached promises (populated by loadTab)
	private cols?: ZoteroCollection[];
	private items?: ZoteroItem[];
	private authors?: AuthorEntry[];

	private selected: Record<PickMode, Set<string>> = {
		collections: new Set(),
		items: new Set(),
		authors: new Set(),
	};

	private statusEl!: HTMLElement;
	private listEl!: HTMLElement;
	private searchEl!: HTMLInputElement;
	private exportBtn!: HTMLElement;
	private subOptionEl?: HTMLElement;

	constructor(
		app: App,
		dataSource: ExportDataSource,
		onExport: (mode: PickMode, keys: string[], includeSub: boolean) => Promise<void>,
		initialMode: PickMode = "collections"
	) {
		super(app);
		this.dataSource = dataSource;
		this.onExport = onExport;
		this.mode = initialMode;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ca-modal");
		this.modalEl.addClass("ca-modal-wrap");

		const head = contentEl.createDiv({ cls: "ca-modal-head" });
		head.createEl("h3", { text: "Citation Atlas — export to canvas" });

		const tabs = contentEl.createDiv({ cls: "ca-tabs" });
		for (const tab of MODE_TABS) {
			const btn = tabs.createEl("button", { cls: "ca-tab", text: tab.label });
			btn.addEventListener("click", () => this.setMode(tab.mode));
		}

		const optionsRow = contentEl.createDiv({ cls: "ca-options" });
		this.subOptionEl = optionsRow.createEl("label", { cls: "ca-check" });
		const subCheck = this.subOptionEl.createEl("input", { attr: { type: "checkbox" } });
		subCheck.checked = this.includeSub;
		subCheck.addEventListener("change", () => {
			this.includeSub = subCheck.checked;
		});
		this.subOptionEl.appendText(" include sub-collections as nested groups");

		const searchRow = contentEl.createDiv({ cls: "ca-search-row" });
		this.searchEl = searchRow.createEl("input", {
			cls: "ca-search",
			attr: { type: "search", placeholder: "Search…" },
		});
		const refresh = searchRow.createEl("button", { cls: "ca-icon-btn", attr: { title: "Reload from Zotero" } });
		setIcon(refresh, "refresh-cw");
		refresh.addEventListener("click", () => {
			this.dataSource.clearCache();
			this.cacheCollections = undefined;
			this.cacheItems = undefined;
			this.cacheAuthors = undefined;
			this.cols = undefined;
			this.items = undefined;
			this.authors = undefined;
			void this.loadTab();
		});

		this.statusEl = contentEl.createDiv({ cls: "ca-status" });
		const bodyEl = contentEl.createDiv({ cls: "ca-body" });
		this.listEl = bodyEl.createDiv({ cls: "ca-list" });

		const foot = contentEl.createDiv({ cls: "ca-foot" });
		const bulk = foot.createDiv({ cls: "ca-bulk" });
		const selectAll = bulk.createEl("button", { cls: "mod-muted", text: "Select filtered" });
		selectAll.addEventListener("click", () => {
			for (const r of this.currentRows()) this.selected[this.mode].add(r.id);
			this.renderList();
		});
		const clear = bulk.createEl("button", { cls: "mod-muted", text: "Clear" });
		clear.addEventListener("click", () => {
			this.selected[this.mode].clear();
			this.renderList();
		});
		const right = foot.createDiv({ cls: "ca-foot-right" });
		const cancel = right.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		this.exportBtn = right.createEl("button", {
			cls: "mod-cta",
			text: "Export to canvas",
		});
		this.exportBtn.addEventListener("click", () => {
			void this.runExport();
		});

		this.searchEl.addEventListener("input", () => {
			this.query = this.searchEl.value;
			this.renderList();
		});

		this.setMode(this.mode);
	}

	private setMode(mode: PickMode): void {
		this.mode = mode;
		const tabEls = this.contentEl.querySelectorAll(".ca-tab");
		tabEls.forEach((t, i) => {
			t.toggleClass("is-active", MODE_TABS[i]?.mode === mode);
		});
		if (this.subOptionEl) this.subOptionEl.style.display = mode === "collections" ? "" : "none";
		this.query = "";
		if (this.searchEl) this.searchEl.value = "";
		void this.loadTab();
	}

	/** Load the data backing the active tab (cached per session). */
	private async loadTab(): Promise<void> {
		this.setStatus("Loading Zotero data…");
		try {
			if (this.mode === "collections") {
				if (!this.cols) {
					if (!this.cacheCollections) this.cacheCollections = this.dataSource.collections();
					this.cols = await this.cacheCollections;
				}
				this.setStatus(this.cols.length ? `${this.cols.length} collections` : "Your Zotero library has no collections yet.");
			} else if (this.mode === "items") {
				if (!this.items) {
					if (!this.cacheItems) this.cacheItems = this.dataSource.topItems();
					this.items = await this.cacheItems;
				}
				const papers = this.items.filter((i) => !NON_PAPER_TYPES.has(i.data.itemType)).length;
				this.setStatus(this.items.length ? `${papers} papers` : "Your Zotero library has no top-level items.");
			} else {
				if (!this.authors) {
					if (!this.cacheAuthors) this.cacheAuthors = this.dataSource.authors();
					this.authors = await this.cacheAuthors;
				}
				this.setStatus(this.authors.length ? `${this.authors.length} authors` : "No authors found — is the library empty?");
			}
			this.renderList();
		} catch (err) {
			this.listEl.empty();
			const empty = this.listEl.createDiv({ cls: "ca-empty" });
			empty.setText(describeZoteroError(err));
			this.setStatus("Zotero data could not be loaded", true);
		}
	}

	private currentRows(): RowData[] {
		const q = this.query;
		const rows: RowData[] = [];
		if (this.mode === "collections") {
			const cols = this.cols;
			if (!cols) return rows;
			const byKey = new Map(cols.map((c) => [c.key, c]));
			for (const c of cols) {
				const label = collectionPathLabel(c.key, byKey);
				if (q && !fuzzyMatch(label, q)) continue;
				rows.push({ id: c.key, primary: c.data.name || "(unnamed)", secondary: label, meta: "" });
			}
			rows.sort((a, b) => a.secondary.localeCompare(b.secondary));
		} else if (this.mode === "items") {
			const items = this.items;
			if (!items) return rows;
			for (const it of items) {
				if (NON_PAPER_TYPES.has(it.data.itemType)) continue;
				const hay = itemListLine(it) + " " + (it.data.DOI ?? "") + " " + it.key;
				if (q && !fuzzyMatch(hay, q)) continue;
				rows.push({
					id: it.key,
					primary: truncate(it.data.title?.trim() || "(untitled)", 160),
					secondary: itemListLine(it, 200),
					meta: "",
				});
			}
			rows.sort((a, b) => a.secondary.localeCompare(b.secondary));
		} else {
			const authors = this.authors;
			if (!authors) return rows;
			for (const a of authors) {
				const hay = a.label;
				if (q && !fuzzyMatch(hay, q)) continue;
				rows.push({
					id: a.normalized,
					primary: a.label,
					secondary: `${a.items} ${a.items === 1 ? "item" : "items"}`,
					meta: a.roles.size ? [...a.roles].slice(0, 3).join(", ") : "",
				});
			}
		}
		return rows;
	}

	private renderList(): void {
		this.listEl.empty();
		const rows = this.currentRows();
		if (rows.length === 0) {
			const note = this.listEl.createDiv({ cls: "ca-empty" });
			note.setText(this.query ? "Nothing matches your search." : "Nothing to show yet.");
			this.setStatus(`${this.selected[this.mode].size} selected`);
			return;
		}
		const selection = this.selected[this.mode];
		const MAX_ROWS = 400;
		let shown = 0;
		for (const row of rows) {
			if (shown >= MAX_ROWS) break;
			shown++;
			const rowEl = this.listEl.createDiv({ cls: "ca-row" });
			const isSel = selection.has(row.id);
			rowEl.toggleClass("is-selected", isSel);
			const check = rowEl.createDiv({ cls: "ca-checkbox" });
			check.setText(isSel ? "✓" : "");
			const textEl = rowEl.createDiv({ cls: "ca-row-text" });
			textEl.createDiv({ cls: "ca-row-primary" }).setText(row.primary);
			if (row.secondary) textEl.createDiv({ cls: "ca-row-secondary" }).setText(row.secondary);
			if (row.meta) rowEl.createDiv({ cls: "ca-row-meta" }).setText(row.meta);
			rowEl.addEventListener("click", () => this.toggleRow(row.id, rowEl));
		}
		if (rows.length > shown) {
			this.listEl.createDiv({ cls: "ca-more" }).setText(`Showing ${shown} of ${rows.length} — keep typing to filter.`);
		}
		this.setStatus(`${selection.size} selected`);
	}

	private toggleRow(id: string, rowEl: HTMLElement): void {
		const sel = this.selected[this.mode];
		if (sel.has(id)) {
			sel.delete(id);
			rowEl.toggleClass("is-selected", false);
			rowEl.querySelector(".ca-checkbox")?.setText("");
		} else {
			sel.add(id);
			rowEl.toggleClass("is-selected", true);
			rowEl.querySelector(".ca-checkbox")?.setText("✓");
		}
		this.setStatus(`${sel.size} selected`);
	}

	private setStatus(text: string, error = false): void {
		this.statusEl.setText(text);
		this.statusEl.toggleClass("is-error", error);
	}

	private async runExport(): Promise<void> {
		const keys = [...this.selected[this.mode]];
		if (keys.length === 0) {
			new Notice("Select at least one " + (this.mode === "collections" ? "collection" : this.mode === "items" ? "item" : "author") + " first.");
			return;
		}
		if (this.busy) return;
		this.busy = true;
		this.exportBtn.setText("Building canvas…");
		this.exportBtn.toggleClass("is-disabled", true);
		try {
			await this.onExport(this.mode, keys, this.includeSub);
			this.close();
		} catch (err) {
			this.busy = false;
			this.exportBtn.setText("Export to canvas");
			this.exportBtn.toggleClass("is-disabled", false);
			new Notice("Citation Atlas: " + truncate(describeZoteroError(err), 400), 9000);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
