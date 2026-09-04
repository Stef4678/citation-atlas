import type { ZoteroCollection, ZoteroItem } from "./zoteroTypes";

/**
 * Error surfaced to the UI when talking to Zotero fails. `issue` drives the
 * human-readable hint shown to the user.
 */
export type ZoteroIssue = "unreachable" | "forbidden" | "unsupported" | "http" | "parse";

export class ZoteroError extends Error {
	issue: ZoteroIssue;
	status?: number;
	url?: string;

	constructor(issue: ZoteroIssue, message: string, status?: number, url?: string) {
		super(message);
		this.name = "ZoteroError";
		this.issue = issue;
		this.status = status;
		this.url = url;
	}
}

/** A raw HTTP GET that the concrete runtime (Obsidian requestUrl / Node fetch) provides. */
export interface RawHttpGet {
	(url: string): Promise<{ status: number; text: string; json: unknown }>;
}

export const ENABLE_HINT =
	'In Zotero, enable Settings → Advanced → “Allow other applications on this computer to communicate with Zotero” ' +
	'(config key extensions.zotero.httpServer.enabled) and restart Zotero if it was just switched on.';

export function curlProbe(path = "/api/users/0/collections?format=json"): string {
	return `Test from a terminal: curl -i "http://127.0.0.1:23119${path}"`;
}

function snippet(text: string, max = 180): string {
	const clean = (text || "").replace(/\s+/g, " ").trim();
	return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

function looksLikeRequestNotAllowed(text: string): boolean {
	return /request not allowed|not allowed/i.test(text || "");
}

/**
 * Performs one JSON GET and classifies every possible outcome into an
 * actionable ZoteroError. Empty bodies, "Request not allowed" pages, plain-HTML
 * error pages, closed connections and wrong ports all get distinct messages so
 * the user can see exactly which layer is failing.
 */
export async function jsonGet(baseUrl: string, path: string, rawGet: RawHttpGet): Promise<unknown> {
	const url = baseUrl.replace(/\/+$/, "") + path;
	let res: { status: number; text: string; json: unknown };
	try {
		res = await rawGet(url);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// socket hang up / ECONNREFUSED / ERR_EMPTY_RESPONSE all land here
		throw new ZoteroError(
			"unreachable",
			`Could not reach Zotero at ${url} (${msg}). Either Zotero is not running or its local HTTP server is switched off. ` +
				ENABLE_HINT +
				` If it is already enabled, make sure no other program is occupying port 23119. ` +
				curlProbe(),
			undefined,
			url
		);
	}
	const status = res.status;
	const text = res.text || "";

	if (status === 403) {
		throw new ZoteroError(
			"forbidden",
			`Zotero refused the request (HTTP 403) for ${path}. ${ENABLE_HINT}${text ? ` Server said: “${snippet(text, 120)}”` : ""}`,
			403,
			url
		);
	}
	if (status === 404) {
		throw new ZoteroError(
			"unsupported",
			`Zotero returned HTTP 404 for ${path}. Citation Atlas needs a recent Zotero (7.0+) with the Local API, and the base URL must point at the Local API (default http://127.0.0.1:23119). ${curlProbe(path)}`,
			404,
			url
		);
	}
	if (status >= 400) {
		throw new ZoteroError(
			"http",
			`Zotero returned HTTP ${status} for ${path}.${text ? ` Body: “${snippet(text, 200)}”` : ""}`,
			status,
			url
		);
	}
	// Success status — but is the body actually the JSON we asked for?
	let json: unknown = null;
	try {
		json = res.json;
	} catch {
		json = null;
	}
	if (json === undefined || json === null) {
		if (looksLikeRequestNotAllowed(text)) {
			throw new ZoteroError(
				"forbidden",
				`Zotero says “Request not allowed” for ${path}. The Zotero Local API refuses browser-style requests, so testing it in a web browser always fails. ` +
					`This plugin talks to it from Obsidian's desktop process (like curl). If the plugin still fails, check the server setting: ${ENABLE_HINT} ${curlProbe(path)}`,
				403,
				url
			);
		}
		if (!text) {
			throw new ZoteroError(
				"http",
				`Zotero answered with an empty response (HTTP ${status}, no body) for ${path}. The request reached a server that is not answering as the Zotero Local API — ` +
					`check that no other program is using port 23119, that Zotero is a recent version (7.0+), and that the server is enabled (${ENABLE_HINT}) ${curlProbe(path)}`,
				status,
				url
			);
		}
		throw new ZoteroError(
			"parse",
			`Zotero returned a response that is not JSON for ${path} (HTTP ${status}). Body: “${snippet(text, 200)}”. ${curlProbe(path)}`,
			status,
			url
		);
	}
	return json;
}

/**
 * Read-only client for the Zotero Local API. Pure: the actual network call is
 * injected so the same code runs in Obsidian (requestUrl) and in tests (fetch).
 * Responses are memoized for the lifetime of the client; call {@link clearCache}
 * to force a refresh.
 */
export class ZoteroClient {
	private readonly baseUrl: string;
	private readonly rawGet: RawHttpGet;
	private readonly cache = new Map<string, Promise<unknown>>();

	constructor(baseUrl: string, rawGet: RawHttpGet) {
		this.baseUrl = baseUrl;
		this.rawGet = rawGet;
	}

	/** Forget every cached response. */
	clearCache(): void {
		this.cache.clear();
	}

	/** Cheap connectivity probe; throws ZoteroError with a helpful message when failing. */
	async ping(): Promise<void> {
		await jsonGet(this.baseUrl, "/api/itemTypes?locale=en-US", this.rawGet);
	}

	private memo<T>(path: string): Promise<T> {
		let p = this.cache.get(path);
		if (!p) {
			p = jsonGet(this.baseUrl, path, this.rawGet).then((data) => data as T);
			// drop failed promises so a later retry can succeed
			p.catch(() => this.cache.delete(path));
			this.cache.set(path, p);
		}
		return p as Promise<T>;
	}

	/** Every collection in the user library. */
	collections(): Promise<ZoteroCollection[]> {
		return this.memo<ZoteroCollection[]>("/api/users/0/collections?format=json");
	}

	/** All top-level items (papers and unattached items) in the user library. */
	topItems(): Promise<ZoteroItem[]> {
		return this.memo<ZoteroItem[]>("/api/users/0/items/top?format=json");
	}

	/** All attachment items in the library (children included). */
	attachments(): Promise<ZoteroItem[]> {
		return this.memo<ZoteroItem[]>("/api/users/0/items?itemType=attachment&format=json");
	}

	/** All annotation items in the library. */
	annotations(): Promise<ZoteroItem[]> {
		return this.memo<ZoteroItem[]>("/api/users/0/items?itemType=annotation&format=json");
	}

	/** Top-level items that belong to one collection (direct members only). */
	collectionItems(collectionKey: string): Promise<ZoteroItem[]> {
		return this.memo<ZoteroItem[]>(
			`/api/users/0/collections/${encodeURIComponent(collectionKey)}/items/top?format=json`
		);
	}

	/** Items by their 8-character keys (the Local API accepts up to 50 per call). */
	async itemsByKey(keys: string[]): Promise<ZoteroItem[]> {
		const out: ZoteroItem[] = [];
		const chunks: string[][] = [];
		for (let i = 0; i < keys.length; i += 50) chunks.push(keys.slice(i, i + 50));
		for (const chunk of chunks) {
			const joined = chunk.join(",");
			const items = await this.memo<ZoteroItem[]>(
				`/api/users/0/items?itemKey=${encodeURIComponent(joined)}&format=json`
			);
			out.push(...items);
		}
		return out;
	}
}
