import { App, PluginSettingTab, Setting } from "obsidian";
import { PALETTE } from "./lib/reading";
import type CitationAtlasPlugin from "./main";

export interface CitationAtlasSettings {
	zoteroBaseUrl: string;
	outputFolder: string;
	fileNamePattern: string;
	openAfterExport: boolean;
	wrapInRoot: boolean;
	rootLabel: string;
	showLegend: boolean;
	showZoteroKey: boolean;
	collectionColor: string; // "" | "1".."6"
	maxColumns: number;
	// reading-status colors
	colorAnnotated: string;
	colorRead: string;
	colorUnread: string;
	// reading-status rules
	autoAnnotated: boolean;
	annotatedTags: string;
	readTags: string;
	unreadTags: string;
	readTagPrefix: boolean;
	stateFallback: "unread" | "read";
	colorExternals: boolean;
	// edges
	edgeArrows: boolean;
	resolveExternals: boolean;
	maxExternals: number;
	sortByYear: boolean;
	// note linking
	linkNoteMode: "off" | "citekey" | "title" | "both";
}

export const DEFAULT_SETTINGS: CitationAtlasSettings = {
	zoteroBaseUrl: "http://127.0.0.1:23119",
	outputFolder: "",
	fileNamePattern: "Citation Atlas - {mode} - {date}",
	openAfterExport: true,
	wrapInRoot: true,
	rootLabel: "Citation Atlas · {mode} · {count} papers · {date}",
	showLegend: true,
	showZoteroKey: false,
	collectionColor: "",
	maxColumns: 4,
	colorAnnotated: "1",
	colorRead: "4",
	colorUnread: "3",
	autoAnnotated: true,
	annotatedTags: "Annotated",
	readTags: "Read",
	unreadTags: "Unread",
	readTagPrefix: true,
	stateFallback: "unread",
	colorExternals: false,
	edgeArrows: true,
	resolveExternals: false,
	maxExternals: 60,
	sortByYear: true,
	linkNoteMode: "off",
};

