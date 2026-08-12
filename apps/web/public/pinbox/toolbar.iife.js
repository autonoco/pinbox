var Pinbox = (function(exports) {
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	//#region src/targeting/dom.ts
	/**
	* Deepest element under (clientX, clientY) that the caller does not ignore, or null when there is
	* nothing there but page chrome (html/body).
	*
	* Looks THROUGH our own overlay rather than giving up at it. The single-element form could not:
	* the drag-aim grip sits exactly on the point being aimed at, so it is always the topmost thing
	* under the crosshair, and every probe came back "nothing" the moment touch aiming existed.
	*/
	function hitTest(doc, x, y, ignore) {
		const stack = doc.elementsFromPoint?.(x, y) ?? [doc.elementFromPoint(x, y)];
		for (const el of stack) {
			if (!el || el === doc.body || el === doc.documentElement) return null;
			if (!ignore(el)) return el;
		}
		return null;
	}
	/** CLASS-or-TAG display name with a sibling index when needed (prototype nodeName). */
	function nodeName(el) {
		const key = el.classList[0];
		let name = (key ?? el.tagName).toUpperCase();
		const parent = el.parentElement;
		if (parent) {
			const sibs = [...parent.children].filter((c) => c.classList[0] === key && c.tagName === el.tagName);
			if (sibs.length > 1) name += ` ${sibs.indexOf(el) + 1}`;
		}
		return name;
	}
	/**
	* Human label for a target: an explicit data-pb-el annotation wins; otherwise a
	* CLASS/TAG ancestry chain of at most 3 parts joined with ›, terminating early
	* at the first annotated ancestor.
	*/
	function targetLabel(el) {
		const own = el.getAttribute("data-pb-el");
		if (own) return own;
		const parts = [nodeName(el)];
		const body = el.ownerDocument.body;
		let node = el.parentElement;
		while (node && node !== body && parts.length < 3) {
			const anchor = node.getAttribute("data-pb-el");
			if (anchor) {
				parts.unshift(anchor);
				break;
			}
			if (node.classList[0]) parts.unshift(nodeName(node));
			node = node.parentElement;
		}
		return parts.join(" › ");
	}
	const SAFE_ID = /^[A-Za-z][\w-]*$/;
	/** Data attributes trusted as stable hooks, in priority order. */
	const STABLE_DATA_ATTRS = [
		"data-pb-anchor",
		"data-pb-el",
		"data-testid"
	];
	function attrSegment(el, doc) {
		for (const attr of STABLE_DATA_ATTRS) {
			const value = el.getAttribute(attr);
			if (value === null || value.includes("\"") || value.includes("\\")) continue;
			const selector = `${el.tagName.toLowerCase()}[${attr}="${value}"]`;
			if (doc.querySelectorAll(selector).length === 1) return selector;
		}
		return null;
	}
	function nthSegment(el) {
		const tag = el.tagName.toLowerCase();
		const parent = el.parentElement;
		if (!parent) return tag;
		const sameTag = [...parent.children].filter((c) => c.tagName === el.tagName);
		return sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})` : tag;
	}
	/**
	* Stable CSS path for an element: ids > stable data attributes > an
	* nth-of-type chain. Guaranteed round-trip: querySelector(buildSelector(el)) === el.
	*/
	function buildSelector(el) {
		const doc = el.ownerDocument;
		const segments = [];
		let node = el;
		while (node && node !== doc.documentElement) {
			const id = node.getAttribute("id");
			if (id && SAFE_ID.test(id) && doc.querySelectorAll(`#${id}`).length === 1) {
				segments.unshift(`#${id}`);
				return segments.join(" > ");
			}
			const byAttr = attrSegment(node, doc);
			if (byAttr) {
				segments.unshift(byAttr);
				return segments.join(" > ");
			}
			segments.unshift(nthSegment(node));
			node = node.parentElement;
		}
		return segments.join(" > ");
	}
	//#endregion
	//#region src/capture.ts
	/** Curated computed-style subset — enough to reconstruct layout intent, tiny on the wire. */
	const STYLE_KEYS = [
		"display",
		"position",
		"font-size",
		"color",
		"background-color",
		"margin",
		"padding",
		"overflow"
	];
	const NEARBY_TEXT_MAX = 160;
	function styleSubset(win, el) {
		let cs;
		try {
			cs = win.getComputedStyle(el);
		} catch {
			return;
		}
		const out = {};
		for (const key of STYLE_KEYS) {
			const value = cs.getPropertyValue(key);
			if (value !== "") out[key] = value;
		}
		return Object.keys(out).length > 0 ? out : void 0;
	}
	function ariaMap(el) {
		const out = {};
		for (const name of el.getAttributeNames()) if (name.startsWith("aria-")) out[name] = el.getAttribute(name) ?? "";
		return Object.keys(out).length > 0 ? out : void 0;
	}
	function nearbyText(el) {
		const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
		return text === "" ? void 0 : text.slice(0, NEARBY_TEXT_MAX);
	}
	/** The user's selection, only when it intersects the captured element. */
	function selectedText(win, el) {
		try {
			const sel = win.getSelection?.();
			if (!sel || sel.isCollapsed || sel.rangeCount === 0) return void 0;
			if (!sel.getRangeAt(0).intersectsNode(el)) return void 0;
			const text = sel.toString().trim();
			return text === "" ? void 0 : text;
		} catch {
			return;
		}
	}
	/** `fixed` detected via ancestry: any ancestor with computed position: fixed. */
	function isFixed(win, el) {
		for (let node = el; node !== null; node = node.parentElement) try {
			if (win.getComputedStyle(node).position === "fixed") return true;
		} catch {
			return false;
		}
		return false;
	}
	/** Beyond this an element is not a thing you pinned, it is a region. Too many to rewrite as a set. */
	const MAX_RUNS = 40;
	const MAX_RUN_LENGTH = 200;
	/** Text that is not content: a script body or a stylesheet is not something to rewrite. */
	const NON_CONTENT = /* @__PURE__ */ new Set([
		"SCRIPT",
		"STYLE",
		"NOSCRIPT",
		"TEMPLATE"
	]);
	/**
	* The element's text, split the way the browser stores it: one entry per run of characters.
	*
	* This walks TEXT NODES, not elements, and that distinction is the whole point — it makes no
	* assumption about how a site is built. A heading is one run. A nav bar is one per link. A
	* paragraph with a bold word in the middle is three, in reading order, including the halves either
	* side of the bold. An earlier version keyed off "elements with no element children", which
	* quietly lost the "Hello " in `<p>Hello <b>world</b></p>` — text a person can obviously see and
	* would obviously expect to be able to change.
	*
	* `nearbyText` runs them all together, which is fine to read and useless to edit: it cannot tell
	* an agent that "work approach people contact" is four separate places. This can.
	*/
	function textRuns(el) {
		const runs = [];
		const walk = (node) => {
			if (node.nodeType === 3) {
				const text = (node.nodeValue ?? "").trim();
				if (text.length > 0) runs.push(text.slice(0, MAX_RUN_LENGTH));
				return runs.length <= MAX_RUNS;
			}
			if (node.nodeType !== 1 || NON_CONTENT.has(node.tagName)) return true;
			for (const child of node.childNodes) if (!walk(child)) return false;
			return true;
		};
		if (!walk(el) || runs.length === 0) return void 0;
		return runs;
	}
	function buildContext(win, el) {
		const context = {};
		if (el.classList.length > 0) context.classes = [...el.classList];
		const styles = styleSubset(win, el);
		if (styles !== void 0) context.styles = styles;
		const aria = ariaMap(el);
		if (aria !== void 0) context.aria = aria;
		const nearby = nearbyText(el);
		if (nearby !== void 0) context.nearbyText = nearby;
		const selected = selectedText(win, el);
		if (selected !== void 0) context.selectedText = selected;
		const runs = textRuns(el);
		if (runs !== void 0) context.textRuns = runs;
		return Object.keys(context).length > 0 ? context : void 0;
	}
	/** Fills PinInput.target/env from a chosen element (shapes come from the pin schema). */
	function captureTarget(el, opts) {
		const win = el.ownerDocument.defaultView;
		const r = el.getBoundingClientRect();
		const target = {
			url: win.location.href,
			selector: buildSelector(el),
			tag: el.tagName.toLowerCase(),
			rect: {
				x: r.left + win.scrollX,
				y: r.top + win.scrollY,
				width: r.width,
				height: r.height
			},
			fixed: isFixed(win, el)
		};
		if (opts?.anchor !== void 0) target.anchor = opts.anchor;
		if (opts?.at !== void 0 && r.width > 0 && r.height > 0) {
			const fx = (opts.at.x - (r.left + win.scrollX)) / r.width;
			const fy = (opts.at.y - (r.top + win.scrollY)) / r.height;
			if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) target.spot = {
				x: fx,
				y: fy
			};
		}
		const context = buildContext(win, el);
		if (context !== void 0) target.context = context;
		return {
			target,
			env: {
				viewport: {
					w: win.innerWidth,
					h: win.innerHeight,
					dpr: win.devicePixelRatio
				},
				browser: win.navigator.userAgent,
				os: win.navigator.platform || "unknown",
				colorScheme: win.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
			}
		};
	}
	//#endregion
	//#region src/markdown.ts
	/** Squash any text to a single markdown-safe line. */
	function line(text) {
		return text.replace(/\s+/g, " ").trim();
	}
	function label(pin) {
		return pin.target?.anchor ?? pin.target?.tag?.toUpperCase() ?? "PIN";
	}
	function threadTail(thread) {
		if (thread.length === 0) return [];
		const tail = thread.slice(-3);
		const skipped = thread.length - tail.length;
		return [
			"",
			"Thread:",
			...skipped > 0 ? [`- … ${skipped} earlier message${skipped === 1 ? "" : "s"}`] : [],
			...tail.map((m) => `- ${m.role}: ${line(m.text)}`)
		];
	}
	function block(pin, thread) {
		const { selector, url, source } = pin.target ?? {};
		return [
			`## Pin ${pin.id} — OPEN`,
			`- label: ${line(label(pin))}`,
			...selector === void 0 ? [] : [`- selector: \`${line(selector)}\``],
			...source === void 0 ? [] : [`- source: ${line(source.line === void 0 ? source.file : `${source.file}:${source.line}`)}`],
			...url === void 0 ? [] : [`- url: ${line(url)}`],
			"",
			`> ${line(pin.text)}`,
			...threadTail(thread)
		].join("\n");
	}
	/** Serialize the open pins (resolved excluded) for pasting into any agent chat. */
	function pinsToMarkdown(pins, threads) {
		const open = pins.filter((p) => p.status === "open");
		if (open.length === 0) return "No open pins.\n";
		return `${open.map((p) => block(p, threads.get(p.id) ?? [])).join("\n\n")}\n`;
	}
	//#endregion
	//#region src/screenshot.ts
	const WEBP_QUALITY = .7;
	const PLACEHOLDER_MAX = 32;
	/** Element rect clamped to the viewport (CSS px); null when nothing is visible. */
	function visibleCropRect(el) {
		const win = el.ownerDocument.defaultView;
		if (!win) return null;
		const r = el.getBoundingClientRect();
		const x = Math.max(r.left, 0);
		const y = Math.max(r.top, 0);
		const right = Math.min(r.right, win.innerWidth);
		const bottom = Math.min(r.bottom, win.innerHeight);
		if (right - x < 1 || bottom - y < 1) return null;
		return {
			x,
			y,
			width: right - x,
			height: bottom - y
		};
	}
	function captureSource(el) {
		const win = el.ownerDocument.defaultView;
		if (!win) return null;
		const g = globalThis;
		if (typeof g.OffscreenCanvas !== "function" || typeof g.createImageBitmap !== "function") return null;
		const media = win.navigator?.mediaDevices;
		if (typeof media?.getDisplayMedia !== "function") return null;
		return {
			win,
			media
		};
	}
	/** Play the stream into an off-DOM video element and wait for the first frame. */
	async function firstFrame(win, stream) {
		const video = win.document.createElement("video");
		video.muted = true;
		video.srcObject = stream;
		await video.play();
		if (video.readyState < 2) await new Promise((resolve) => {
			video.addEventListener("loadeddata", () => resolve(), { once: true });
		});
		return video;
	}
	/** webp-encode a bitmap; also emit the ≤32px placeholder data URL. */
	async function encode(bmp) {
		const canvas = new OffscreenCanvas(bmp.width, bmp.height);
		canvas.getContext("2d")?.drawImage(bmp, 0, 0);
		const image = {
			blob: await canvas.convertToBlob({
				type: "image/webp",
				quality: WEBP_QUALITY
			}),
			width: bmp.width,
			height: bmp.height
		};
		const scale = PLACEHOLDER_MAX / Math.max(bmp.width, bmp.height);
		const tw = Math.max(1, Math.round(bmp.width * Math.min(scale, 1)));
		const th = Math.max(1, Math.round(bmp.height * Math.min(scale, 1)));
		const thumb = new OffscreenCanvas(tw, th);
		thumb.getContext("2d")?.drawImage(bmp, 0, 0, tw, th);
		image.placeholder = `data:image/webp;base64,${toBase64(await (await thumb.convertToBlob({
			type: "image/webp",
			quality: .5
		})).arrayBuffer())}`;
		return image;
	}
	function toBase64(buffer) {
		const bytes = new Uint8Array(buffer);
		let bin = "";
		for (const b of bytes) bin += String.fromCharCode(b);
		return btoa(bin);
	}
	/**
	* Best-effort capture of the element's visible viewport region. Resolves null
	* whenever the environment cannot capture (no OffscreenCanvas/createImageBitmap,
	* no getDisplayMedia, element off-screen, user denies the prompt) — never throws.
	*/
	async function captureElement(el) {
		const source = captureSource(el);
		const crop = visibleCropRect(el);
		if (source === null || crop === null) return null;
		const { win, media } = source;
		let stream = null;
		try {
			stream = await media.getDisplayMedia({
				video: true,
				audio: false,
				preferCurrentTab: true
			});
			const video = await firstFrame(win, stream);
			const sx = video.videoWidth / win.innerWidth;
			const sy = video.videoHeight / win.innerHeight;
			return await encode(await createImageBitmap(video, Math.round(crop.x * sx), Math.round(crop.y * sy), Math.max(1, Math.round(crop.width * sx)), Math.max(1, Math.round(crop.height * sy))));
		} catch {
			return null;
		} finally {
			if (stream) for (const track of stream.getTracks()) track.stop();
		}
	}
	/**
	* POST /attachments?kind=screenshot — raw webp body, bearer auth; unwraps the
	* hub envelope `{ok:true,data:{attachment}}` and surfaces its error envelope.
	*/
	async function uploadAttachment(endpoint, token, img) {
		const base = endpoint.replace(/\/+$/, "");
		const res = await fetch(`${base}/attachments?kind=screenshot`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": img.blob.type || "image/webp"
			},
			body: img.blob
		});
		const body = await res.json();
		if (!res.ok || body.ok !== true || body.data === void 0) {
			const e = body.error;
			throw new Error(e?.code !== void 0 ? `${e.code}: ${e.message ?? "attachment upload failed"}` : `attachment upload failed (HTTP ${res.status})`);
		}
		return body.data.attachment;
	}
	//#endregion
	//#region src/state.ts
	function initialState() {
		return {
			pins: [],
			threads: /* @__PURE__ */ new Map(),
			draft: null,
			mode: "idle",
			activePinId: null,
			inboxOpen: false,
			connection: "connecting",
			queuedIds: /* @__PURE__ */ new Set()
		};
	}
	function createStore() {
		let state = initialState();
		const subscribers = /* @__PURE__ */ new Set();
		function commit(next) {
			state = next;
			for (const fn of subscribers) fn(state);
		}
		return {
			get: () => state,
			subscribe(fn) {
				subscribers.add(fn);
				return () => subscribers.delete(fn);
			},
			update(patch) {
				commit({
					...state,
					...patch
				});
			},
			place(draft) {
				commit({
					...state,
					draft,
					mode: "idle",
					activePinId: null
				});
			},
			discardDraft() {
				commit({
					...state,
					draft: null
				});
			},
			commitDraft(pin) {
				const pins = state.pins.some((p) => p.id === pin.id) ? state.pins.map((p) => p.id === pin.id ? pin : p) : [...state.pins, pin];
				commit({
					...state,
					pins,
					draft: null,
					activePinId: pin.id
				});
			}
		};
	}
	/** Replace-by-id upsert; new pins append. */
	function upsertPin(store, pin) {
		const pins = store.get().pins;
		store.update({ pins: pins.some((p) => p.id === pin.id) ? pins.map((p) => p.id === pin.id ? pin : p) : [...pins, pin] });
	}
	/** Append to the pin's thread, deduping by message id (REST echo vs WS event). */
	function appendThreadMessage(store, message) {
		const state = store.get();
		const thread = state.threads.get(message.pinId) ?? [];
		if (thread.some((m) => m.id === message.id)) return;
		const threads = new Map(state.threads);
		threads.set(message.pinId, [...thread, message]);
		store.update({ threads });
	}
	/**
	* Wire events mutate the store: pin.created upserts;
	* pin.resolved / pin.verified / pin.linked replace the payload Pin;
	* thread.message appends — payloads are the full post-mutation objects.
	*/
	function applyHubEvent(store, event) {
		if (event.eventType === "thread.message") {
			appendThreadMessage(store, event.payload);
			return;
		}
		const pin = event.payload;
		if (typeof pin?.id !== "string") return;
		upsertPin(store, pin);
	}
	/**
	* Wire-status → UI-status mapping:
	* resolved + no verification ⇒ "verify" (accept/reopen prompt);
	* resolved + verification ⇒ "resolved";
	* open + empty thread or last message human ⇒ "waiting";
	* open + last message agent|mirror ⇒ "replied".
	* The prototype's WORKING/APPLIED chips need an event vocabulary the hub does not emit — excluded here.
	*/
	function deriveUiStatus(pin, thread) {
		if (pin.status === "resolved") return pin.verification ? "resolved" : "verify";
		const last = thread[thread.length - 1];
		if (!last || last.role === "human") return "waiting";
		return "replied";
	}
	//#endregion
	//#region src/transport/mirror.ts
	function randomBase36(length) {
		let out = "";
		while (out.length < length) out += Math.random().toString(36).slice(2);
		return out.slice(0, length);
	}
	/** In-memory fallback when no Web Storage exists (SSR import, tests). */
	function memoryStorage() {
		const map = /* @__PURE__ */ new Map();
		return {
			getItem: (k) => map.get(k) ?? null,
			setItem: (k, v) => void map.set(k, v),
			removeItem: (k) => void map.delete(k)
		};
	}
	var Mirror = class {
		#storage;
		#prefix;
		constructor(storage, endpoint) {
			this.#storage = storage;
			this.#prefix = `pinbox:${endpoint.replace(/\/+$/, "")}`;
		}
		#key(name) {
			return `${this.#prefix}:${name}`;
		}
		#readRaw(name) {
			try {
				return this.#storage.getItem(this.#key(name));
			} catch {
				return null;
			}
		}
		#read(name, fallback) {
			try {
				const raw = this.#readRaw(name);
				return raw === null ? fallback : JSON.parse(raw);
			} catch {
				return fallback;
			}
		}
		#write(name, value) {
			try {
				this.#storage.setItem(this.#key(name), value);
			} catch {}
		}
		consumerId() {
			const id = this.#readRaw("consumer");
			if (id !== null && id !== "") return id;
			const fresh = randomBase36(10);
			this.#write("consumer", fresh);
			return fresh;
		}
		cursor() {
			const n = Number(this.#readRaw("cursor"));
			return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
		}
		writeCursor(seq) {
			this.#write("cursor", String(seq));
		}
		pins() {
			return this.#read("pins", []);
		}
		writePins(pins) {
			this.#write("pins", JSON.stringify(pins));
		}
		/** Threads keyed by pin id — the offline read-only thread render (plan: "mirror
		* renders read-only threads"). Only pins whose thread was fetched appear. */
		threads() {
			return this.#read("threads", {});
		}
		/** `null` distinguishes "never mirrored" from "mirrored and empty". */
		thread(pinId) {
			return this.threads()[pinId] ?? null;
		}
		writeThread(pinId, messages) {
			this.#write("threads", JSON.stringify({
				...this.threads(),
				[pinId]: messages
			}));
		}
		/** No-op for an unmirrored pin: a lone reply is not a thread. */
		appendThread(pinId, message) {
			const existing = this.thread(pinId);
			if (existing === null) return;
			this.writeThread(pinId, [...existing, message]);
		}
		outbox() {
			return this.#read("outbox", []);
		}
		writeOutbox(entries) {
			if (entries.length === 0) {
				try {
					this.#storage.removeItem(this.#key("outbox"));
				} catch {}
				return;
			}
			this.#write("outbox", JSON.stringify(entries));
		}
		pushOutbox(entry) {
			this.writeOutbox([...this.outbox(), entry]);
		}
	};
	//#endregion
	//#region src/transport/rest.ts
	var HubError = class extends Error {
		code;
		status;
		hint;
		constructor(code, message, status, hint) {
			super(message);
			this.name = "HubError";
			this.code = code;
			this.status = status;
			this.hint = hint;
		}
	};
	/** Unwrap {ok:true,data} or throw the envelope's error as a HubError. */
	async function decodeEnvelope(res) {
		let envelope;
		try {
			envelope = await res.json();
		} catch {
			throw new HubError("E_HUB_UNREACHABLE", `hub returned non-JSON (HTTP ${res.status})`, res.status);
		}
		if (res.ok && envelope.ok === true) return envelope.data;
		const e = envelope.error;
		throw new HubError(e?.code ?? "E_INTERNAL", e?.message ?? `hub error (HTTP ${res.status})`, res.status, e?.hint);
	}
	var RestClient = class {
		#base;
		#token;
		#fetch;
		constructor(endpoint, token, fetchFn) {
			this.#base = endpoint.replace(/\/+$/, "");
			this.#token = token;
			this.#fetch = fetchFn ?? ((input, init) => fetch(input, init));
		}
		async #request(method, path, body) {
			let res;
			try {
				res = await this.#fetch(`${this.#base}${path}`, {
					method,
					headers: {
						authorization: `Bearer ${this.#token}`,
						...body === void 0 ? {} : { "content-type": "application/json" }
					},
					...body === void 0 ? {} : { body: JSON.stringify(body) }
				});
			} catch (cause) {
				throw new HubError("E_HUB_UNREACHABLE", `hub unreachable: ${cause instanceof Error ? cause.message : "network failure"}`, 0);
			}
			return decodeEnvelope(res);
		}
		listPins() {
			return this.#request("GET", "/pins");
		}
		createPin(input) {
			return this.#request("POST", "/pins", input);
		}
		getThread(pinId) {
			return this.#request("GET", `/pins/${pinId}/thread`);
		}
		reply(pinId, text, attachments) {
			return this.#request("POST", `/pins/${pinId}/thread`, {
				role: "human",
				text,
				...attachments === void 0 ? {} : { attachments }
			});
		}
		resolve(pinId, note) {
			return this.#request("POST", `/pins/${pinId}/resolve`, {
				by: "human",
				...note === void 0 ? {} : { note }
			});
		}
		verify(pinId, outcome) {
			return this.#request("POST", `/pins/${pinId}/verify`, { outcome });
		}
	};
	//#endregion
	//#region src/transport.ts
	const WS_PATH = "/ws";
	const WS_PROTOCOL_VERSION = 1;
	const WS_MIN_PROTOCOL = 1;
	const WS_TOKEN_SUBPROTOCOL_PREFIX = "pinbox.token.";
	const WS_CLOSE_PROTOCOL = 4400;
	const BACKOFF_BASE_MS = 1e3;
	const BACKOFF_MAX_MS = 3e4;
	/** How many times a reconcile re-reads the pin list before conceding to live events. */
	const SNAPSHOT_ATTEMPTS = 3;
	/** `/ws` UNDER the endpoint, not at the origin root: a cloud hub is commonly
	* mounted at a path prefix (`https://hub/tenant/abc`), and resolving "/ws" against
	* it would silently drop the prefix. Query/hash never belong on the socket url. */
	function wsUrl(endpoint) {
		const url = new URL(endpoint);
		url.pathname = `${url.pathname.replace(/\/+$/, "")}${WS_PATH}`;
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.search = "";
		url.hash = "";
		return url.toString();
	}
	/** Handshake rule 1: either side of the version window excludes the peer. */
	function incompatibleWith(frame) {
		return (frame.minProtocol ?? 1) > WS_PROTOCOL_VERSION || (frame.protocol ?? 1) < WS_MIN_PROTOCOL;
	}
	/** The optimistic pin a queued outbox entry stands for until the flush replaces it. */
	function outboxPin(entry) {
		return {
			...entry.input,
			id: entry.localId,
			schemaVersion: 1,
			status: "open",
			createdAt: entry.at ?? (/* @__PURE__ */ new Date()).toISOString()
		};
	}
	var HubTransport = class {
		/** Stable per install, persisted (`pinbox:<endpoint>:consumer`). */
		consumerId;
		#opts;
		#mirror;
		#rest;
		#scheduler;
		#ws = null;
		#cursor;
		/** Live frames arriving in the accept→catch-up window, drained after catch-up. */
		#buffer = [];
		#caughtUp = false;
		#live = false;
		#closed = false;
		#incompatible = false;
		#attempt = 0;
		#timer = null;
		/** One flush at a time — reconnect and the live write path both drain the outbox. */
		#flushing = false;
		constructor(opts) {
			this.#opts = opts;
			const storage = opts.storage ?? globalThis.localStorage ?? memoryStorage();
			this.#mirror = new Mirror(storage, opts.endpoint);
			this.#rest = new RestClient(opts.endpoint, opts.token, opts.fetchFn);
			this.#scheduler = opts.scheduler ?? {
				setTimeout: (fn, ms) => setTimeout(fn, ms),
				clearTimeout: (id) => clearTimeout(id)
			};
			this.consumerId = this.#mirror.consumerId();
			this.#cursor = this.#mirror.cursor();
		}
		/** Last-known pin list — the offline read-only render seed. */
		mirrorPins() {
			return this.#mirror.pins();
		}
		/** Optimistic pins for the queued outbox — offline reloads render + flag them. */
		outboxPins() {
			return this.#mirror.outbox().map(outboxPin);
		}
		/** Last-known thread for a pin — the offline read-only thread render seed.
		* Empty for a pin whose thread was never fetched while connected. */
		mirrorThread(pinId) {
			return this.#mirror.thread(pinId) ?? [];
		}
		/** hello → buffer live frames → apply catch-up → drain buffer. */
		connect() {
			if (this.#closed || this.#incompatible || this.#ws !== null) return;
			this.#opts.onConnection("connecting");
			this.#caughtUp = false;
			this.#buffer = [];
			const ws = (this.#opts.webSocket ?? ((url, protocols) => new WebSocket(url, protocols)))(wsUrl(this.#opts.endpoint), [WS_TOKEN_SUBPROTOCOL_PREFIX + this.#opts.token]);
			this.#ws = ws;
			ws.onopen = () => ws.send(JSON.stringify({
				type: "hello",
				protocol: WS_PROTOCOL_VERSION,
				consumerId: this.consumerId,
				lastSeq: this.#cursor
			}));
			ws.onmessage = (ev) => this.#onFrame(ev.data);
			ws.onclose = (ev) => this.#onDown(ws, ev.code);
			ws.onerror = () => this.#onDown(ws);
		}
		close() {
			this.#closed = true;
			if (this.#timer !== null) {
				this.#scheduler.clearTimeout(this.#timer);
				this.#timer = null;
			}
			const ws = this.#ws;
			this.#ws = null;
			this.#live = false;
			ws?.close(1e3, "client closed");
		}
		listPins() {
			return this.#rest.listPins();
		}
		/** Offline ⇒ queued in the outbox, optimistic local pin (client wins on new pins). */
		async createPin(input) {
			if (this.#live) try {
				return await this.#afterWrite(this.#rest.createPin(input));
			} catch (err) {
				if (!(err instanceof HubError) || err.code !== "E_HUB_UNREACHABLE") throw err;
			}
			const entry = {
				localId: `pin_${randomBase36(10)}`,
				input,
				at: (/* @__PURE__ */ new Date()).toISOString()
			};
			this.#mirror.pushOutbox(entry);
			this.#emitOutbox();
			return outboxPin(entry);
		}
		/** Mirrored on every success, served from the mirror when the hub is unreachable —
		* an offline reload renders read-only threads instead of empty ones. Any other
		* hub error (auth, not-found) surfaces: the mirror is a fallback, not a mask. */
		async getThread(pinId) {
			try {
				const messages = await this.#rest.getThread(pinId);
				this.#mirror.writeThread(pinId, messages);
				return messages;
			} catch (err) {
				if (!(err instanceof HubError) || err.code !== "E_HUB_UNREACHABLE") throw err;
				const mirrored = this.#mirror.thread(pinId);
				if (mirrored === null) throw err;
				return mirrored;
			}
		}
		async reply(pinId, text, attachments) {
			const message = await this.#afterWrite(this.#rest.reply(pinId, text, attachments));
			this.#mirror.appendThread(pinId, message);
			return message;
		}
		resolve(pinId, note) {
			return this.#afterWrite(this.#rest.resolve(pinId, note));
		}
		verify(pinId, outcome) {
			return this.#afterWrite(this.#rest.verify(pinId, outcome));
		}
		/** A write the hub accepted proves it is reachable, so anything the socket-still-up
		* failure path queued can go now — `#reconcile` only runs on reconnect, and while
		* the socket stays healthy that reconnect may never come. */
		async #afterWrite(op) {
			const result = await op;
			await this.#drainOutbox();
			return result;
		}
		async #drainOutbox() {
			if (this.#mirror.outbox().length === 0) return;
			try {
				const flushed = await this.#flushOutbox();
				if (flushed.length === 0) return;
				const all = [...this.#mirror.pins(), ...flushed];
				this.#opts.onPins?.(all);
				this.#mirror.writePins(all);
			} catch {}
		}
		#onFrame(data) {
			let frame;
			try {
				frame = JSON.parse(data);
			} catch {
				return;
			}
			if (frame.type === "event") this.#onEventFrame(frame);
			else if (frame.type === "catch-up") this.#onCatchUp(frame);
		}
		#toEvent(frame) {
			return {
				seq: frame.seq ?? 0,
				eventType: frame.eventType ?? "",
				at: frame.at ?? "",
				payload: frame.payload
			};
		}
		#onEventFrame(frame) {
			const event = this.#toEvent(frame);
			if (!this.#caughtUp) {
				this.#buffer.push(event);
				return;
			}
			this.#apply(event);
		}
		/** Deliver once, monotonically: seq at or below the cursor is already seen. */
		#apply(event) {
			if (event.seq <= this.#cursor) return;
			this.#opts.onEvent(event);
			this.#cursor = event.seq;
			this.#mirror.writeCursor(this.#cursor);
		}
		/** The client symmetrically closes on an excluding protocol window — a clear
		* upgrade message, never silent misbehavior. */
		#failIncompatible() {
			this.#incompatible = true;
			const ws = this.#ws;
			this.#ws = null;
			ws?.close(WS_CLOSE_PROTOCOL, "protocol version incompatible");
			this.#opts.onConnection("incompatible");
		}
		#onCatchUp(frame) {
			if (incompatibleWith(frame)) {
				this.#failIncompatible();
				return;
			}
			for (const e of frame.events ?? []) this.#apply(this.#toEvent(e));
			if ((frame.lastSeq ?? 0) > this.#cursor) {
				this.#cursor = frame.lastSeq ?? 0;
				this.#mirror.writeCursor(this.#cursor);
			}
			this.#caughtUp = true;
			const buffered = this.#buffer;
			this.#buffer = [];
			for (const e of buffered) this.#apply(e);
			this.#live = true;
			this.#attempt = 0;
			this.#opts.onConnection("live");
			this.#reconcile();
		}
		#onDown(ws, code) {
			if (this.#ws !== ws) return;
			this.#ws = null;
			this.#live = false;
			this.#caughtUp = false;
			if (this.#closed || this.#incompatible) return;
			if (code === WS_CLOSE_PROTOCOL) {
				this.#incompatible = true;
				this.#opts.onConnection("incompatible");
				return;
			}
			this.#opts.onConnection("offline");
			this.#scheduleReconnect();
		}
		/** Exponential backoff 1s→30s with jitter, resetting on a healthy connection. */
		#scheduleReconnect() {
			if (this.#timer !== null) return;
			const base = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);
			const delay = Math.min(Math.round(base * (1 + Math.random() * .25)), BACKOFF_MAX_MS);
			this.#attempt += 1;
			this.#timer = this.#scheduler.setTimeout(() => {
				this.#timer = null;
				this.connect();
			}, delay);
		}
		/** Refresh listPins (hub wins on status) → flush the outbox (client wins on new pins) → persist the fresh mirror. */
		async #reconcile() {
			try {
				const pins = await this.#snapshotPins();
				if (pins !== null) this.#opts.onPins?.(pins);
				const flushed = await this.#flushOutbox();
				if (flushed.length === 0) {
					if (pins !== null) this.#mirror.writePins(pins);
					return;
				}
				const all = [...pins ?? this.#mirror.pins(), ...flushed];
				this.#opts.onPins?.(all);
				this.#mirror.writePins(all);
			} catch {}
		}
		/** `onPins` is a wholesale replacement, so a snapshot must not be older than the
		* events already applied: a `pin.resolved` landing mid-GET would be overwritten by
		* the staler list, and the advanced cursor would stop it ever reapplying. Re-read
		* at the new cursor instead; if live events keep overtaking it, concede — they are
		* the newer truth, and the UI already has them. */
		async #snapshotPins() {
			for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
				const takenAt = this.#cursor;
				const pins = await this.#rest.listPins();
				if (this.#cursor === takenAt) return pins;
			}
			return null;
		}
		async #flushOutbox() {
			if (this.#flushing) return [];
			this.#flushing = true;
			const created = [];
			try {
				let remaining = this.#mirror.outbox();
				for (const entry of [...remaining]) {
					created.push(await this.#rest.createPin(entry.input));
					remaining = remaining.filter((e) => e.localId !== entry.localId);
					this.#mirror.writeOutbox(remaining);
					this.#emitOutbox();
				}
			} finally {
				this.#flushing = false;
			}
			return created;
		}
		#emitOutbox() {
			this.#opts.onOutbox?.(this.#mirror.outbox().map((e) => e.localId));
		}
	};
	//#endregion
	//#region src/ui/aim.ts
	/**
	* True when aiming has to be done by dragging rather than by pointing.
	*
	* Two independent reasons, either of which is sufficient. A coarse pointer means there is no
	* hover to follow at all — the mouse crosshair cannot work, whatever the screen size. The width
	* check is the design's own rule (720px) and catches the case a media query cannot: a device that
	* reports a fine pointer but is being used at phone width.
	*/
	function needsDragAim(win) {
		return win.matchMedia?.("(pointer: coarse)").matches === true || win.innerWidth < 720;
	}
	/**
	* Where the reticle starts.
	*
	* Slightly above centre: the confirm bar owns the bottom of the screen, and a reticle that opens
	* underneath your own thumb is one you have to move before you can even see it.
	*/
	function startPoint(win) {
		return {
			x: win.innerWidth / 2,
			y: win.innerHeight * .42
		};
	}
	const MARKUP = "<div class=\"h\"></div><div class=\"v\"></div><div class=\"grip\" aria-label=\"Pin position — arrow keys to aim\" tabindex=\"0\"><i></i></div><div class=\"bar\"><span class=\"lab\" role=\"status\" aria-live=\"polite\"></span><button type=\"button\" class=\"cancel\" data-aim=\"cancel\">CANCEL</button><button type=\"button\" class=\"ok\" data-aim=\"confirm\">PIN IT HERE</button></div>";
	function createAim(doc, handlers) {
		const win = doc.defaultView;
		const root = doc.createElement("div");
		root.className = "pb-aim";
		root.innerHTML = MARKUP;
		const h = root.querySelector(".h");
		const v = root.querySelector(".v");
		const grip = root.querySelector(".grip");
		const label = root.querySelector(".lab");
		const point = {
			x: 0,
			y: 0
		};
		/** Grab offset, so the reticle does not jump to your fingertip when you take hold of it. */
		let grab = null;
		function put(x, y) {
			point.x = Math.max(0, Math.min(win.innerWidth, x));
			point.y = Math.max(0, Math.min(win.innerHeight, y));
			h.style.top = `${point.y}px`;
			v.style.left = `${point.x}px`;
			grip.style.left = `${point.x}px`;
			grip.style.top = `${point.y}px`;
		}
		const onPointerMove = (e) => {
			if (grab === null) return;
			e.preventDefault();
			put(e.clientX + grab.dx, e.clientY + grab.dy);
			handlers.onAim(point.x, point.y);
		};
		const onPointerUp = () => {
			grab = null;
		};
		grip.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			grab = {
				dx: point.x - e.clientX,
				dy: point.y - e.clientY
			};
			grip.setPointerCapture?.(e.pointerId);
		});
		grip.addEventListener("keydown", (e) => {
			const step = e.shiftKey ? 20 : 2;
			const delta = {
				ArrowLeft: [-step, 0],
				ArrowRight: [step, 0],
				ArrowUp: [0, -step],
				ArrowDown: [0, step]
			}[e.key];
			if (!delta) return;
			e.preventDefault();
			put(point.x + delta[0], point.y + delta[1]);
			handlers.onAim(point.x, point.y);
		});
		root.addEventListener("click", (e) => {
			const action = e.target.closest?.("[data-aim]")?.getAttribute("data-aim");
			if (!action) return;
			e.preventDefault();
			e.stopPropagation();
			if (action === "confirm") handlers.onConfirm();
			else handlers.onCancel();
		});
		win.addEventListener("pointermove", onPointerMove, { passive: false });
		win.addEventListener("pointerup", onPointerUp);
		win.addEventListener("pointercancel", onPointerUp);
		return {
			root,
			point,
			show(x, y) {
				put(x, y);
				root.classList.add("on");
			},
			hide() {
				grab = null;
				root.classList.remove("on");
			},
			setLabel(text) {
				label.textContent = text;
			},
			destroy() {
				win.removeEventListener("pointermove", onPointerMove);
				win.removeEventListener("pointerup", onPointerUp);
				win.removeEventListener("pointercancel", onPointerUp);
			}
		};
	}
	//#endregion
	//#region src/ui/bar.ts
	const PIN_ICON = "<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.4\"><rect x=\"3\" y=\"1.5\" width=\"10\" height=\"6.5\" rx=\"1\"/><path d=\"M8 8v6.5\"/></svg>";
	const INBOX_ICON = "<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.4\"><path d=\"M1.8 8.5h3.4l1 2h3.6l1-2h3.4\"/><path d=\"M2.6 3.2h10.8l1.2 5.3v4a1 1 0 01-1 1H2.4a1 1 0 01-1-1v-4z\"/></svg>";
	const THEME_ICON = "<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.4\"><path d=\"M8 1.6a6.4 6.4 0 100 12.8A5 5 0 018 1.6z\"/></svg>";
	const COPY_ICON = "<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.4\"><rect x=\"5.5\" y=\"5.5\" width=\"8\" height=\"8\" rx=\"1\"/><path d=\"M10.5 3.5v-1a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h1\"/></svg>";
	const IDENT_ICON = "<svg width=\"15\" height=\"15\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"var(--pb-amber)\" stroke-width=\"1.4\"><rect x=\"2.5\" y=\"1.5\" width=\"11\" height=\"7\" rx=\"1\"/><path d=\"M8 8.5v6\"/><circle cx=\"8\" cy=\"14.6\" r=\".9\" fill=\"var(--pb-amber)\" stroke=\"none\"/></svg>";
	const CONNECTION_LABEL = {
		connecting: "PINBOX",
		live: "PINBOX",
		offline: "PINBOX · OFFLINE",
		incompatible: "PINBOX · UPDATE NEEDED"
	};
	function createBar(doc, on) {
		const root = doc.createElement("div");
		root.className = "pb-bar";
		root.innerHTML = `<div class="armed-ring"></div><div class="ident">${IDENT_ICON}<span class="bl" data-ref="label">PINBOX</span></div><div class="div"></div><button type="button" class="pb-tb" data-ref="pin" title="Pin (P)">${PIN_ICON}PIN</button><button type="button" class="pb-tb" data-ref="inbox" title="Inbox (I)">${INBOX_ICON}<span data-ref="count">0</span></button><div class="div" style="margin:0 3px"></div><button type="button" class="pb-tb sq" data-ref="copy" title="Copy open pins (C)">${COPY_ICON}</button><button type="button" class="pb-tb sq" data-ref="theme" title="Theme (D)">${THEME_ICON}</button><button type="button" class="pb-tb sq" data-ref="help" title="Shortcuts (?)">?</button>`;
		const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
		const label = ref("label");
		const pinBtn = ref("pin");
		const inboxBtn = ref("inbox");
		const count = ref("count");
		pinBtn.addEventListener("click", on.onPin);
		inboxBtn.addEventListener("click", on.onInbox);
		ref("copy").addEventListener("click", on.onCopy);
		ref("theme").addEventListener("click", on.onTheme);
		ref("help").addEventListener("click", on.onHelp);
		return {
			root,
			update(state) {
				const text = state.mode === "placing" ? "CLICK TO PIN" : CONNECTION_LABEL[state.connection];
				if (label.textContent !== text) label.textContent = text;
				pinBtn.classList.toggle("hot", state.mode === "placing");
				inboxBtn.classList.toggle("lit", state.inboxOpen);
				const open = String(state.pins.filter((p) => p.status !== "resolved").length);
				if (count.textContent !== open) count.textContent = open;
			}
		};
	}
	//#endregion
	//#region src/ui/html.ts
	const ESCAPES = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		"\"": "&quot;"
	};
	/** Escape text for safe inclusion in innerHTML strings. */
	function esc(value) {
		return String(value ?? "").replace(/[&<>"]/g, (m) => ESCAPES[m]);
	}
	/**
	* Allowlist a URL for use in href/src attributes. `esc()` alone is NOT enough for URL
	* attributes: `javascript:alert(1)` contains no `&<>"` characters, so it survives HTML
	* escaping intact — and link/attachment URLs are hub data that connectors (and, in cloud,
	* other users) populate. Relative URLs and http(s) pass; every other scheme yields "".
	*/
	function safeUrl(value) {
		const raw = String(value ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim();
		if (raw === "") return "";
		const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
		if (scheme !== null && !/^https?$/i.test(scheme[1])) return "";
		return raw;
	}
	/** Two-digit pin number, prototype-style: 1 → "01". */
	function pinNumber(n) {
		return String(n).padStart(2, "0");
	}
	//#endregion
	//#region src/ui/card.ts
	const STATUS_LABEL = {
		open: "OPEN",
		waiting: "OPEN",
		replied: "REPLIED",
		resolved: "RESOLVED",
		verify: "VERIFY"
	};
	const CHECK_ICON = "<svg width=\"13\" height=\"13\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M3 8.5l3.2 3.2L13 4.8\"/></svg>";
	const X_ICON$1 = "<svg width=\"13\" height=\"13\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M4 4l8 8M12 4l-8 8\"/></svg>";
	const ctxByCard = /* @__PURE__ */ new WeakMap();
	/** The prototype's `_h` innerHTML memo, kept off the DOM node. */
	const nodeMemo = /* @__PURE__ */ new WeakMap();
	function timeOf(at) {
		const d = new Date(at);
		if (Number.isNaN(d.getTime())) return "";
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}
	function isImage(att) {
		if (att.contentType?.startsWith("image/")) return true;
		return /\.(png|webp|jpe?g|gif)$/i.test(att.url ?? att.path ?? "");
	}
	function fileName(att) {
		const source = att.url ?? att.path ?? att.id;
		return source.split("/").pop() ?? source;
	}
	/** Thumbnail when the attachment is an image; the error listener degrades it to a chip. */
	function attachmentsHtml(m) {
		if (!m.attachments?.length) return "";
		return `<div class="atts">${m.attachments.map((att) => isImage(att) ? `<span class="pb-att"><img src="${esc(safeUrl(att.url ?? att.path ?? ""))}" alt="${esc(fileName(att))}" loading="lazy"></span>` : `<span class="pb-att-chip">${esc(fileName(att))}</span>`).join("")}</div>`;
	}
	function messageHtml(m) {
		if (m.role === "agent") return `<div class="pb-msg"><div class="pb-av agent">AI</div><div class="col"><div class="line"><span class="who">Agent</span><span class="tm">${esc(timeOf(m.at))}</span></div><div class="txt">${esc(m.text)}</div>${attachmentsHtml(m)}</div></div>`;
		const mirror = m.role === "mirror";
		const origin = mirror ? m.origin ?? "mirror" : null;
		const who = origin ? origin.split(":")[1] ?? origin : "You";
		const initials = who.slice(0, 2).toUpperCase();
		const via = origin ? `<span class="via-tag"><span>${esc(origin)}</span></span>` : "";
		return `<div class="pb-msg you"><div class="pb-av${mirror ? " via" : ""}">${esc(initials)}</div><div class="col"><div class="line"><span class="who">${esc(who)}</span><span class="tm">${esc(timeOf(m.at))}</span>${via}</div><div class="txt">${esc(m.text)}</div>${attachmentsHtml(m)}</div></div>`;
	}
	/** The agent has the message and has not answered yet. Its own node, so patching never rebuilds. */
	const TYPING_HTML = "<div class=\"pb-typing\"><div class=\"pb-av agent\">AI</div><div class=\"dots\"><i></i><i></i><i></i></div><div class=\"lbl\">THINKING</div></div>";
	/**
	* Show or hide the "working on it" row.
	*
	* Without it the card sits silent from the moment you comment until the answer lands, which reads
	* as nothing happening — the single most common report on the demo.
	*/
	function patchTyping(threadEl, pending) {
		const existing = threadEl.querySelector("[data-iid=\"pb-typing\"]");
		if (!pending) {
			existing?.remove();
			return;
		}
		if (existing) {
			threadEl.appendChild(existing);
			return;
		}
		const node = threadEl.ownerDocument.createElement("div");
		node.className = "pb-msg-w";
		node.setAttribute("data-iid", "pb-typing");
		node.innerHTML = TYPING_HTML;
		threadEl.appendChild(node);
		threadEl.scrollTop = threadEl.scrollHeight;
	}
	/** Keyed thread patching: appends/patches [data-iid] nodes only, never rebuilds. */
	function patchThread(threadEl, messages) {
		let appended = false;
		for (const m of messages) {
			let node = threadEl.querySelector(`[data-iid="${m.id}"]`);
			const html = messageHtml(m);
			if (!node) {
				node = threadEl.ownerDocument.createElement("div");
				node.className = "pb-msg-w";
				node.setAttribute("data-iid", m.id);
				node.innerHTML = html;
				nodeMemo.set(node, html);
				threadEl.appendChild(node);
				appended = true;
			} else if (nodeMemo.get(node) !== html) {
				node.innerHTML = html;
				nodeMemo.set(node, html);
			}
		}
		if (appended) threadEl.scrollTop = threadEl.scrollHeight;
	}
	function ensureShell(root) {
		let card = root.querySelector(".pb-card");
		if (!card) {
			card = root.ownerDocument.createElement("div");
			card.className = "pb-card";
			card.hidden = true;
			root.appendChild(card);
		}
		if (!ctxByCard.has(card)) {
			const ctx = {
				pid: null,
				parts: {},
				actions: null
			};
			ctxByCard.set(card, ctx);
			card.addEventListener("click", (e) => onCardClick(card, ctx, e));
		}
		return card;
	}
	function submit(card, ctx) {
		const ta = card.querySelector("textarea");
		const text = ta?.value.trim();
		if (!ta || !text || !ctx.pid) return;
		ctx.actions.send(ctx.pid === "draft" ? "draft" : ctx.pid, text);
		ta.value = "";
	}
	function onCardClick(card, ctx, e) {
		const action = e.target.closest?.("[data-action]")?.getAttribute("data-action");
		if (!action || !ctx.pid) return;
		if (action === "send") submit(card, ctx);
		else if (action === "close") ctx.actions.close();
		else if (ctx.pid !== "draft") {
			if (action === "resolve") ctx.actions.resolve(ctx.pid);
			else if (action === "verify-accept") ctx.actions.verify(ctx.pid, "accepted");
			else if (action === "verify-reopen") {
				ctx.actions.verify(ctx.pid, "reopened");
				card.querySelector("textarea")?.focus();
			}
		}
	}
	function buildSkeleton(card, ctx, isDraft, hasThread) {
		card.innerHTML = "<div class=\"in\"><div class=\"pb-hd\" data-ref=\"hd\"></div><div data-ref=\"link\"></div><div class=\"pb-thread\" data-ref=\"thread\"></div><div data-ref=\"verify\"></div><div class=\"pb-composer\"><textarea rows=\"2\"></textarea><div class=\"row\" data-ref=\"row\"></div></div></div>";
		const ta = card.querySelector("textarea");
		ta.placeholder = hasThread ? "Ask a question or request a change…" : "What should change here?";
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				submit(card, ctx);
			} else if (e.key === "Escape") ctx.actions.close();
		});
		card.querySelector("[data-ref=\"thread\"]")?.addEventListener("error", (e) => {
			const img = e.target;
			const wrap = img.tagName === "IMG" ? img.closest(".pb-att") : null;
			if (wrap) wrap.outerHTML = `<span class="pb-att-chip">${esc(img.getAttribute("alt") ?? "attachment")}</span>`;
		}, true);
		if (isDraft) ta.focus();
	}
	function hdHtml(n, targetLabel, status, resolvable) {
		return `<div class="meta"><span class="num">${pinNumber(n)}</span><span>${esc(targetLabel)}</span><span class="st">${esc(status)}</span></div><div style="display:flex;gap:2px">` + (resolvable ? `<button type="button" class="pb-ico ok" data-action="resolve" title="Resolve (R)">${CHECK_ICON}</button>` : "") + `<button type="button" class="pb-ico" data-action="close" title="Close (Esc)">${X_ICON$1}</button></div>`;
	}
	/** Link badge: pin.links[0] read-only — no picker, no unlink yet. */
	function linkHtml(pin) {
		const link = pin?.links?.[0];
		if (!link) return "";
		return `<div class="pb-linkbar"><span class="ch">${esc(link.connector)}</span><span class="mt">${esc(link.ref)}</span><span class="sp"></span><a class="pb-open" href="${esc(safeUrl(link.url))}" target="_blank" rel="noreferrer">OPEN</a></div>`;
	}
	function verifyHtml(status) {
		if (status !== "verify") return "";
		return "<div class=\"pb-verify\"><button type=\"button\" class=\"pb-bt-ok\" data-action=\"verify-accept\">Looks good</button><button type=\"button\" class=\"pb-bt-ghost\" data-action=\"verify-reopen\">Reopen</button></div>";
	}
	function rowHtml(hasThread) {
		return `<div class="pb-kbd">⌘ ↵</div><button type="button" class="pb-bt-solid" data-action="send">${hasThread ? "Reply" : "Comment"}</button>`;
	}
	/**
	* Viewport-aware placement, ported verbatim (prototype lines 660–668): measure
	* the rendered card, flip left when it would overflow right, clamp between
	* scrollY + margin and the command-bar clearance — never off-screen.
	*/
	function position(card, at) {
		const win = card.ownerDocument.defaultView;
		if (!win) return;
		const W = 344;
		const m = 12;
		const barClear = 84;
		let left = at.x + 22;
		if (left + W > win.scrollX + win.innerWidth - m) left = at.x - W - 22;
		left = Math.max(win.scrollX + m, left);
		const h = card.querySelector(".in")?.offsetHeight ?? 0;
		const minTop = win.scrollY + m;
		const maxTop = win.scrollY + win.innerHeight - h - barClear;
		card.style.left = `${left}px`;
		card.style.top = `${Math.max(minTop, Math.min(at.y - 60, maxTop))}px`;
	}
	function setPart(card, ctx, ref, html) {
		if (ctx.parts[ref] === html) return;
		const el = card.querySelector(`[data-ref="${ref}"]`);
		if (el) {
			el.innerHTML = html;
			ctx.parts[ref] = html;
		}
	}
	function activePin(state) {
		if (!state.activePinId) return null;
		return state.pins.find((p) => p.id === state.activePinId) ?? null;
	}
	/** Ordinal among visible pins (resolved pins hide unless active); drafts number last. */
	function ordinalOf(state, pin) {
		const visible = state.pins.filter((p) => p.status !== "resolved" || p.id === state.activePinId);
		return pin ? visible.indexOf(pin) + 1 : visible.length + 1;
	}
	function anchorOf(pin, draft) {
		const r = pin?.target?.rect;
		if (!r) return draft?.placedAt ?? {
			x: 0,
			y: 0
		};
		return {
			x: r.x + r.width / 2,
			y: r.y + r.height / 2
		};
	}
	/**
	* The card's heading. A terminal `pinbox pin` has no anchor and no tag, so "PIN"
	* labels the card without claiming an element that was never captured.
	*/
	function labelOf(target) {
		return target?.anchor ?? target?.tag?.toUpperCase() ?? "PIN";
	}
	function viewOf(state) {
		const pin = activePin(state);
		const pid = pin?.id ?? (state.draft ? "draft" : null);
		if (!pid) return null;
		const thread = pin ? state.threads.get(pin.id) ?? [] : [];
		return {
			pid,
			pin,
			thread,
			n: ordinalOf(state, pin),
			status: pin ? deriveUiStatus(pin, thread) : null,
			label: labelOf(pin?.target ?? state.draft?.target.target),
			at: anchorOf(pin, state.draft)
		};
	}
	/** Render the thread card for a state snapshot: the active pin, or the draft. */
	/**
	* The pin's own text, as the first message in its thread.
	*
	* A pin stores what you wrote on the pin itself, not in the thread — so a card that renders only
	* `thread` shows an empty box the moment you hit Comment, and your words look lost. They are not
	* lost; they were never drawn.
	*/
	function pinAsMessage(pin) {
		return {
			id: `pin:${pin.id}`,
			pinId: pin.id,
			role: "human",
			text: pin.text,
			at: pin.createdAt
		};
	}
	function renderCard(root, state, actions) {
		const card = ensureShell(root);
		const ctx = ctxByCard.get(card);
		ctx.actions = actions;
		const view = viewOf(state);
		if (!view) {
			card.hidden = true;
			ctx.pid = null;
			return;
		}
		if (ctx.pid !== view.pid) {
			ctx.pid = view.pid;
			ctx.parts = {};
			buildSkeleton(card, ctx, view.pid === "draft", view.pin !== null || view.thread.length > 0);
		}
		card.hidden = false;
		const queued = view.pin !== null && state.queuedIds.has(view.pin.id);
		const statusLabel = queued ? "QUEUED" : view.status ? STATUS_LABEL[view.status] : "NEW";
		const resolvable = view.pin?.status === "open" && !queued;
		setPart(card, ctx, "hd", hdHtml(view.n, view.label, statusLabel, resolvable));
		setPart(card, ctx, "link", linkHtml(view.pin));
		setPart(card, ctx, "verify", verifyHtml(view.status));
		const messages = view.pin === null ? view.thread : [pinAsMessage(view.pin), ...view.thread];
		setPart(card, ctx, "row", rowHtml(messages.length > 0));
		const threadEl = card.querySelector("[data-ref=\"thread\"]");
		if (threadEl) {
			patchThread(threadEl, messages);
			patchTyping(threadEl, !queued && view.pin?.status === "open" && view.status === "waiting");
		}
		position(card, view.at);
	}
	//#endregion
	//#region src/ui/drawer.ts
	const X_ICON = "<svg width=\"13\" height=\"13\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M4 4l8 8M12 4l-8 8\"/></svg>";
	const STATUS_TEXT = {
		open: "OPEN",
		waiting: "OPEN",
		replied: "REPLIED",
		resolved: "RESOLVED",
		verify: "VERIFY"
	};
	const STATUS_DOT = {
		open: "var(--pb-fg4)",
		waiting: "var(--pb-fg4)",
		replied: "var(--pb-info)",
		resolved: "var(--pb-ok)",
		verify: "var(--pb-amber)"
	};
	/**
	* The place a row names. A browser pin has a selector; a terminal `pinbox pin` has a
	* source anchor instead; a pin created with no anchor at all names nowhere.
	*/
	function locusOf(pin) {
		return pin.target?.selector ?? pin.target?.source?.file ?? "";
	}
	function itemHtml(pin, n, active, thread, queued) {
		const status = deriveUiStatus(pin, thread);
		const link = pin.links?.[0];
		return `<button type="button" class="pb-item${active ? " on" : ""}" data-item="${esc(pin.id)}"><span class="nn">${pinNumber(n)}</span><span class="cc"><span class="tt">${esc(pin.text)}</span><span class="mm"><span class="sdot" style="background:${queued ? "var(--pb-amber)" : STATUS_DOT[status]}"></span><span>${queued ? "QUEUED" : STATUS_TEXT[status]}</span>` + (link ? `<span class="lk">${esc(link.connector)}</span>` : "") + `<span>${esc(locusOf(pin))}</span></span></span></button>`;
	}
	function createDrawer(doc, on) {
		const root = doc.createElement("div");
		root.className = "pb-drawer";
		root.hidden = true;
		root.innerHTML = `<div class="dh"><span>INBOX</span><button type="button" class="pb-ico" data-ref="close" title="Close">${X_ICON}</button></div><div class="pb-tabs"><button type="button" class="pb-tab on" data-tab="open">OPEN · 0</button><button type="button" class="pb-tab" data-tab="resolved">RESOLVED · 0</button></div><div class="pb-items" data-ref="items"></div>`;
		let tab = "open";
		let last = null;
		let itemsMemo = "";
		const items = root.querySelector("[data-ref=\"items\"]");
		const tabButtons = [...root.querySelectorAll("[data-tab]")];
		root.querySelector("[data-ref=\"close\"]")?.addEventListener("click", on.onClose);
		for (const btn of tabButtons) btn.addEventListener("click", () => {
			tab = btn.getAttribute("data-tab");
			if (last) render(last);
		});
		items.addEventListener("click", (e) => {
			const id = e.target.closest?.("[data-item]")?.getAttribute("data-item");
			if (id) on.onActivate(id);
		});
		function render(state) {
			const open = state.pins.filter((p) => p.status === "open");
			const resolved = state.pins.filter((p) => p.status === "resolved");
			const [openTab, doneTab] = tabButtons;
			if (openTab) {
				openTab.textContent = `OPEN · ${open.length}`;
				openTab.classList.toggle("on", tab === "open");
			}
			if (doneTab) {
				doneTab.textContent = `RESOLVED · ${resolved.length}`;
				doneTab.classList.toggle("on", tab === "resolved");
			}
			const list = tab === "open" ? open : resolved;
			const html = list.length ? list.map((p) => itemHtml(p, state.pins.indexOf(p) + 1, p.id === state.activePinId, state.threads.get(p.id) ?? [], state.queuedIds.has(p.id))).join("") : "<div class=\"pb-empty\">Nothing here yet.</div>";
			if (itemsMemo !== html) {
				items.innerHTML = html;
				itemsMemo = html;
			}
		}
		/** Show immediately; hide only after the closing animation ends (prototype rule). */
		function setVisible(open) {
			if (open) {
				if (root.hidden || root.classList.contains("closing")) {
					root.classList.remove("closing");
					root.hidden = false;
				}
			} else if (!root.hidden && !root.classList.contains("closing")) {
				root.classList.add("closing");
				root.addEventListener("animationend", (ev) => {
					if (ev.target === root && root.classList.contains("closing")) {
						root.hidden = true;
						root.classList.remove("closing");
					}
				}, { once: true });
			}
		}
		return {
			root,
			update(state) {
				last = state;
				setVisible(state.inboxOpen);
				if (state.inboxOpen) render(state);
			}
		};
	}
	//#endregion
	//#region src/ui/pins.ts
	/** The prototype's `_h` innerHTML memo, kept off the DOM node. */
	const chipMemo = /* @__PURE__ */ new WeakMap();
	/**
	* Where the needle lands: the point inside the element that was actually clicked, when the pin
	* recorded one, else the centre of its box.
	*
	* `spot` is a fraction of the element, so the pin still tracks the element when it moves or
	* resizes — it just stops sliding to the middle of a wide block the moment you commit it.
	*/
	function pinPoint(r, spot) {
		const fx = spot?.x ?? .5;
		const fy = spot?.y ?? .5;
		return {
			x: r.x + r.width * fx,
			y: r.y + r.height * fy
		};
	}
	/** Chip contents (prototype chipBtnInner, lines 546–550): number + linked-channel tag,
	* plus the queued badge while the pin waits in the outbox for the reconnect flush. */
	function chipInner(n, pin, queued = false) {
		const link = pin?.links?.[0];
		const badge = link ? `<span class="lk"><span>${esc(link.connector)}</span></span>` : "";
		const qd = queued ? "<span class=\"qd\">QUEUED</span>" : "";
		return `<span>${pinNumber(n)}</span>${badge}${qd}`;
	}
	function ensureNode(layer, key, fresh) {
		let node = layer.querySelector(`[data-pin="${key}"]`);
		if (!node) {
			node = layer.ownerDocument.createElement("div");
			node.className = "pb-pin";
			node.setAttribute("data-pin", key);
			node.innerHTML = `${fresh ? "<div class=\"ring\"></div>" : ""}<div class="dot"></div><div class="needle"></div><button type="button" class="pb-chipBtn" data-open="${esc(key)}"></button>`;
			layer.appendChild(node);
		}
		return node;
	}
	function patchNode(node, at, hot, inner) {
		node.style.left = `${at.x}px`;
		node.style.top = `${at.y}px`;
		node.style.zIndex = hot ? "40" : "20";
		node.classList.toggle("hot", hot);
		const chip = node.querySelector(".pb-chipBtn");
		if (chip && chipMemo.get(chip) !== inner) {
			chip.innerHTML = inner;
			chipMemo.set(chip, inner);
		}
	}
	/**
	* Render the pin layer for a state snapshot. Visible pins are open pins, the
	* active pin regardless of status, and the client-only draft (key "draft").
	*/
	function renderPins(layer, state) {
		const visible = state.pins.filter((p) => p.status !== "resolved" || p.id === state.activePinId);
		const placed = [];
		visible.forEach((pin, i) => {
			const rect = pin.target?.rect;
			if (rect === void 0) return;
			const spot = pin.target?.spot;
			placed.push(spot === void 0 ? {
				pin,
				n: i + 1,
				rect
			} : {
				pin,
				n: i + 1,
				rect,
				spot
			});
		});
		const keys = new Set(placed.map((entry) => entry.pin.id));
		if (state.draft) keys.add("draft");
		for (const node of [...layer.children]) if (!keys.has(node.getAttribute("data-pin") ?? "")) node.remove();
		for (const { pin, n, rect, spot } of placed) {
			const node = ensureNode(layer, pin.id, false);
			const hot = pin.id === state.activePinId;
			const queued = state.queuedIds.has(pin.id);
			node.classList.toggle("queued", queued);
			patchNode(node, pinPoint(rect, spot), hot, chipInner(n, pin, queued));
		}
		if (state.draft) patchNode(ensureNode(layer, "draft", true), state.draft.placedAt, true, chipInner(visible.length + 1, null));
	}
	//#endregion
	//#region src/ui/reticle.ts
	function createReticle(doc) {
		const crosshair = doc.createElement("div");
		crosshair.className = "pb-reticle";
		crosshair.innerHTML = "<div class=\"h\"></div><div class=\"v\"></div><div class=\"box\"></div><div class=\"ro\"></div>";
		const h = crosshair.querySelector(".h");
		const v = crosshair.querySelector(".v");
		const box = crosshair.querySelector(".box");
		const readout = crosshair.querySelector(".ro");
		const outline = doc.createElement("div");
		outline.className = "pb-outline";
		outline.innerHTML = "<span class=\"lab\"></span>";
		const lab = outline.querySelector(".lab");
		function setOutlineRect(rect, scroll) {
			outline.style.left = `${rect.left + scroll.x - 5}px`;
			outline.style.top = `${rect.top + scroll.y - 5}px`;
			outline.style.width = `${rect.width + 10}px`;
			outline.style.height = `${rect.height + 10}px`;
		}
		return {
			crosshair,
			outline,
			move(pos) {
				h.style.top = `${pos.clientY}px`;
				v.style.left = `${pos.clientX}px`;
				box.style.left = `${pos.clientX}px`;
				box.style.top = `${pos.clientY}px`;
				readout.style.left = `${pos.clientX}px`;
				readout.style.top = `${pos.clientY}px`;
				readout.textContent = `${Math.round(pos.pageX)} × ${Math.round(pos.pageY)}`;
			},
			snap(rect, label, scroll) {
				if (!outline.classList.contains("on")) {
					outline.style.transition = "none";
					setOutlineRect(rect, scroll);
					outline.offsetWidth;
					outline.style.transition = "";
				} else setOutlineRect(rect, scroll);
				lab.textContent = label;
				outline.classList.add("on");
			},
			release() {
				outline.classList.remove("on");
			}
		};
	}
	//#endregion
	//#region src/ui/shortcuts.ts
	const ROWS = [
		["Drop a pin", "P"],
		["Open inbox", "I"],
		["Toggle theme", "D"],
		["Send comment", "⌘ ↵"],
		["Mark pin resolved", "R"],
		["Copy open pins", "C"],
		["Cancel", "ESC"]
	];
	function createShortcutsModal(doc, onClose) {
		const root = doc.createElement("div");
		root.className = "pb-modal";
		root.hidden = true;
		root.innerHTML = `<div class="mx"><div class="mh">SHORTCUTS</div><div style="padding:8px 20px 18px">${ROWS.map(([what, key]) => `<div class="mr"><span class="mw">${esc(what)}</span><span class="mk">${esc(key)}</span></div>`).join("")}</div></div>`;
		root.addEventListener("click", onClose);
		return {
			root,
			set(open) {
				root.hidden = !open;
			}
		};
	}
	//#endregion
	//#region src/ui/styles.ts
	/** Dark token block — also the :host default so the bare element renders sanely. */
	const DARK_TOKENS = `
  --pb-canvas:#0f0f0f; --pb-surface:#171717; --pb-elev:#1f1c1a; --pb-sunken:#0b0b0b;
  --pb-line:rgba(245,240,230,0.08); --pb-line-2:rgba(245,240,230,0.16);
  --pb-hover:rgba(245,240,230,0.06);
  --pb-fg1:#f5f0e6; --pb-fg2:#b8b0a5; --pb-fg3:#8a827a; --pb-fg4:#5a534d;
  --pb-bar:rgba(15,15,15,0.82);
  --pb-shadow:0 24px 64px rgba(0,0,0,0.6);
  --pb-scrim:rgba(7,7,7,0.62);
  --pb-amber:#d4a04a; --pb-amber-ink:#0f0f0f; --pb-amber-soft:rgba(212,160,74,0.14);
  --pb-ok:#7fb496; --pb-danger:#c46a5a; --pb-info:#8ea6b8;
  --pb-invert-bg:#f5f0e6; --pb-invert-fg:#0f0f0f;
`;
	/** Full shadow-root stylesheet for the toolbar element. */
	const TOOLBAR_CSS = `
:host { ${DARK_TOKENS}
  --pb-font-body: ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
  --pb-font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
  --pb-ease: cubic-bezier(0.22, 1, 0.36, 1);
  position: absolute; top: 0; left: 0; width: 100%; height: 0; z-index: 2147483000;
  color: var(--pb-fg1); font-family: var(--pb-font-body); -webkit-font-smoothing: antialiased;
}
:host([data-pb="dark"]) { ${DARK_TOKENS} }
:host([data-pb="light"]) { 
  --pb-canvas:#fbf8f2; --pb-surface:#ffffff; --pb-elev:#ffffff; --pb-sunken:#f2ede3;
  --pb-line:rgba(23,23,23,0.11); --pb-line-2:rgba(23,23,23,0.22);
  --pb-hover:rgba(23,23,23,0.05);
  --pb-fg1:#141414; --pb-fg2:#5a534d; --pb-fg3:#8a827a; --pb-fg4:#b8b0a5;
  --pb-bar:rgba(251,248,242,0.84);
  --pb-shadow:0 24px 64px rgba(58,54,51,0.16);
  --pb-scrim:rgba(58,54,51,0.36);
  --pb-amber:#b07d28; --pb-amber-ink:#fbf8f2; --pb-amber-soft:rgba(176,125,40,0.12);
  --pb-ok:#4e8368; --pb-danger:#a8503f; --pb-info:#5c7c94;
  --pb-invert-bg:#141414; --pb-invert-fg:#fbf8f2;
 }
*, *::before, *::after { box-sizing: border-box; margin: 0; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }

@keyframes pb-chip { 0% { opacity:0; transform:translateY(-14px) } 60% { opacity:1 } 100% { opacity:1; transform:translateY(0) } }
@keyframes pb-needle { from { transform:scaleY(0) } to { transform:scaleY(1) } }
@keyframes pb-ring { from { opacity:.6; transform:translate(-50%,-50%) scale(.25) } to { opacity:0; transform:translate(-50%,-50%) scale(3.2) } }
@keyframes pb-in { from { opacity:0; transform:translateY(7px) } to { opacity:1; transform:none } }
@keyframes pb-fade { from { opacity:0 } to { opacity:1 } }
@keyframes pb-drawer { from { transform:translateX(100%) } to { transform:none } }
@keyframes pb-drawer-out { to { transform:translateX(100%) } }
@keyframes pb-caret { 50% { opacity:0 } }
@keyframes pb-pulse { 0%,100% { opacity:.3 } 50% { opacity:1 } }
@keyframes pb-resolve { to { opacity:0; transform:translateY(-10px) } }

/* overlay layer at the document origin */
.pb-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 0; }

.pb-outline { position: absolute; z-index: 30; pointer-events: none; border: 1px solid var(--pb-amber); border-radius: 2px; background: var(--pb-amber-soft); opacity: 0;
  transition: left 220ms var(--pb-ease), top 220ms var(--pb-ease), width 220ms var(--pb-ease), height 220ms var(--pb-ease), opacity 150ms linear; }
.pb-outline.on { opacity: 1; }
.pb-outline .lab { position: absolute; top: -20px; left: -1px; padding: 2px 7px; background: var(--pb-amber); color: var(--pb-amber-ink); font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .16em; white-space: nowrap; border-radius: 2px; }

.pb-reticle { position: fixed; inset: 0; pointer-events: none; z-index: 50; display: none; }
:host([data-placing]) .pb-reticle { display: block; animation: pb-fade 160ms ease-out both; }
.pb-reticle .h { position: absolute; left: 0; right: 0; height: 1px; background: color-mix(in srgb, var(--pb-amber) 26%, transparent); }
.pb-reticle .v { position: absolute; top: 0; bottom: 0; width: 1px; background: color-mix(in srgb, var(--pb-amber) 26%, transparent); }
.pb-reticle .box { position: absolute; width: 15px; height: 15px; margin: -8px 0 0 -8px; border: 1px solid var(--pb-amber); border-radius: 2px; }
.pb-reticle .ro { position: absolute; margin: 14px 0 0 14px; padding: 3px 6px; background: var(--pb-amber); color: var(--pb-amber-ink); font-family: var(--pb-font-mono); font-size: 9.5px; letter-spacing: .12em; border-radius: 2px; white-space: nowrap; }

/* Drag-to-aim, for touch. The layer never takes pointer events — only the grip and the bar do —
   so what is under the crosshair can still be probed, and the page underneath is still visible. */
/* Above the command bar (90), below the shortcuts modal (120). The confirm bar sits at the very
   bottom of the screen, where the command bar already is — under it, CONFIRM was unclickable. */
.pb-aim { position: fixed; inset: 0; z-index: 100; display: none; pointer-events: none; }
.pb-aim.on { display: block; animation: pb-fade 160ms ease-out both; }
.pb-aim .h { position: absolute; left: 0; right: 0; height: 1px; background: color-mix(in srgb, var(--pb-amber) 30%, transparent); }
.pb-aim .v { position: absolute; top: 0; bottom: 0; width: 1px; background: color-mix(in srgb, var(--pb-amber) 30%, transparent); }
/* 72px: a finger-sized target, per the design. Smaller and you cannot hold it accurately;
   touch-action:none is what stops the page scrolling instead of the reticle moving. */
.pb-aim .grip { position: absolute; width: 72px; height: 72px; margin: -36px 0 0 -36px; border-radius: 999px; border: 1px solid var(--pb-amber); background: var(--pb-amber-soft); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; pointer-events: auto; touch-action: none; cursor: grab; }
.pb-aim .grip:active { cursor: grabbing; }
.pb-aim .grip i { width: 10px; height: 10px; border-radius: 999px; background: var(--pb-amber); box-shadow: 0 0 0 3px var(--pb-canvas); }
.pb-aim .bar { position: absolute; left: 12px; right: 12px; bottom: 12px; display: flex; align-items: center; gap: 8px; padding: 7px; background: var(--pb-bar); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid var(--pb-line-2); border-radius: 4px; box-shadow: var(--pb-shadow); pointer-events: auto; }
.pb-aim .bar .lab { flex: 1; min-width: 0; padding-left: 8px; font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .14em; color: var(--pb-fg3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 48px tall: the minimum a thumb hits reliably. */
.pb-aim .bar button { height: 48px; border-radius: 2px; font-family: var(--pb-font-mono); font-size: 11px; letter-spacing: .16em; cursor: pointer; }
.pb-aim .bar .cancel { flex: none; padding: 0 18px; border: 1px solid var(--pb-line-2); background: transparent; color: var(--pb-fg2); }
.pb-aim .bar .ok { flex: none; padding: 0 20px; border: none; background: var(--pb-amber); color: var(--pb-amber-ink); }

.pb-pin { position: absolute; }
.pb-pin.resolving { animation: pb-resolve 380ms var(--pb-ease) forwards; }
.pb-pin .ring { position: absolute; left: 0; top: 0; width: 26px; height: 26px; border: 1px solid var(--pb-amber); border-radius: 999px; animation: pb-ring 900ms var(--pb-ease) forwards; pointer-events: none; }
.pb-pin .dot { position: absolute; left: -3px; top: -3px; width: 7px; height: 7px; border-radius: 999px; background: var(--pb-amber); box-shadow: 0 0 0 2px var(--pb-canvas); }
.pb-pin .needle { position: absolute; left: 0; bottom: 0; width: 1px; height: 30px; background: linear-gradient(to top, var(--pb-amber), color-mix(in srgb, var(--pb-amber) 35%, transparent)); transform-origin: bottom; animation: pb-needle 300ms var(--pb-ease) both; }
.pb-chipBtn { position: absolute; left: -1px; bottom: 30px; display: flex; align-items: center; gap: 7px; height: 26px; padding: 0 9px; border-radius: 2px; border: 1px solid var(--pb-line-2); background: var(--pb-elev); color: var(--pb-fg1); font-family: var(--pb-font-mono); font-size: 11px; font-weight: 500; letter-spacing: .08em; white-space: nowrap; box-shadow: var(--pb-shadow); animation: pb-chip 420ms var(--pb-ease) both; transition: border-color 160ms linear, background 160ms linear, color 160ms linear; }
.pb-chipBtn:hover { border-color: var(--pb-amber); }
.pb-pin.hot .pb-chipBtn { background: var(--pb-amber); color: var(--pb-amber-ink); border-color: var(--pb-amber); box-shadow: 0 0 0 4px var(--pb-amber-soft); }
.pb-chipBtn .busy { width: 5px; height: 5px; border-radius: 999px; background: currentColor; animation: pb-pulse 1s ease-in-out infinite; }
.pb-chipBtn .lk { display: flex; align-items: center; gap: 5px; padding-left: 6px; margin-left: 1px; border-left: 1px solid var(--pb-line-2); font-size: 9.5px; letter-spacing: .02em; opacity: .85; }
.pb-pin.hot .pb-chipBtn .lk { border-left-color: color-mix(in srgb, var(--pb-amber-ink) 28%, transparent); }
.pb-pin.queued .pb-chipBtn { border-style: dashed; }
.pb-chipBtn .qd { padding-left: 6px; margin-left: 1px; border-left: 1px solid var(--pb-line-2); font-size: 9px; letter-spacing: .12em; color: var(--pb-amber); }
.pb-pin.hot .pb-chipBtn .qd { color: var(--pb-amber-ink); border-left-color: color-mix(in srgb, var(--pb-amber-ink) 28%, transparent); }

/* thread card (ui/card.ts) — prototype lines 121–190 */
.pb-card { position: absolute; z-index: 80; width: 344px; }
.pb-card .in { animation: pb-in 260ms var(--pb-ease) both; background: var(--pb-elev); border: 1px solid var(--pb-line-2); border-radius: 4px; box-shadow: var(--pb-shadow); overflow: hidden; }
.pb-hd { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--pb-line); background: var(--pb-surface); }
.pb-hd .meta { display: flex; align-items: center; gap: 9px; font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .18em; color: var(--pb-fg3); }
.pb-hd .meta .num { color: var(--pb-amber); }
.pb-hd .meta .st { color: var(--pb-fg4); }
.pb-ico { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 2px; color: var(--pb-fg3); }
.pb-ico:hover { background: var(--pb-hover); color: var(--pb-fg1); }
.pb-ico.ok:hover { color: var(--pb-ok); }
.pb-linkbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--pb-line); background: color-mix(in srgb, var(--pb-info) 7%, var(--pb-surface)); animation: pb-in 300ms var(--pb-ease) both; }
.pb-linkbar .ch { white-space: nowrap; font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .06em; }
.pb-linkbar .mt { white-space: nowrap; font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .14em; color: var(--pb-fg4); }
.pb-linkbar .sp { flex: 1; }
.pb-open { display: flex; align-items: center; gap: 5px; height: 20px; padding: 0 7px; border: 1px solid var(--pb-line-2); border-radius: 2px; font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .14em; color: var(--pb-fg2); text-decoration: none; }
.pb-open:hover { border-color: var(--pb-info); color: var(--pb-fg1); }
.pb-thread { max-height: min(392px, calc(100vh - 320px)); overflow: auto; }
.pb-msg-w { animation: pb-in 260ms var(--pb-ease) both; }
.pb-msg { padding: 13px 14px; display: flex; gap: 10px; }
.pb-msg.you { border-bottom: 1px solid var(--pb-line); }
.pb-typing { padding: 13px 14px; display: flex; gap: 10px; align-items: center; }
.pb-typing .dots { display: flex; gap: 4px; }
.pb-typing .dots i { width: 4px; height: 4px; border-radius: 999px; background: var(--pb-amber); animation: pb-pulse 1.1s var(--pb-ease) infinite; }
.pb-typing .dots i:nth-child(2) { animation-delay: .18s; }
.pb-typing .dots i:nth-child(3) { animation-delay: .36s; }
.pb-typing .lbl { font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .14em; color: var(--pb-fg3); }
.pb-msg .steps { display: flex; flex-direction: column; gap: 7px; }
.pb-av { flex: none; width: 22px; height: 22px; border-radius: 999px; display: flex; align-items: center; justify-content: center; font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .04em; background: var(--pb-invert-bg); color: var(--pb-invert-fg); border: 1px solid var(--pb-invert-bg); }
.pb-av.via { background: transparent; color: var(--pb-info); border-color: var(--pb-info); }
.pb-av.agent { background: var(--pb-amber-soft); color: var(--pb-amber); border-color: var(--pb-amber); }
.pb-msg .col { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.pb-msg .line { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.pb-msg .who { font-size: 12px; }
.pb-msg .tm { font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .14em; color: var(--pb-fg4); }
.pb-msg .via-tag { display: flex; align-items: center; gap: 4px; font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .06em; color: var(--pb-fg3); }
.pb-msg .txt { font-size: 13px; line-height: 1.55; letter-spacing: -.005em; color: var(--pb-fg2); text-wrap: pretty; overflow-wrap: anywhere; }
.pb-msg .atts { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 2px; }
.pb-att img { display: block; max-width: 132px; max-height: 88px; border: 1px solid var(--pb-line-2); border-radius: 2px; }
.pb-att-chip { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border: 1px solid var(--pb-line-2); border-radius: 2px; font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .06em; color: var(--pb-fg3); }
.pb-step { display: flex; align-items: center; gap: 8px; font-family: var(--pb-font-mono); font-size: 10.5px; letter-spacing: .02em; animation: pb-fade 220ms ease-out both; }
.pb-step .g { width: 10px; display: flex; justify-content: center; }
.pb-caret { display: inline-block; width: 6px; height: 14px; margin-left: 2px; transform: translateY(2px); background: var(--pb-amber); animation: pb-caret 900ms steps(1) infinite; }
.pb-change { margin: 0 14px 14px 46px; border: 1px solid var(--pb-line); border-radius: 2px; overflow: hidden; }
.pb-change .fh { display: flex; align-items: center; justify-content: space-between; padding: 7px 10px; background: var(--pb-surface); border-bottom: 1px solid var(--pb-line); font-family: var(--pb-font-mono); font-size: 9.5px; letter-spacing: .14em; color: var(--pb-fg3); }
.pb-change .code { background: var(--pb-sunken); padding: 8px 0; font-family: var(--pb-font-mono); font-size: 10.5px; line-height: 1.75; }
.pb-change .mi { padding: 0 10px; color: var(--pb-danger); background: color-mix(in srgb, var(--pb-danger) 9%, transparent); white-space: pre; overflow: auto; }
.pb-change .pl { padding: 0 10px; color: var(--pb-ok); background: color-mix(in srgb, var(--pb-ok) 9%, transparent); white-space: pre; overflow: auto; }
.pb-change .ft { display: flex; align-items: center; gap: 8px; padding: 9px 10px; background: var(--pb-surface); border-top: 1px solid var(--pb-line); }
.pb-change .applied { font-family: var(--pb-font-mono); font-size: 9.5px; letter-spacing: .16em; color: var(--pb-ok); display: flex; align-items: center; gap: 8px; }
.pb-change .applied .hh { color: var(--pb-fg4); }
.pb-verify { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: var(--pb-surface); border-top: 1px solid var(--pb-line); }
.pb-bt-solid { height: 26px; padding: 0 13px; border-radius: 2px; background: var(--pb-invert-bg); color: var(--pb-invert-fg); font-size: 11.5px; }
.pb-bt-solid:hover { opacity: .9; }
.pb-bt-ok { height: 26px; padding: 0 13px; border-radius: 2px; background: var(--pb-ok); color: var(--pb-canvas); font-size: 11.5px; }
.pb-bt-ok:hover { opacity: .9; }
.pb-bt-ghost { height: 26px; padding: 0 13px; border: 1px solid var(--pb-line-2); border-radius: 2px; color: var(--pb-fg2); font-size: 11.5px; }
.pb-bt-ghost:hover { color: var(--pb-fg1); border-color: var(--pb-fg3); }
.pb-composer { border-top: 1px solid var(--pb-line); padding: 11px 12px; background: var(--pb-surface); }
.pb-composer textarea { width: 100%; resize: none; background: var(--pb-sunken); border: 1px solid var(--pb-line); border-radius: 2px; padding: 9px 10px; color: var(--pb-fg1); font-family: var(--pb-font-body); font-size: 13px; line-height: 1.5; letter-spacing: -.005em; outline: none; }
.pb-composer textarea:focus { border-color: var(--pb-amber); box-shadow: 0 0 0 3px var(--pb-amber-soft); }
.pb-composer .row { display: flex; align-items: center; justify-content: space-between; padding-top: 9px; }
.pb-kbd { font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .14em; color: var(--pb-fg4); }

/* command bar */
.pb-bar { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 90; display: flex; align-items: center; height: 46px; padding: 0 6px; gap: 3px; background: var(--pb-bar); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--pb-line-2); border-radius: 4px; box-shadow: var(--pb-shadow); }
.pb-bar .armed-ring { position: absolute; inset: -1px; border: 1px solid var(--pb-amber); border-radius: 4px; box-shadow: 0 0 32px var(--pb-amber-soft); pointer-events: none; animation: pb-fade 200ms ease-out both; display: none; }
:host([data-placing]) .pb-bar .armed-ring { display: block; }
.pb-bar .ident { display: flex; align-items: center; gap: 9px; padding: 0 12px 0 10px; min-width: 150px; }
.pb-bar .ident .bl { font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .24em; white-space: nowrap; }
.pb-bar .div { width: 1px; height: 22px; background: var(--pb-line); }
.pb-tb { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 11px; border-radius: 2px; color: var(--pb-fg2); transition: background 140ms linear; font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .16em; }
.pb-tb:hover { background: var(--pb-hover); }
.pb-tb.hot { background: var(--pb-amber); color: var(--pb-amber-ink); }
.pb-tb.lit { background: var(--pb-hover); color: var(--pb-fg1); }
.pb-tb.sq { width: 32px; padding: 0; justify-content: center; }

/* inbox drawer (ui/drawer.ts) — prototype lines 206–224 */
.pb-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 336px; z-index: 85; background: var(--pb-surface); border-left: 1px solid var(--pb-line); box-shadow: var(--pb-shadow); display: flex; flex-direction: column; animation: pb-drawer 380ms var(--pb-ease) both; }
.pb-drawer.closing { animation: pb-drawer-out 220ms cubic-bezier(0.3, 0, 0.8, 0.15) both; }
.pb-drawer .dh { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 12px; font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .24em; }
.pb-tabs { display: flex; gap: 18px; padding: 0 16px; border-bottom: 1px solid var(--pb-line); }
.pb-tab { padding: 0 0 10px; white-space: nowrap; font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .18em; color: var(--pb-fg3); border-bottom: 1px solid transparent; }
.pb-tab.on { color: var(--pb-fg1); border-bottom-color: var(--pb-amber); }
.pb-items { flex: 1; overflow: auto; }
.pb-item { width: 100%; text-align: left; display: flex; gap: 11px; padding: 14px 16px; border-bottom: 1px solid var(--pb-line); }
.pb-item:hover { background: var(--pb-hover); }
.pb-item .nn { flex: none; display: flex; align-items: center; justify-content: center; min-width: 24px; height: 20px; border-radius: 2px; border: 1px solid var(--pb-line-2); color: var(--pb-fg2); font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .06em; }
.pb-item.on .nn { background: var(--pb-amber); color: var(--pb-amber-ink); border-color: var(--pb-amber); }
.pb-item .cc { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.pb-item .tt { font-size: 12.5px; line-height: 1.45; letter-spacing: -.005em; color: var(--pb-fg1); text-wrap: pretty; }
.pb-item .mm { display: flex; align-items: center; gap: 7px; font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .14em; color: var(--pb-fg4); }
.pb-item .mm .sdot { width: 5px; height: 5px; border-radius: 999px; }
.pb-empty { padding: 26px 16px; font-size: 12.5px; color: var(--pb-fg3); }

/* shortcuts modal (ui/shortcuts.ts) — prototype lines 226–232 */
.pb-modal { position: fixed; inset: 0; z-index: 120; display: flex; align-items: center; justify-content: center; background: var(--pb-scrim); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); animation: pb-fade 200ms ease-out both; }
.pb-modal .mx { width: 430px; background: var(--pb-elev); border: 1px solid var(--pb-line-2); border-radius: 4px; box-shadow: var(--pb-shadow); animation: pb-in 280ms var(--pb-ease) both; }
.pb-modal .mh { padding: 18px 20px 14px; border-bottom: 1px solid var(--pb-line); font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .24em; }
.pb-modal .mr { display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--pb-line); }
.pb-modal .mw { font-size: 13px; letter-spacing: -.005em; color: var(--pb-fg2); }
.pb-modal .mk { display: flex; align-items: center; justify-content: center; min-width: 26px; height: 22px; padding: 0 7px; border: 1px solid var(--pb-line-2); border-radius: 2px; background: var(--pb-sunken); font-family: var(--pb-font-mono); font-size: 10.5px; }

[hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; animation-iteration-count: 1 !important; } .pb-chipBtn .busy, .pb-caret { animation: none; } }
`;
	/**
	* The one rule that must live in the host document, not the shadow root: the
	* armed-state cursor flip (prototype line 100: body.placing cursor none). The
	* element injects this <style> on connect and toggles PAGE_PLACING_CLASS on body.
	*/
	const PAGE_PLACING_CLASS = "pinbox-placing";
	const PAGE_CSS = `body.${PAGE_PLACING_CLASS}, body.${PAGE_PLACING_CLASS} * { cursor: none !important; }`;
	//#endregion
	//#region src/element.ts
	const BaseElement = globalThis.HTMLElement ?? class {};
	/** Keystrokes are ignored while a text control has focus (prototype line 702–703). */
	function isTextEntry(target) {
		const el = target;
		const tag = el?.tagName ?? "";
		return tag === "TEXTAREA" || tag === "INPUT" || el?.isContentEditable === true;
	}
	var PinboxToolbarElement = class extends BaseElement {
		static tagName = "pinbox-toolbar";
		store = createStore();
		/** Card → transport seam (wired by #startTransport once a config exists). */
		actions = {};
		#config = null;
		#transport = null;
		#token = "";
		#built = false;
		#bar = null;
		#reticle = null;
		#pinsLayer = null;
		#drawer = null;
		#aim = null;
		#modal = null;
		#helpOpen = false;
		#pageStyle = null;
		#unsubscribe = null;
		#hover = null;
		/** Card → element: send/verify/resolve forward to the transport seam; close dismisses. */
		#cardActions = {
			send: (pinId, text) => this.actions.send?.(pinId, text),
			verify: (pinId, outcome) => this.actions.verify?.(pinId, outcome),
			resolve: (pinId) => this.actions.resolve?.(pinId),
			close: () => this.#dismiss()
		};
		/** Programmatic path (Pinbox.init). The snippet path reads hub/token attributes. */
		configure(config) {
			this.#config = config;
		}
		get config() {
			if (this.#config) return this.#config;
			const hub = this.getAttribute("hub");
			if (!hub) return null;
			const token = this.getAttribute("token");
			return token === null ? { endpoint: hub } : {
				endpoint: hub,
				token
			};
		}
		connectedCallback() {
			if (!this.#built) {
				this.#built = true;
				this.#build();
			}
			if (!this.hasAttribute("data-pb")) {
				const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
				this.setAttribute("data-pb", dark ? "dark" : "light");
			}
			const style = document.createElement("style");
			style.textContent = PAGE_CSS;
			document.head.appendChild(style);
			this.#pageStyle = style;
			document.addEventListener("mousemove", this.#onMouseMove);
			window.addEventListener("scroll", this.#onViewportChange, { passive: true });
			window.addEventListener("resize", this.#onViewportChange);
			document.addEventListener("click", this.#onClickCapture, true);
			document.addEventListener("keydown", this.#onKeyDown);
			this.#unsubscribe = this.store.subscribe((s) => this.#render(s));
			this.#render(this.store.get());
			this.#startTransport();
		}
		disconnectedCallback() {
			this.#transport?.close();
			this.#transport = null;
			document.removeEventListener("mousemove", this.#onMouseMove);
			window.removeEventListener("scroll", this.#onViewportChange);
			window.removeEventListener("resize", this.#onViewportChange);
			document.removeEventListener("click", this.#onClickCapture, true);
			document.removeEventListener("keydown", this.#onKeyDown);
			this.#aim?.destroy();
			this.#aim = null;
			this.#unsubscribe?.();
			this.#unsubscribe = null;
			this.#pageStyle?.remove();
			this.#pageStyle = null;
			document.body.classList.remove(PAGE_PLACING_CLASS);
		}
		#build() {
			const shadow = this.attachShadow({ mode: "open" });
			try {
				const sheet = new CSSStyleSheet();
				sheet.replaceSync(TOOLBAR_CSS);
				shadow.adoptedStyleSheets = [sheet];
			} catch {
				const style = document.createElement("style");
				style.textContent = TOOLBAR_CSS;
				shadow.appendChild(style);
			}
			const overlay = document.createElement("div");
			overlay.className = "pb-overlay";
			this.#pinsLayer = document.createElement("div");
			overlay.appendChild(this.#pinsLayer);
			this.#reticle = createReticle(document);
			overlay.appendChild(this.#reticle.outline);
			const card = document.createElement("div");
			card.className = "pb-card";
			card.hidden = true;
			overlay.appendChild(card);
			shadow.appendChild(overlay);
			shadow.appendChild(this.#reticle.crosshair);
			this.#bar = createBar(document, {
				onPin: () => this.#togglePlacing(),
				onInbox: () => this.store.update({ inboxOpen: !this.store.get().inboxOpen }),
				onTheme: () => this.#toggleTheme(),
				onHelp: () => this.#toggleHelp(),
				onCopy: () => this.#copyOpenPins()
			});
			shadow.appendChild(this.#bar.root);
			this.#drawer = createDrawer(document, {
				onActivate: (pinId) => this.#activateFromInbox(pinId),
				onClose: () => this.store.update({ inboxOpen: false })
			});
			shadow.appendChild(this.#drawer.root);
			this.#aim = createAim(document, {
				onAim: (x, y) => this.#probe(x, y),
				onConfirm: () => this.#confirmAim(),
				onCancel: () => this.#dismiss()
			});
			shadow.appendChild(this.#aim.root);
			this.#modal = createShortcutsModal(document, () => this.#setHelp(false));
			shadow.appendChild(this.#modal.root);
			this.#pinsLayer.addEventListener("click", (e) => this.#onChipClick(e));
		}
		/**
		* Task 8 wiring: WS events mutate the store, connection state renders in the
		* bar, card actions hit the hub. The mirror seeds pins so an offline reload
		* still renders read-only threads and queued drafts.
		*/
		async #startTransport() {
			if (this.#transport !== null) return;
			const cfg = this.config;
			if (cfg === null) return;
			this.#token = cfg.token ?? await cfg.getToken?.().catch(() => void 0) ?? "";
			const transport = new HubTransport({
				endpoint: cfg.endpoint,
				token: this.#token,
				onEvent: (e) => applyHubEvent(this.store, e),
				onConnection: (connection) => this.store.update({ connection }),
				onPins: (pins) => this.store.update({ pins }),
				onOutbox: (ids) => this.store.update({ queuedIds: new Set(ids) })
			});
			this.#transport = transport;
			const queued = transport.outboxPins();
			const seed = [...transport.mirrorPins(), ...queued];
			if (seed.length > 0 && this.store.get().pins.length === 0) this.store.update({ pins: seed });
			if (queued.length > 0) this.store.update({ queuedIds: new Set(queued.map((p) => p.id)) });
			this.actions.send = (pinId, text) => void this.#send(transport, pinId, text);
			this.actions.resolve = (pinId) => void transport.resolve(pinId).then((pin) => upsertPin(this.store, pin)).catch(() => {});
			this.actions.verify = (pinId, outcome) => void transport.verify(pinId, outcome).then((pin) => {
				upsertPin(this.store, pin);
				if (outcome === "accepted") this.#dismiss();
			}).catch(() => {});
			transport.connect();
		}
		/** draft ⇒ compose PinInput (+ best-effort screenshot) and createPin; else thread reply. */
		async #send(transport, pinId, text) {
			try {
				if (pinId === "draft") {
					const draft = this.store.get().draft;
					if (draft === null) return;
					const input = {
						text,
						kind: "note",
						target: draft.target.target,
						env: draft.target.env,
						author: { userId: transport.consumerId }
					};
					const shot = await this.#screenshot(draft.target.target.selector);
					if (shot !== null) input.attachments = [shot];
					this.store.commitDraft(await transport.createPin(input));
				} else appendThreadMessage(this.store, await transport.reply(pinId, text));
			} catch {}
		}
		/** Best-effort element screenshot: draft submit → captureElement → uploadAttachment. */
		async #screenshot(selector) {
			const cfg = this.config;
			if (cfg === null) return null;
			if (cfg.screenshots === false) return null;
			try {
				const el = document.querySelector(selector);
				if (el === null) return null;
				const img = await captureElement(el);
				if (img === null) return null;
				return await uploadAttachment(cfg.endpoint, this.#token, img);
			} catch {
				return null;
			}
		}
		/** Threads build from WS events; after a reload the cursor skips old ones — fetch lazily. */
		#ensureThread(pinId) {
			const transport = this.#transport;
			if (transport === null || this.store.get().threads.has(pinId)) return;
			transport.getThread(pinId).then((messages) => {
				const threads = new Map(this.store.get().threads);
				threads.set(pinId, messages);
				this.store.update({ threads });
			}).catch(() => {});
		}
		/** Inbox item click: activate the pin and scroll it into view (prototype line 700). */
		#activateFromInbox(pinId) {
			const pin = this.store.get().pins.find((p) => p.id === pinId);
			this.#ensureThread(pinId);
			this.store.update({ activePinId: pinId });
			const rect = pin?.target?.rect;
			if (rect) {
				const y = rect.y + rect.height / 2;
				window.scrollTo({
					top: Math.max(0, y - window.innerHeight / 2),
					behavior: "smooth"
				});
			}
		}
		/** The markdown offline fallback: copy every open pin's block to the clipboard. */
		#copyOpenPins() {
			const state = this.store.get();
			try {
				navigator.clipboard.writeText(pinsToMarkdown(state.pins, state.threads));
			} catch {}
		}
		#setHelp(open) {
			this.#helpOpen = open;
			this.#modal?.set(open);
		}
		#toggleHelp() {
			this.#setHelp(!this.#helpOpen);
		}
		/** Chip click toggles the pin active (prototype data-open delegation, line 675). */
		#onChipClick(e) {
			const id = e.target.closest?.("[data-open]")?.getAttribute("data-open");
			if (!id || id === "draft") return;
			const active = this.store.get().activePinId;
			if (active !== id) this.#ensureThread(id);
			this.store.update({ activePinId: active === id ? null : id });
		}
		#togglePlacing() {
			const placing = this.store.get().mode === "placing";
			this.store.update({
				mode: placing ? "idle" : "placing",
				activePinId: null
			});
		}
		#toggleInbox() {
			this.store.update({ inboxOpen: !this.store.get().inboxOpen });
		}
		#resolveActive() {
			const active = this.store.get().activePinId;
			if (active) this.actions.resolve?.(active);
		}
		#toggleTheme() {
			const next = this.getAttribute("data-pb") === "dark" ? "light" : "dark";
			this.setAttribute("data-pb", next);
		}
		/** esc / click-away: leave placing, discard the draft (client-only), deactivate. */
		#dismiss() {
			this.#setHelp(false);
			this.store.update({
				mode: "idle",
				activePinId: null
			});
			if (this.store.get().draft) this.store.discardDraft();
		}
		/**
		* Work out what sits under a viewport point and highlight it.
		*
		* Shared by both ways of aiming — following a mouse, and dragging the reticle — so the two can
		* never disagree about what is under the crosshair.
		*/
		#probe(clientX, clientY) {
			const el = hitTest(document, clientX, clientY, (hit) => hit === this);
			this.#hover = el;
			if (el) this.#reticle?.snap(el.getBoundingClientRect(), targetLabel(el), {
				x: window.scrollX,
				y: window.scrollY
			});
			else this.#reticle?.release();
			this.#aim?.setLabel(el ? targetLabel(el) : "NOTHING UNDER THE PIN");
		}
		/**
		* Keep the drag-aim reticle honest while the viewport moves under it.
		*
		* Scrolling changes what is beneath a fixed reticle, and resizing (a phone rotating, a window
		* dragged narrow) can both strand it off-screen and flip which way of aiming applies.
		*/
		#onViewportChange = () => {
			if (this.store.get().mode !== "placing") return;
			this.#syncAim(true);
			const aim = this.#aim;
			if (aim?.root.classList.contains("on") === true) this.#probe(aim.point.x, aim.point.y);
		};
		#onMouseMove = (e) => {
			if (this.store.get().mode !== "placing" || !this.#reticle) return;
			this.#reticle.move(e);
			this.#probe(e.clientX, e.clientY);
		};
		/** Commit the pin the drag-aim reticle is sitting on. */
		#confirmAim() {
			const aim = this.#aim;
			if (!aim) return;
			this.#probe(aim.point.x, aim.point.y);
			const el = this.#hover ?? document.body;
			this.store.place({
				target: captureTarget(el, { at: {
					x: aim.point.x + window.scrollX,
					y: aim.point.y + window.scrollY
				} }),
				placedAt: {
					x: aim.point.x + window.scrollX,
					y: aim.point.y + window.scrollY
				}
			});
			this.#reticle?.release();
		}
		/** Placement click: capture the hovered target (or body) into a client-only draft. */
		#placeDraft(e) {
			e.preventDefault();
			e.stopPropagation();
			const el = this.#hover ?? document.body;
			this.store.place({
				target: captureTarget(el, { at: {
					x: e.pageX,
					y: e.pageY
				} }),
				placedAt: {
					x: e.pageX,
					y: e.pageY
				}
			});
			this.#reticle?.release();
		}
		#onClickCapture = (e) => {
			if (e.composedPath().includes(this)) return;
			const state = this.store.get();
			if (state.mode === "placing") {
				if (!needsDragAim(window)) this.#placeDraft(e);
				return;
			}
			if (state.inboxOpen) this.store.update({ inboxOpen: false });
			if (state.activePinId || state.draft) this.#dismiss();
		};
		/** Prototype keyboard map (v2-command-bar.html lines 701–712). */
		#shortcuts = {
			escape: () => this.#dismiss(),
			p: () => this.#togglePlacing(),
			i: () => this.#toggleInbox(),
			d: () => this.#toggleTheme(),
			r: () => this.#resolveActive(),
			c: () => this.#copyOpenPins(),
			"?": () => this.#toggleHelp()
		};
		#onKeyDown = (e) => {
			if (isTextEntry(e.composedPath()[0])) return;
			this.#shortcuts[e.key === "?" ? "?" : e.key.toLowerCase()]?.();
		};
		/**
		* Bring the drag-aim reticle up with placing mode, seeded mid-screen and already showing what it
		* is over — so the first thing you see is a live target, not an empty crosshair waiting for a
		* mouse that is never coming.
		*/
		#syncAim(placing) {
			const aim = this.#aim;
			if (!aim) return;
			if (!placing || !needsDragAim(window)) {
				aim.hide();
				return;
			}
			if (aim.root.classList.contains("on")) {
				if (aim.point.x <= window.innerWidth && aim.point.y <= window.innerHeight) return;
				aim.show(Math.min(aim.point.x, window.innerWidth), Math.min(aim.point.y, window.innerHeight));
				return;
			}
			const { x, y } = startPoint(window);
			aim.show(x, y);
			this.#probe(x, y);
		}
		#render(state) {
			const placing = state.mode === "placing";
			this.toggleAttribute("data-placing", placing);
			document.body.classList.toggle(PAGE_PLACING_CLASS, placing);
			if (!placing) this.#reticle?.release();
			this.#syncAim(placing);
			if (this.#pinsLayer) renderPins(this.#pinsLayer, state);
			if (this.shadowRoot) renderCard(this.shadowRoot, state, this.#cardActions);
			this.#drawer?.update(state);
			this.#bar?.update(state);
		}
	};
	//#endregion
	//#region src/index.ts
	/** Register <pinbox-toolbar>; no-op outside a browser or when already defined. */
	function defineToolbarElement() {
		if (typeof customElements === "undefined") return;
		if (!customElements.get(PinboxToolbarElement.tagName)) customElements.define(PinboxToolbarElement.tagName, PinboxToolbarElement);
	}
	const Pinbox = { init(config) {
		defineToolbarElement();
		const el = document.createElement(PinboxToolbarElement.tagName);
		el.configure(config);
		document.body.appendChild(el);
		return el;
	} };
	defineToolbarElement();
	//#endregion
	//#region src/iife.ts
	/** Mount the toolbar: `Pinbox.init({ endpoint, getToken, targeting, anchorAttribute })`. */
	const init = Pinbox.init;
	//#endregion
	exports.PinboxToolbarElement = PinboxToolbarElement;
	exports.defineToolbarElement = defineToolbarElement;
	exports.init = init;
	return exports;
})({});