export function parseTagList(raw: string): string[] {
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function tagListToString(list: string[]): string {
	return list.join(", ");
}

const COLOR_OPTIONS = [
	{ value: "", label: "No color (default card)" },
	...Object.entries(PALETTE).map(([value, name]) => ({ value, label: `${value} · ${name}` })),
];

export class CitationAtlasSettingTab extends PluginSettingTab {
	plugin: CitationAtlasPlugin;

	constructor(app: App, plugin: CitationAtlasPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Zotero connection").setHeading();

		new Setting(containerEl)
			.setName("Zotero Local API base URL")
			.setDesc("Citation Atlas reads your library through the Zotero Local API on this machine.")
			.addText((text) =>
				text
					.setPlaceholder("http://127.0.0.1:23119")
					.setValue(this.plugin.settings.zoteroBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.zoteroBaseUrl = value.trim() || DEFAULT_SETTINGS.zoteroBaseUrl;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Test connection / reload data")
			.setDesc('Zotero must be running with Settings → Advanced → "Allow other applications on this computer to communicate with Zotero" enabled.')
			.addButton((btn) =>
				btn
					.setButtonText("Test connection")
					.onClick(async () => {
						const ok = await this.plugin.testZotero();
						btn.setButtonText(ok ? "Connected ✓" : "Not reachable");
						setTimeout(() => btn.setButtonText("Test connection"), 2500);
					})
			);

		new Setting(containerEl).setName("Output").setHeading();

		new Setting(containerEl)
			.setName("Output folder")
			.setDesc("Vault-relative folder for generated .canvas files (empty = vault root).")
			.addText((text) =>
				text
					.setPlaceholder("Citation Maps")
					.setValue(this.plugin.settings.outputFolder)
					.onChange(async (value) => {
						this.plugin.settings.outputFolder = value.trim().replace(/^\/+|\/+$/g, "");
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("File name pattern")
			.setDesc("Supports {mode}, {date}, {time}, {count}. Existing files get a numeric suffix.")
			.addText((text) =>
				text
					.setPlaceholder("Citation Atlas - {mode} - {date}")
					.setValue(this.plugin.settings.fileNamePattern)
					.onChange(async (value) => {
						this.plugin.settings.fileNamePattern = value.trim() || DEFAULT_SETTINGS.fileNamePattern;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Open the canvas after export")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.openAfterExport).onChange(async (v) => {
					this.plugin.settings.openAfterExport = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Wrap the whole map in one container group")
			.setDesc("Lets you grab and move the entire literature map as a unit.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.wrapInRoot).onChange(async (v) => {
					this.plugin.settings.wrapInRoot = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Root container label")
			.setDesc("Supports {mode}, {date}, {time}, {count}.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.rootLabel)
					.setDisabled(!this.plugin.settings.wrapInRoot)
					.onChange(async (value) => {
						this.plugin.settings.rootLabel = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Legend card")
			.setDesc("Add a small legend node to the canvas explaining the colors.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showLegend).onChange(async (v) => {
					this.plugin.settings.showLegend = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Show Zotero key on cards")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showZoteroKey).onChange(async (v) => {
					this.plugin.settings.showZoteroKey = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Container (collection) color")
			.addDropdown((dd) => {
				for (const o of COLOR_OPTIONS) dd.addOption(o.value, o.label);
				dd.setValue(this.plugin.settings.collectionColor).onChange(async (v) => {
					this.plugin.settings.collectionColor = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Max columns per collection grid")
			.addSlider((s) =>
				s
					.setLimits(1, 6, 1)
					.setValue(this.plugin.settings.maxColumns)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.maxColumns = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Reading status").setHeading();

		new Setting(containerEl)
			.setName("Detect annotations automatically")
			.setDesc("Papers with PDF/EPUB annotation child items in Zotero count as annotated, no tags needed.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoAnnotated).onChange(async (v) => {
					this.plugin.settings.autoAnnotated = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("“Annotated” tags")
			.setDesc("Comma separated. Applied on top of automatic annotation detection.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.annotatedTags)
					.onChange(async (value) => {
						this.plugin.settings.annotatedTags = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("“Read” tags")
			.setDesc('Tag names that mark an item as read, e.g. "Read" (also matches "Read 2026-01-02").')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.readTags)
					.onChange(async (value) => {
						this.plugin.settings.readTags = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("“Unread” tags")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.unreadTags)
					.onChange(async (value) => {
						this.plugin.settings.unreadTags = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("“Read” tags match by prefix")
			.setDesc("Treat “Read 2026-01-02” as a read tag when “Read” is configured.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.readTagPrefix).onChange(async (v) => {
					this.plugin.settings.readTagPrefix = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Status when no signal matches")
			.addDropdown((dd) => {
				dd.addOption("unread", "Unread (recommended)");
				dd.addOption("read", "Read");
				dd.setValue(this.plugin.settings.stateFallback).onChange(async (v) => {
					this.plugin.settings.stateFallback = v as "unread" | "read";
					await this.plugin.saveSettings();
				});
			});

		for (const [state, key] of [
			["Annotated cards", "colorAnnotated"],
			["Read cards", "colorRead"],
			["Unread cards", "colorUnread"],
		] as const) {
			new Setting(containerEl).setName(state + " color").addDropdown((dd) => {
				for (const o of COLOR_OPTIONS) dd.addOption(o.value, o.label);
				dd.setValue(String(this.plugin.settings[key])).onChange(async (v) => {
					this.plugin.settings[key] = v;
					await this.plugin.saveSettings();
				});
			});
		}

		new Setting(containerEl)
			.setName("Color out-of-selection cited works too")
			.setDesc("When off, papers fetched only because they are cited stay uncolored to separate them from the reading map.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.colorExternals).onChange(async (v) => {
					this.plugin.settings.colorExternals = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Citations & scope").setHeading();

		new Setting(containerEl)
			.setName("Arrow points at the cited (older) work")
			.setDesc("Only drawn when both papers have a publication year.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.edgeArrows).onChange(async (v) => {
					this.plugin.settings.edgeArrows = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Add cited works outside the selection")
			.setDesc("Fetch metadata of referenced papers that are not part of the pick and draw them in their own container.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.resolveExternals).onChange(async (v) => {
					this.plugin.settings.resolveExternals = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Max out-of-selection papers")
			.setDesc("Hard cap so a densely citing collection cannot explode the canvas.")
			.addSlider((s) =>
				s
					.setLimits(10, 200, 10)
					.setValue(this.plugin.settings.maxExternals)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.maxExternals = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sort papers by year")
			.setDesc("Oldest first inside every container; turn off to keep Zotero's own order.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.sortByYear).onChange(async (v) => {
					this.plugin.settings.sortByYear = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Notes").setHeading();

		new Setting(containerEl)
			.setName("Link paper cards to vault notes")
			.setDesc("When a markdown note matches a paper (by Better BibTeX citation key and/or exact title), the card becomes a link to it. Titles starting with “#” are ignored.")
			.addDropdown((dd) => {
				dd.addOption("off", "Off — plain text cards");
				dd.addOption("citekey", "By Better BibTeX citation key");
				dd.addOption("title", "By exact note title");
				dd.addOption("both", "Citation key or exact title");
				dd.setValue(this.plugin.settings.linkNoteMode).onChange(async (v) => {
					this.plugin.settings.linkNoteMode = v as CitationAtlasSettings["linkNoteMode"];
					await this.plugin.saveSettings();
				});
			});
	}
}
