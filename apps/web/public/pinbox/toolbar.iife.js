var Pinbox = (function(exports) {
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	//#region src/anchor-watch.ts
	function watchAnchors(win, onChange) {
		let frame = 0;
		const schedule = () => {
			if (frame !== 0) return;
			frame = win.requestAnimationFrame(() => {
				frame = 0;
				onChange();
			});
		};
		const observer = new (win.MutationObserver ?? MutationObserver)(schedule);
		observer.observe(win.document.body, {
			childList: true,
			subtree: true
		});
		win.addEventListener("popstate", schedule);
		return { destroy() {
			observer.disconnect();
			win.removeEventListener("popstate", schedule);
			if (frame !== 0) win.cancelAnimationFrame(frame);
			frame = 0;
		} };
	}
	//#endregion
	//#region src/capture-mode.ts
	function captureKey(prefix) {
		return `${prefix}:capture`;
	}
	function loadCaptureMode(storage, key, fallback) {
		try {
			const raw = storage?.getItem(key);
			if (raw === "dom" || raw === "tab") return raw;
		} catch {}
		return fallback;
	}
	function saveCaptureMode(storage, key, mode) {
		try {
			storage?.setItem(key, mode);
		} catch {}
	}
	//#endregion
	//#region src/ui/actions.ts
	const PIN_GLYPH = "<rect x=\"3\" y=\"1.5\" width=\"10\" height=\"6.5\" rx=\"1\"/><path d=\"M8 8v6.5\"/>";
	const INBOX_GLYPH = "<path d=\"M1.8 8.5h3.4l1 2h3.6l1-2h3.4\"/><path d=\"M2.6 3.2h10.8l1.2 5.3v4a1 1 0 01-1 1H2.4a1 1 0 01-1-1v-4z\"/>";
	const THEME_GLYPH = "<path d=\"M8 2a4 4 0 0 0 6 6 6 6 0 1 1-6-6z\"/>";
	const COPY_GLYPH = "<rect x=\"5.5\" y=\"5.5\" width=\"8\" height=\"8\" rx=\"1\"/><path d=\"M10.5 3.5v-1a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h1\"/>";
	const EYE_GLYPH = "<path d=\"M1.6 8S4 3.8 8 3.8 14.4 8 14.4 8 12 12.2 8 12.2 1.6 8 1.6 8z\"/><circle cx=\"8\" cy=\"8\" r=\"1.8\"/>";
	const EYE_OFF_GLYPH = "<path d=\"M2.3 2.3l11.4 11.4\"/><path d=\"M4.9 4.9C2.7 6.2 1.6 8 1.6 8s2.4 4.2 6.4 4.2c1.2 0 2.3-.3 3.1-.8M6.7 4c.4-.1.9-.2 1.3-.2 4 0 6.4 4.2 6.4 4.2s-.8 1.4-2.2 2.5\"/>";
	const MIN_GLYPH = "<path d=\"M6.5 2.5v4h-4\"/><path d=\"M9.5 13.5v-4h4\"/>";
	const CAMERA_GLYPH = "<path d=\"M2 5.5h2.6l1.2-1.8h4.4L11.4 5.5H14v7.5H2z\"/><circle cx=\"8\" cy=\"9\" r=\"2.3\"/>";
	const EXPAND_GLYPH = "<path d=\"M9.5 6.5v-4h4\"/><path d=\"M6.5 9.5v4h-4\"/>";
	/** Frame a glyph as an inline SVG at `size` px. */
	function icon(glyph, size) {
		return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">${glyph}</svg>`;
	}
	/** Ordered as the bar and fan lay them out. */
	const ACTIONS = [
		{
			id: "pin",
			label: "Drop a pin",
			key: "p",
			glyph: PIN_GLYPH,
			bar: { text: "PIN" },
			fan: {}
		},
		{
			id: "inbox",
			label: "Open inbox",
			key: "i",
			glyph: INBOX_GLYPH,
			bar: { count: true },
			fan: {}
		},
		{
			id: "copy",
			label: "Copy open pins",
			key: "c",
			glyph: COPY_GLYPH,
			bar: {},
			fan: {}
		},
		{
			id: "theme",
			label: "Toggle theme",
			key: "d",
			glyph: THEME_GLYPH,
			bar: {},
			fan: {}
		},
		{
			id: "hide",
			label: "Hide / show pins",
			key: "h",
			glyph: EYE_OFF_GLYPH,
			bar: {},
			fan: { label: "Hide pins" }
		},
		{
			id: "capture",
			label: "Tab capture for screenshots (Chrome asks once)",
			key: "s",
			glyph: CAMERA_GLYPH,
			bar: {}
		},
		{
			id: "help",
			label: "Shortcuts",
			key: "?",
			bar: {},
			help: false
		},
		{
			id: "minimize",
			label: "Minimize toolbar",
			key: "m",
			glyph: MIN_GLYPH,
			bar: { ariaLabel: "Minimize toolbar" },
			fan: {
				act: "expand",
				label: "Expand"
			}
		},
		{
			id: "resolve",
			label: "Mark pin resolved",
			key: "r"
		},
		{
			id: "escape",
			label: "Cancel",
			key: "escape",
			keyLabel: "ESC"
		}
	];
	function keyLabelOf(a) {
		return a.keyLabel ?? (a.key ?? "").toUpperCase();
	}
	/** "Drop a pin (P)" — the bar's hover title. */
	function titleOf(a) {
		return a.key === void 0 ? a.label : `${a.label} (${keyLabelOf(a)})`;
	}
	/** Lower-cased `KeyboardEvent.key` → action. `?` keeps its case: it only exists shifted. */
	const ACTION_BY_KEY = new Map(ACTIONS.filter((a) => a.key !== void 0).map((a) => [a.key, a.id]));
	//#endregion
	//#region src/keys.ts
	/** Hosts mark a subtree the toolbar must ignore keys from (custom editors, games). */
	const IGNORE_KEYS_ATTR = "data-pinbox-ignore-keys";
	const TEXT_TAGS = /* @__PURE__ */ new Set([
		"TEXTAREA",
		"INPUT",
		"SELECT"
	]);
	const TEXT_ROLE_SELECTOR = [
		"textbox",
		"combobox",
		"searchbox",
		"spinbutton"
	].map((r) => `[role="${r}"]`).join(",");
	/**
	* Is the key going into a text control? `INPUT`/`TEXTAREA`/contentEditable, plus
	* the things the old check missed: `<select>`, ARIA text roles on custom editors,
	* and any ancestor flagged with `data-pinbox-ignore-keys`.
	*/
	function isTextEntry(target) {
		const el = target;
		if (!el || typeof el.tagName !== "string") return false;
		if (TEXT_TAGS.has(el.tagName)) return true;
		if (el.isContentEditable === true) return true;
		if (el.closest?.(TEXT_ROLE_SELECTOR) != null) return true;
		return el.closest?.(`[${IGNORE_KEYS_ATTR}]`) != null;
	}
	/**
	* Which action, if any, a keydown asks for.
	*
	* Modifier chords are never ours (⌘P is print, ⌃I is italics, ⌥ types
	* characters); Shift is allowed because `?` needs it. Repeats and IME
	* composition are ignored so a held key acts once and a composing keyboard is
	* left alone.
	*/
	function shortcutFor(e, mode = "all") {
		if (mode === "off") return null;
		if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.isComposing) return null;
		if (isTextEntry(e.composedPath()[0] ?? e.target)) return null;
		const key = e.key === "?" ? "?" : e.key.toLowerCase();
		const id = ACTION_BY_KEY.get(key);
		if (id === void 0) return null;
		if (mode === "escape-only" && id !== "escape") return null;
		return id;
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
			`## Pin ${pin.n === void 0 ? pin.id : `#${pin.n} (${pin.id})`} — ${pin.status.toUpperCase()}`,
			`- label: ${line(label(pin))}`,
			...selector === void 0 ? [] : [`- selector: \`${line(selector)}\``],
			...(pin.target?.targets ?? []).map((t) => t.selector ?? t.anchor ?? t.tag).filter((locus) => locus !== void 0).map((locus) => `- also: \`${line(locus)}\``),
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
	/** One pin's block — the card's per-pin copy (dogfood: "I want to copy an
	* individual pin"); any status, since you copy exactly what you're looking at. */
	function pinToMarkdown(pin, thread) {
		return `${block(pin, thread)}\n`;
	}
	//#endregion
	//#region src/motion/drag.ts
	/** Movement that begins a drag… */
	const DRAG_START = 8;
	/** …but a release under this much TOTAL travel is still a tap. */
	const TAP_MAX = 12;
	/**
	* Attach the drag rules to `el`. The press is read on `el`; move/up/cancel are read on its
	* document while a hold is live, so the release cannot be lost to a failed capture. Pointer
	* capture is still requested (it keeps moves flowing when the pointer leaves the window);
	* `touch-action: none` on the element is the caller's job.
	*/
	function attachDrag(el, on) {
		const doc = el.ownerDocument;
		const win = doc.defaultView;
		let hold = null;
		function listen(active) {
			const method = active ? "addEventListener" : "removeEventListener";
			doc[method]("pointermove", onPointerMove, true);
			doc[method]("pointerup", onPointerUp, true);
			doc[method]("pointercancel", onPointerUp, true);
			win?.[method]("blur", onBlur);
		}
		function onPointerDown(e) {
			if (e.button !== 0 || hold !== null) return;
			const origin = on.origin();
			if (origin === null) return;
			try {
				el.setPointerCapture(e.pointerId);
			} catch {}
			hold = {
				pointerId: e.pointerId,
				px: e.clientX,
				py: e.clientY,
				origin,
				lx: e.clientX,
				ly: e.clientY,
				started: false
			};
			listen(true);
		}
		function onPointerMove(e) {
			if (hold === null || e.pointerId !== hold.pointerId) return;
			hold.lx = e.clientX;
			hold.ly = e.clientY;
			const dx = e.clientX - hold.px;
			const dy = e.clientY - hold.py;
			if (!hold.started) {
				if (!on.canStart()) {
					release();
					return;
				}
				if (Math.hypot(dx, dy) < DRAG_START) return;
				hold.started = true;
				on.onStart(hold.origin);
			}
			on.onMove({
				x: hold.origin.x + dx,
				y: hold.origin.y + dy
			});
		}
		function release() {
			hold = null;
			listen(false);
		}
		/** The window lost focus mid-hold: whatever the pointer does next, we will not see it. */
		function onBlur() {
			if (hold !== null) onPointerUp();
		}
		function onPointerUp(e) {
			if (hold === null || e !== void 0 && e.pointerId !== hold.pointerId) return;
			const h = hold;
			release();
			const total = Math.hypot(h.lx - h.px, h.ly - h.py);
			on.onEnd({
				dragged: h.started && total >= TAP_MAX,
				started: h.started,
				origin: h.origin,
				target: {
					x: h.origin.x + (h.lx - h.px),
					y: h.origin.y + (h.ly - h.py)
				}
			});
		}
		el.addEventListener("pointerdown", onPointerDown);
		return {
			cancel: release,
			destroy() {
				release();
				el.removeEventListener("pointerdown", onPointerDown);
			}
		};
	}
	/** Keep a top-left corner of a `size`-square (or w×h box) `margin` px inside the viewport. */
	function clampToViewport(p, win, box, margin) {
		const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
		return {
			x: clamp(p.x, margin, Math.max(margin, win.innerWidth - margin - box.w)),
			y: clamp(p.y, margin, Math.max(margin, win.innerHeight - margin - box.h))
		};
	}
	/** A persisted `{x,y}` (mirror convention: reads never throw upward); null when absent or malformed. */
	function readPoint(storage, key) {
		try {
			const raw = storage?.getItem(key);
			if (raw == null) return null;
			const parsed = JSON.parse(raw);
			if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
			return {
				x: parsed.x,
				y: parsed.y
			};
		} catch {
			return null;
		}
	}
	//#endregion
	//#region src/motion/spring.ts
	/** Bar ⇄ puck morphs and the post-drag settle. */
	const MORPH_SPRING = {
		k: 300,
		c: 30
	};
	/** The morph surface chasing the pointer mid-drag. */
	const FOLLOW_SPRING = {
		k: 600,
		c: 38
	};
	/** Integration substep — small enough that MORPH/FOLLOW stay stable at any dt. */
	const SUBSTEP = 1 / 240;
	/** A property this close to target, moving this slowly, counts as settled. */
	const SETTLE = .5;
	function mkSpring(init) {
		const cur = { ...init };
		const tgt = { ...init };
		const keys = Object.keys(init);
		const vel = {};
		for (const key of keys) vel[key] = 0;
		let cfg = { ...MORPH_SPRING };
		const curN = cur;
		const tgtN = tgt;
		function integrate(h) {
			for (const key of keys) {
				const x = curN[key] ?? 0;
				const v = vel[key] ?? 0;
				const nextV = v + (-cfg.k * (x - (tgtN[key] ?? 0)) - cfg.c * v) * h;
				vel[key] = nextV;
				curN[key] = x + nextV * h;
			}
		}
		return {
			cur,
			tgt,
			snap(values) {
				Object.assign(cur, values);
				Object.assign(tgt, values);
				for (const key of Object.keys(vel)) vel[key] = 0;
			},
			to(values, nextCfg) {
				Object.assign(tgt, values);
				if (nextCfg) cfg = { ...nextCfg };
			},
			step(dt) {
				let remaining = dt;
				while (remaining > 1e-6) {
					const h = Math.min(SUBSTEP, remaining);
					remaining -= h;
					integrate(h);
				}
				for (const key of keys) {
					const v = vel[key] ?? 0;
					const gap = (curN[key] ?? 0) - (tgtN[key] ?? 0);
					if (Math.abs(v) > SETTLE || Math.abs(gap) > SETTLE) return false;
				}
				this.snap({ ...tgt });
				return true;
			}
		};
	}
	//#endregion
	//#region src/minimize.ts
	const PUCK = 48;
	const MARGIN$1 = 16;
	/** Spring hold while the surface swap crossfades (ms). */
	const HOLD_MINIMIZE = 90;
	const HOLD_RESTORE = 70;
	/** Arrival: real element fades in first, morph layer fades this much later. */
	const SWAP_FADE = 100;
	/** …and is display:none'd once its own fade has finished. */
	const LAYER_HIDE = 140;
	const BAR_RADIUS = 4;
	/** The carrier icon rides the surface only while it is puck-like (< this width). */
	const CARRIER_MAX_W = 260;
	/** Fan close transition length before display:none. */
	const FAN_HIDE = 300;
	function createMinimize(host) {
		const { win, bar, ui } = host;
		const main = mkSpring({
			x: 0,
			y: 0,
			w: 0,
			h: 0,
			r: 0
		});
		let mode = "bar";
		let puckPos = null;
		let dock = loadDock();
		let keyboardToggle = false;
		let raf = 0;
		let last = 0;
		let holdTimer = 0;
		let fadeTimer = 0;
		let hideTimer = 0;
		let fanOpen = false;
		let fanTimer = 0;
		function loadDock() {
			return readPoint(host.storage, `${host.storagePrefix}:dock`);
		}
		function persist() {
			try {
				if (dock) host.storage?.setItem(`${host.storagePrefix}:dock`, JSON.stringify(dock));
				host.storage?.setItem(`${host.storagePrefix}:minimized`, mode === "bar" ? "0" : "1");
			} catch {}
		}
		function loadMinimized() {
			try {
				const raw = host.storage?.getItem(`${host.storagePrefix}:minimized`);
				return raw == null ? host.initialMinimized : raw === "1";
			} catch {
				return host.initialMinimized;
			}
		}
		function clampPos(p) {
			return clampToViewport(p, win, {
				w: PUCK,
				h: PUCK
			}, MARGIN$1);
		}
		function defaultDock() {
			const r = bar.getBoundingClientRect();
			return {
				x: r.left + r.width / 2 - PUCK / 2,
				y: r.top + (r.height - PUCK) / 2
			};
		}
		function placePuck(x, y) {
			puckPos = {
				x,
				y
			};
			ui.puck.style.transform = `translate(${x}px, ${y}px)`;
		}
		function render() {
			const m = main.cur;
			ui.surface.style.width = `${m.w}px`;
			ui.surface.style.height = `${m.h}px`;
			ui.surface.style.borderRadius = `${m.r}px`;
			ui.surface.style.transform = `translate(${m.x}px, ${m.y}px)`;
			ui.carrier.style.transform = `translate(${m.x + m.w / 2 - PUCK / 2}px, ${m.y + m.h / 2 - PUCK / 2}px)`;
			if (mode === "settle") placePuck(m.x, m.y);
			const iconOn = mode === "drag" || mode === "settle" || (mode === "toPuck" || mode === "toBar") && m.w < CARRIER_MAX_W;
			ui.carrier.classList.toggle("show", iconOn);
		}
		function showMorph() {
			win.clearTimeout(hideTimer);
			win.clearTimeout(fadeTimer);
			ui.morphWrap.hidden = false;
			ui.morphWrap.offsetWidth;
			ui.morphWrap.classList.add("on");
		}
		function hideMorph() {
			ui.morphWrap.classList.remove("on");
			ui.carrier.classList.remove("show");
			win.clearTimeout(hideTimer);
			hideTimer = win.setTimeout(() => {
				ui.morphWrap.hidden = true;
			}, LAYER_HIDE);
		}
		function tick(now) {
			const dt = Math.min((now - last) / 1e3, 1 / 30);
			last = now;
			const done = main.step(dt);
			render();
			if (done && mode !== "drag") {
				raf = 0;
				if (mode === "toPuck" || mode === "settle") finishPuck();
				else if (mode === "toBar") finishBar();
			} else raf = win.requestAnimationFrame(tick);
		}
		function ensureLoop() {
			if (raf === 0) {
				last = win.performance.now();
				raf = win.requestAnimationFrame(tick);
			}
		}
		function finishPuck() {
			placePuck(main.cur.x, main.cur.y);
			ui.puck.classList.remove("pb-ghost");
			win.clearTimeout(fadeTimer);
			fadeTimer = win.setTimeout(hideMorph, SWAP_FADE);
			mode = "puck";
			persist();
			host.onSettled(true, keyboardToggle);
		}
		function finishBar() {
			bar.classList.remove("pb-ghost");
			win.clearTimeout(fadeTimer);
			fadeTimer = win.setTimeout(hideMorph, SWAP_FADE);
			mode = "bar";
			persist();
			host.onSettled(false, keyboardToggle);
		}
		function minimize(keyboard = false) {
			if (mode !== "bar") return;
			drag.cancel();
			keyboardToggle = keyboard;
			const r = bar.getBoundingClientRect();
			const d = clampPos(dock ?? defaultDock());
			bar.classList.add("pb-ghost");
			if (host.reduced) {
				placePuck(d.x, d.y);
				ui.puck.classList.remove("pb-ghost");
				mode = "puck";
				persist();
				host.onSettled(true, keyboard);
				return;
			}
			main.snap({
				x: r.left,
				y: r.top,
				w: r.width,
				h: r.height,
				r: BAR_RADIUS
			});
			mode = "toPuck";
			render();
			showMorph();
			win.clearTimeout(holdTimer);
			holdTimer = win.setTimeout(() => {
				main.to({
					x: d.x,
					y: d.y,
					w: PUCK,
					h: PUCK,
					r: PUCK / 2
				}, MORPH_SPRING);
				ensureLoop();
			}, HOLD_MINIMIZE);
		}
		function restore(keyboard = false) {
			if (mode !== "puck" || puckPos === null) return;
			closeFan();
			drag.cancel();
			keyboardToggle = keyboard;
			dock = { ...puckPos };
			ui.puck.classList.add("pb-ghost");
			if (host.reduced) {
				bar.classList.remove("pb-ghost");
				mode = "bar";
				persist();
				host.onSettled(false, keyboard);
				return;
			}
			const r = bar.getBoundingClientRect();
			main.snap({
				x: puckPos.x,
				y: puckPos.y,
				w: PUCK,
				h: PUCK,
				r: PUCK / 2
			});
			mode = "toBar";
			render();
			showMorph();
			win.clearTimeout(holdTimer);
			holdTimer = win.setTimeout(() => {
				main.to({
					x: r.left,
					y: r.top,
					w: r.width,
					h: r.height,
					r: BAR_RADIUS
				}, MORPH_SPRING);
				ensureLoop();
			}, HOLD_RESTORE);
		}
		/** Fan out of the puck: direction away from the nearer vertical edge,
		* labels sliding toward screen center. */
		function openFan() {
			if (mode !== "puck" || puckPos === null) return;
			win.clearTimeout(fanTimer);
			ui.fan.hidden = false;
			const upward = puckPos.y + PUCK / 2 > win.innerHeight / 2;
			ui.fan.classList.toggle("up", upward);
			ui.fan.classList.toggle("down", !upward);
			ui.fan.classList.toggle("labels-right", puckPos.x + PUCK / 2 < win.innerWidth / 2);
			ui.fan.classList.toggle("labels-left", puckPos.x + PUCK / 2 >= win.innerWidth / 2);
			ui.fan.style.left = `${puckPos.x + PUCK / 2 - 20}px`;
			ui.fan.offsetHeight;
			const h = ui.fan.offsetHeight;
			ui.fan.style.top = upward ? `${puckPos.y - h - 10}px` : `${puckPos.y + PUCK + 10}px`;
			ui.fan.classList.add("on");
			ui.puck.setAttribute("aria-expanded", "true");
			fanOpen = true;
		}
		function closeFan() {
			if (!fanOpen) return false;
			ui.fan.classList.remove("on");
			ui.puck.setAttribute("aria-expanded", "false");
			fanOpen = false;
			win.clearTimeout(fanTimer);
			fanTimer = win.setTimeout(() => {
				ui.fan.hidden = true;
			}, FAN_HIDE);
			return true;
		}
		function onFanClick(e) {
			const act = (e.target.closest?.("[data-act]"))?.getAttribute("data-act");
			if (act == null) return;
			if (act === "expand") {
				closeFan();
				restore(e.detail === 0);
				return;
			}
			host.onFanAction(act);
		}
		/** Click-away, at the document level: shadow events retarget, so membership
		* is checked via composedPath, not target. */
		function onDocPointerDown(e) {
			if (!fanOpen) return;
			const path = e.composedPath();
			if (path.includes(ui.fan) || path.includes(ui.puck)) return;
			closeFan();
		}
		/** Grabbable at rest and while settling — mid-flight, the spring's current spot is the origin. */
		const grabbable = () => mode === "puck" || mode === "settle";
		const drag = attachDrag(ui.puck, {
			origin: () => {
				if (mode === "settle") return {
					x: main.cur.x,
					y: main.cur.y
				};
				return mode === "puck" ? puckPos : null;
			},
			canStart: grabbable,
			onStart(origin) {
				closeFan();
				mode = "drag";
				if (!host.reduced) {
					ui.puck.classList.add("pb-ghost");
					main.snap({
						x: origin.x,
						y: origin.y,
						w: PUCK,
						h: PUCK,
						r: PUCK / 2
					});
					render();
					showMorph();
				}
			},
			onMove(next) {
				if (host.reduced) {
					const p = clampPos(next);
					placePuck(p.x, p.y);
				} else {
					main.to({
						...next,
						w: PUCK,
						h: PUCK,
						r: PUCK / 2
					}, FOLLOW_SPRING);
					ensureLoop();
				}
			},
			onEnd({ dragged, started, origin }) {
				if (!dragged) {
					if (started && mode === "drag") {
						main.snap({
							x: origin.x,
							y: origin.y,
							w: PUCK,
							h: PUCK,
							r: PUCK / 2
						});
						placePuck(origin.x, origin.y);
						ui.puck.classList.remove("pb-ghost");
						hideMorph();
						mode = "puck";
					}
					if (!closeFan()) openFan();
					return;
				}
				if (host.reduced) {
					if (puckPos) {
						const p = clampPos(puckPos);
						placePuck(p.x, p.y);
						dock = { ...p };
					}
					mode = "puck";
					persist();
					return;
				}
				const p = clampPos({
					x: main.tgt.x,
					y: main.tgt.y
				});
				placePuck(main.cur.x, main.cur.y);
				ui.puck.classList.remove("pb-ghost");
				hideMorph();
				main.to({
					...p,
					w: PUCK,
					h: PUCK,
					r: PUCK / 2
				}, MORPH_SPRING);
				mode = "settle";
				ensureLoop();
			}
		});
		/** Keyboard/AT activation is a synthesized click (detail 0) with no pointer events. */
		function onClick(e) {
			if (e.detail !== 0) return;
			if (!closeFan()) openFan();
		}
		function onResize() {
			closeFan();
			if (mode === "puck" && puckPos !== null) {
				const p = clampPos(puckPos);
				placePuck(p.x, p.y);
			}
			if (dock !== null) dock = clampPos(dock);
		}
		ui.puck.addEventListener("click", onClick);
		ui.fan.addEventListener("click", onFanClick);
		win.document.addEventListener("pointerdown", onDocPointerDown);
		win.addEventListener("resize", onResize);
		return {
			minimized: () => mode !== "bar",
			mode: () => mode,
			minimize,
			restore,
			closeFan,
			applyInitial() {
				if (!loadMinimized()) return;
				const apply = () => {
					if (mode !== "bar") return;
					const d = clampPos(dock ?? defaultDock());
					bar.classList.add("pb-ghost");
					placePuck(d.x, d.y);
					ui.puck.classList.remove("pb-ghost");
					mode = "puck";
					host.onSettled(true, false);
				};
				if (host.reduced) apply();
				else win.requestAnimationFrame(apply);
			},
			destroy() {
				drag.destroy();
				ui.puck.removeEventListener("click", onClick);
				ui.fan.removeEventListener("click", onFanClick);
				win.document.removeEventListener("pointerdown", onDocPointerDown);
				win.removeEventListener("resize", onResize);
				if (raf !== 0) win.cancelAnimationFrame(raf);
				raf = 0;
				win.clearTimeout(holdTimer);
				win.clearTimeout(fadeTimer);
				win.clearTimeout(hideTimer);
				win.clearTimeout(fanTimer);
				ui.fan.hidden = true;
				ui.fan.classList.remove("on");
				fanOpen = false;
			}
		};
	}
	//#endregion
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
	//#region src/ui/multimarks.ts
	const MARK_CLASS = "pb-multi-mark";
	/** Replace the mark set to mirror `targets`; entries with no rect draw nothing. */
	function renderMultiMarks(layer, targets, scroll = {
		x: 0,
		y: 0
	}) {
		for (const node of [...layer.querySelectorAll(`.${MARK_CLASS}`)]) node.remove();
		targets.forEach((target, i) => {
			const rect = target.rect;
			if (rect === void 0) return;
			const mark = layer.ownerDocument.createElement("div");
			mark.className = MARK_CLASS;
			mark.style.left = `${rect.x - scroll.x}px`;
			mark.style.top = `${rect.y - scroll.y}px`;
			mark.style.width = `${rect.width}px`;
			mark.style.height = `${rect.height}px`;
			mark.innerHTML = `<span>${i + 1}</span>`;
			layer.appendChild(mark);
		});
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
		function setOutlineRect(rect) {
			outline.style.left = `${rect.left - 5}px`;
			outline.style.top = `${rect.top - 5}px`;
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
			snap(rect, label) {
				if (!outline.classList.contains("on")) {
					outline.style.transition = "none";
					setOutlineRect(rect);
					outline.offsetWidth;
					outline.style.transition = "";
				} else setOutlineRect(rect);
				lab.textContent = label;
				outline.classList.add("on");
			},
			release() {
				outline.classList.remove("on");
			}
		};
	}
	//#endregion
	//#region src/placement.ts
	function createPlacement(deps) {
		const { win, host, store, pinsLayer } = deps;
		const doc = host.ownerDocument;
		const reticle = createReticle(doc);
		let aim = null;
		let hover = null;
		/** Shift+click accumulation while placing — extra loci for ONE pending pin. */
		let extraTargets = [];
		/** Pending viewport-refresh frame, 0 when none is queued. */
		let viewportFrame = 0;
		const placing = () => store.get().mode === "placing";
		/**
		* Work out what sits under a viewport point and highlight it. Shared by both ways of aiming —
		* following a mouse, and dragging the reticle — so the two can never disagree.
		*/
		function probe(clientX, clientY) {
			const el = hitTest(doc, clientX, clientY, (hit) => hit === host);
			hover = el;
			if (el) reticle.snap(el.getBoundingClientRect(), targetLabel(el));
			else reticle.release();
			aim?.setLabel(el ? targetLabel(el) : "NOTHING UNDER THE PIN");
		}
		/**
		* Bring the drag-aim reticle up with placing mode, seeded mid-screen and already showing what
		* it is over — the first thing you see is a live target, not an empty crosshair.
		*/
		function syncAim(on) {
			if (!aim) return;
			if (!on || !needsDragAim(win)) {
				aim.hide();
				return;
			}
			if (aim.root.classList.contains("on")) {
				if (aim.point.x <= win.innerWidth && aim.point.y <= win.innerHeight) return;
				aim.show(Math.min(aim.point.x, win.innerWidth), Math.min(aim.point.y, win.innerHeight));
				return;
			}
			const { x, y } = startPoint(win);
			aim.show(x, y);
			probe(x, y);
		}
		/** Commit the pin the drag-aim reticle is sitting on. */
		function confirmAim() {
			if (!aim) return;
			probe(aim.point.x, aim.point.y);
			const el = hover ?? doc.body;
			const at = {
				x: aim.point.x + win.scrollX,
				y: aim.point.y + win.scrollY
			};
			store.place({
				target: captureTarget(el, { at }),
				placedAt: at
			});
			reticle.release();
		}
		function drawMarks() {
			renderMultiMarks(pinsLayer, extraTargets, {
				x: win.scrollX,
				y: win.scrollY
			});
		}
		function clearExtraTargets() {
			if (extraTargets.length === 0) return;
			extraTargets = [];
			drawMarks();
		}
		/** Placement click: capture the hovered target (or body) into a client-only draft. */
		function placeDraft(e) {
			e.preventDefault();
			e.stopPropagation();
			const capture = captureTarget(hover ?? doc.body, { at: {
				x: e.pageX,
				y: e.pageY
			} });
			if (extraTargets.length > 0) capture.target.targets = extraTargets;
			clearExtraTargets();
			store.place({
				target: capture,
				placedAt: {
					x: e.pageX,
					y: e.pageY
				}
			});
			reticle.release();
		}
		/** Shift+click while placing: capture WITHOUT committing; a numbered dashed outline is the receipt. */
		function accumulateTarget(e) {
			e.preventDefault();
			e.stopPropagation();
			extraTargets = [...extraTargets, captureTarget(hover ?? doc.body).target];
			drawMarks();
		}
		/**
		* Keep the drag-aim reticle honest while the viewport moves under it — one probe per frame,
		* not per event: momentum scrolling on a phone dispatches faster than frames.
		*/
		const onViewportChange = () => {
			if (!placing() || viewportFrame !== 0) return;
			viewportFrame = win.requestAnimationFrame(() => {
				viewportFrame = 0;
				if (!placing()) return;
				syncAim(true);
				if (aim?.root.classList.contains("on") === true) probe(aim.point.x, aim.point.y);
			});
		};
		const onMouseMove = (e) => {
			if (!placing()) return;
			reticle.move(e);
			probe(e.clientX, e.clientY);
		};
		function mountAim(shadow) {
			shadow.querySelector(".pb-aim")?.remove();
			aim = createAim(doc, {
				onAim: probe,
				onConfirm: confirmAim,
				onCancel: deps.onCancel
			});
			shadow.appendChild(aim.root);
		}
		return {
			outline: reticle.outline,
			crosshair: reticle.crosshair,
			connect(shadow) {
				if (aim === null) mountAim(shadow);
				doc.addEventListener("mousemove", onMouseMove);
				win.addEventListener("scroll", onViewportChange, { passive: true });
				win.addEventListener("resize", onViewportChange);
			},
			disconnect() {
				doc.removeEventListener("mousemove", onMouseMove);
				win.removeEventListener("scroll", onViewportChange);
				win.removeEventListener("resize", onViewportChange);
				if (viewportFrame !== 0) win.cancelAnimationFrame(viewportFrame);
				viewportFrame = 0;
				aim?.destroy();
				aim = null;
			},
			render(on) {
				if (!on) clearExtraTargets();
				if (!on) reticle.release();
				if (on && extraTargets.length > 0) drawMarks();
				syncAim(on);
			},
			handleClick(e) {
				if (needsDragAim(win)) return;
				if (e.shiftKey) accumulateTarget(e);
				else placeDraft(e);
			}
		};
	}
	//#endregion
	//#region src/screenshot.ts
	const WEBP_QUALITY$1 = .7;
	const PLACEHOLDER_MAX$1 = 32;
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
	/**
	* The one live capture stream, reused across pins. getDisplayMedia MUST
	* prompt on every call (spec — no persistent grant exists), so the only way
	* to stop asking per pin is to never re-call it: prompt once, keep the track,
	* and read a fresh frame from the still-playing video for every capture.
	* The browser's "sharing this tab" indicator stays on while the track lives —
	* honest, and the user ending it from there simply re-prompts on the next pin.
	*/
	let liveCapture = null;
	async function captureVideo(win, media) {
		const track = liveCapture?.stream.getVideoTracks()[0];
		if (liveCapture && track?.readyState === "live") return liveCapture.video;
		releaseCapture();
		const stream = await media.getDisplayMedia({
			video: true,
			audio: false,
			preferCurrentTab: true
		});
		const video = await firstFrame(win, stream);
		stream.getVideoTracks()[0]?.addEventListener("ended", releaseCapture, { once: true });
		liveCapture = {
			stream,
			video
		};
		return video;
	}
	/** Stop the cached stream (toolbar disconnect; also the track-ended handler). */
	function releaseCapture() {
		if (liveCapture === null) return;
		for (const t of liveCapture.stream.getTracks()) t.stop();
		liveCapture.video.srcObject = null;
		liveCapture = null;
	}
	/** webp-encode a bitmap; also emit the ≤32px placeholder data URL. */
	async function encode(bmp) {
		const canvas = new OffscreenCanvas(bmp.width, bmp.height);
		canvas.getContext("2d")?.drawImage(bmp, 0, 0);
		const image = {
			blob: await canvas.convertToBlob({
				type: "image/webp",
				quality: WEBP_QUALITY$1
			}),
			width: bmp.width,
			height: bmp.height
		};
		const scale = PLACEHOLDER_MAX$1 / Math.max(bmp.width, bmp.height);
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
		try {
			const video = await captureVideo(win, media);
			const sx = video.videoWidth / win.innerWidth;
			const sy = video.videoHeight / win.innerHeight;
			return await encode(await createImageBitmap(video, Math.round(crop.x * sx), Math.round(crop.y * sy), Math.max(1, Math.round(crop.width * sx)), Math.max(1, Math.round(crop.height * sy))));
		} catch {
			releaseCapture();
			return null;
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
	//#region src/screenshot-dom.ts
	const MAX_NODES = 1500;
	const MAX_EDGE = 1600;
	const WEBP_QUALITY = .7;
	const PLACEHOLDER_MAX = 32;
	/** Elements SVG-as-image cannot render (external resources) — replaced by a same-size box. */
	const REPLACED = /* @__PURE__ */ new Set([
		"IMG",
		"VIDEO",
		"CANVAS",
		"IFRAME",
		"OBJECT",
		"EMBED",
		"PICTURE"
	]);
	function realmOf(el) {
		return el.ownerDocument.defaultView;
	}
	/** Copy every computed property onto the clone so it renders without the page's stylesheets. */
	function inlineStyles(win, source, clone) {
		const cs = win.getComputedStyle(source);
		const style = clone.style;
		if (style === void 0) return;
		let css = "";
		for (let i = 0; i < cs.length; i += 1) {
			const prop = cs[i];
			if (prop === void 0) continue;
			css += `${prop}:${cs.getPropertyValue(prop)};`;
		}
		style.cssText = css;
	}
	/**
	* A same-size neutral box in place of an element the snapshot cannot draw. Keeps the layout
	* honest (the agent sees where the image sits) without a tainted or empty canvas.
	*/
	function placeholderFor(doc, source) {
		const r = source.getBoundingClientRect();
		const box = doc.createElement("span");
		box.style.cssText = `display:inline-block;width:${r.width}px;height:${r.height}px;background:rgba(127,127,127,.25);border-radius:4px;vertical-align:top;`;
		return box;
	}
	/**
	* Deep-clone `root` with computed styles inlined and un-renderable elements replaced.
	* Returns null when the subtree is too large to snapshot responsively.
	*/
	function cloneForSnapshot(root) {
		const doc = root.ownerDocument;
		const win = doc.defaultView;
		if (win === null) return null;
		const sources = [root, ...root.querySelectorAll("*")];
		if (sources.length > MAX_NODES) return null;
		const clone = root.cloneNode(true);
		const clones = [clone, ...clone.querySelectorAll("*")];
		for (let i = 0; i < sources.length; i += 1) {
			const source = sources[i];
			const target = clones[i];
			if (target === void 0) break;
			const keepDataImage = source.tagName === "IMG" && (source.getAttribute("src") ?? "").startsWith("data:");
			if (REPLACED.has(source.tagName) && !keepDataImage) {
				target.replaceWith(placeholderFor(doc, source));
				continue;
			}
			inlineStyles(win, source, target);
		}
		for (const script of clone.querySelectorAll("script")) script.remove();
		return clone;
	}
	/** The SVG document that renders `clone` at the element's size. */
	function svgFor(clone, width, height) {
		return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${new ((realmOf(clone)?.XMLSerializer) ?? XMLSerializer)().serializeToString(clone)}</div></foreignObject></svg>`;
	}
	function loadImage(ImageCtor, url) {
		return new Promise((resolve, reject) => {
			const img = new ImageCtor();
			img.onload = () => resolve(img);
			img.onerror = () => reject(/* @__PURE__ */ new Error("snapshot image failed to load"));
			img.src = url;
		});
	}
	function toBlob(canvas, type, quality) {
		return new Promise((resolve, reject) => {
			canvas.toBlob((b) => b === null ? reject(/* @__PURE__ */ new Error("toBlob")) : resolve(b), type, quality);
		});
	}
	async function rasterize(win, img, width, height) {
		const scale = Math.min(win.devicePixelRatio || 1, 2, MAX_EDGE / Math.max(width, height));
		const canvas = win.document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(width * scale));
		canvas.height = Math.max(1, Math.round(height * scale));
		const ctx = canvas.getContext("2d");
		if (ctx === null) throw new Error("no 2d context");
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		const image = {
			blob: await toBlob(canvas, "image/webp", WEBP_QUALITY),
			width: canvas.width,
			height: canvas.height
		};
		const t = PLACEHOLDER_MAX / Math.max(canvas.width, canvas.height);
		const thumb = win.document.createElement("canvas");
		thumb.width = Math.max(1, Math.round(canvas.width * Math.min(t, 1)));
		thumb.height = Math.max(1, Math.round(canvas.height * Math.min(t, 1)));
		thumb.getContext("2d")?.drawImage(canvas, 0, 0, thumb.width, thumb.height);
		image.placeholder = `data:image/webp;base64,${toBase64(await (await toBlob(thumb, "image/webp", .5)).arrayBuffer())}`;
		return image;
	}
	/**
	* Snapshot `el` without any permission prompt. Resolves null whenever the environment cannot
	* (no canvas/Image, zero-size element, subtree too large, a tainted canvas) — never throws.
	*/
	async function captureElementDom(el) {
		const win = realmOf(el);
		if (win === null || typeof win.Image !== "function" || typeof win.XMLSerializer !== "function") return null;
		const ImageCtor = win.Image;
		const r = el.getBoundingClientRect();
		const width = Math.ceil(r.width);
		const height = Math.ceil(r.height);
		if (width < 1 || height < 1) return null;
		const clone = cloneForSnapshot(el);
		if (clone === null) return null;
		const svg = svgFor(clone, width, height);
		const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
		try {
			return await rasterize(win, await loadImage(ImageCtor, url), width, height);
		} catch {
			return null;
		} finally {
			URL.revokeObjectURL(url);
		}
	}
	/** A session seen more recently than this counts as an agent that is listening. */
	const AGENT_LIVE_MS = 9e5;
	function initialState() {
		return {
			pins: [],
			threads: /* @__PURE__ */ new Map(),
			draft: null,
			mode: "idle",
			activePinId: null,
			inboxOpen: false,
			connection: "connecting",
			queuedIds: /* @__PURE__ */ new Set(),
			minimized: false,
			pinsHidden: false,
			clock: 0,
			agentLive: null,
			captureMode: "dom"
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
					activePinId: null,
					pinsHidden: false
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
	/** Unknown clock, unknown agent — the pre-clock derivation. */
	const NO_VIEW = {
		clock: 0,
		agentLive: null
	};
	/** When the human last spoke on this pin: the last message if it is theirs, else the pin itself. */
	function lastHumanAt(pin, thread) {
		const last = thread[thread.length - 1];
		return Date.parse(last === void 0 ? pin.createdAt : last.at);
	}
	/**
	* How long the agent has owed a reply, as a state the card can draw.
	*
	* Dogfood: a THINKING row spun for two weeks on a pin nobody ever answered, because the row
	* meant only "the last word is yours". Now that means thinking for 90 s, then a quiet WAITING
	* FOR AGENT, then NO RESPONSE after ten minutes — or after those 90 s when the hub reports no
	* agent listening at all. "none" for anything not owed a reply. A 0 clock never goes stale.
	*/
	function pendingKind(pin, thread, view = NO_VIEW) {
		if (pin.status !== "open" || pin.kind === "comment") return "none";
		const last = thread[thread.length - 1];
		if (last !== void 0 && last.role !== "human") return "none";
		if (view.clock === 0) return "thinking";
		const age = view.clock - lastHumanAt(pin, thread);
		if (age < 9e4) return "thinking";
		if (view.agentLive === false || age >= 6e5) return "stale";
		return "waiting";
	}
	/**
	* Wire-status → UI-status mapping:
	* resolved + no verification ⇒ "verify" (accept/reopen prompt);
	* resolved + verification ⇒ "resolved";
	* open comment pin ⇒ "note" (nobody owes a reply — never "waiting");
	* open + reply owed too long (pendingKind "stale") ⇒ "stale";
	* open + empty thread or last message human ⇒ "waiting";
	* open + last message agent|mirror ⇒ "replied".
	* The prototype's WORKING/APPLIED chips need an event vocabulary the hub does not emit — excluded here.
	*/
	function deriveUiStatus(pin, thread, view = NO_VIEW) {
		if (pin.status === "resolved") return pin.verification ? "resolved" : "verify";
		if (pin.kind === "comment") return "note";
		const pending = pendingKind(pin, thread, view);
		if (pending === "stale") return "stale";
		if (pending !== "none") return "waiting";
		return "replied";
	}
	/** Is anyone listening? A session not ended and seen within AGENT_LIVE_MS. */
	function agentIsLive(sessions, now) {
		return sessions.some((s) => s.endedAt === void 0 && now - Date.parse(s.lastSeenAt) < AGENT_LIVE_MS);
	}
	/** Open pins that ask something of someone — comment pins are remarks, so the badges skip them. */
	function openTaskCount(pins) {
		return pins.filter((p) => p.status !== "resolved" && p.kind !== "comment").length;
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
		/** Agent sessions the hub knows, most recently seen first (routes-sessions.ts). */
		listSessions() {
			return this.#request("GET", "/sessions");
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
		/** Bumped per `GET /sessions`; only the newest request's snapshot reaches `onSessions`. */
		#sessionsGen = 0;
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
			this.#refreshSessions();
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
		/** Best-effort: a hub without the route (or unreachable) simply leaves liveness unknown.
		* Reconnects can overlap; a slow older GET must not overwrite a newer snapshot, so only
		* the latest request applies. */
		async #refreshSessions() {
			if (this.#opts.onSessions === void 0) return;
			this.#sessionsGen += 1;
			const gen = this.#sessionsGen;
			try {
				const sessions = await this.#rest.listSessions();
				if (gen === this.#sessionsGen) this.#opts.onSessions(sessions);
			} catch {}
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
	//#region src/ui/bar.ts
	const IDENT_ICON = "<svg width=\"15\" height=\"15\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"var(--pb-amber)\" stroke-width=\"1.4\"><rect x=\"2.5\" y=\"1.5\" width=\"11\" height=\"7\" rx=\"1\"/><path d=\"M8 8.5v6\"/><circle cx=\"8\" cy=\"14.6\" r=\".9\" fill=\"var(--pb-amber)\" stroke=\"none\"/></svg>";
	const GRIP_ICON = "<svg width=\"6\" height=\"14\" viewBox=\"0 0 6 14\" fill=\"currentColor\"><circle cx=\"1.5\" cy=\"2\" r=\"1.1\"/><circle cx=\"4.5\" cy=\"2\" r=\"1.1\"/><circle cx=\"1.5\" cy=\"7\" r=\"1.1\"/><circle cx=\"4.5\" cy=\"7\" r=\"1.1\"/><circle cx=\"1.5\" cy=\"12\" r=\"1.1\"/><circle cx=\"4.5\" cy=\"12\" r=\"1.1\"/></svg>";
	const CONNECTION_LABEL = {
		connecting: "PINBOX",
		live: "PINBOX",
		offline: "PINBOX · OFFLINE",
		incompatible: "PINBOX · UPDATE NEEDED"
	};
	/** `data-ref` per action: the element focuses "min" after a keyboard restore. */
	function refOf(a) {
		return a.id === "minimize" ? "min" : a.id;
	}
	function buttonHtml(a) {
		const bar = a.bar;
		const glyph = a.glyph === void 0 ? "" : icon(a.glyph, 14);
		const body = bar.count ? `${glyph}<span data-ref="count">0</span>` : `${glyph}${bar.text ?? ""}`;
		const square = bar.text === void 0 && !bar.count;
		const aria = bar.ariaLabel === void 0 ? "" : ` aria-label="${bar.ariaLabel}"`;
		return `<button type="button" class="pb-tb${square ? " sq" : ""}" data-ref="${refOf(a)}" title="${titleOf(a)}"${aria}>${a.glyph === void 0 ? a.key ?? "" : body}</button>`;
	}
	function createBar(doc, on) {
		const root = doc.createElement("div");
		root.className = "pb-bar";
		const wide = ACTIONS.filter((a) => a.bar !== void 0 && (a.bar.text !== void 0 || a.bar.count));
		const squares = ACTIONS.filter((a) => a.bar !== void 0 && !wide.includes(a));
		root.innerHTML = `<div class="armed-ring"></div><div class="grip" data-ref="grip" title="Drag to move · double-click to reset">${GRIP_ICON}</div><div class="ident">${IDENT_ICON}<span class="bl" data-ref="label">PINBOX</span></div><div class="div"></div>` + wide.map(buttonHtml).join("") + "<div class=\"div\" style=\"margin:0 3px\"></div>" + squares.map(buttonHtml).join("");
		const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
		const label = ref("label");
		const pinBtn = ref("pin");
		const inboxBtn = ref("inbox");
		const hideBtn = ref("hide");
		const captureBtn = ref("capture");
		const count = ref("count");
		for (const a of [...wide, ...squares]) ref(refOf(a)).addEventListener("click", (e) => on.onAction(a.id, e.detail === 0));
		/** Last-rendered hide state; the glyph is swapped only on change. */
		let hideShown = null;
		return {
			root,
			grip: ref("grip"),
			update(state) {
				const text = state.mode === "placing" ? "CLICK TO PIN" : CONNECTION_LABEL[state.connection];
				if (label.textContent !== text) label.textContent = text;
				pinBtn.classList.toggle("hot", state.mode === "placing");
				inboxBtn.classList.toggle("lit", state.inboxOpen);
				const open = String(openTaskCount(state.pins));
				if (count.textContent !== open) count.textContent = open;
				captureBtn.classList.toggle("lit", state.captureMode === "tab");
				captureBtn.title = state.captureMode === "tab" ? "Tab capture on — real pixels, Chrome asks once per page load (S)" : "Screenshots: DOM snapshot, no prompt — press for tab capture (S)";
				if (hideShown !== state.pinsHidden) {
					hideShown = state.pinsHidden;
					hideBtn.innerHTML = icon(state.pinsHidden ? EYE_GLYPH : EYE_OFF_GLYPH, 14);
					hideBtn.classList.toggle("lit", state.pinsHidden);
					hideBtn.title = state.pinsHidden ? "Show pins (H)" : "Hide pins (H)";
				}
			}
		};
	}
	//#endregion
	//#region src/ui/bar-drag.ts
	const MARGIN = 16;
	function createBarDrag(host) {
		const { win, bar, grip } = host;
		const key = `${host.storagePrefix}:bar`;
		let pos = readPoint(host.storage, key);
		/** Where the bar was when a press began, so a tap-sized wobble snaps back. */
		let before = null;
		function persist() {
			try {
				if (pos === null) host.storage?.removeItem(key);
				else host.storage?.setItem(key, JSON.stringify(pos));
			} catch {}
		}
		function box() {
			const r = bar.getBoundingClientRect();
			return {
				w: r.width,
				h: r.height
			};
		}
		function apply(p) {
			pos = p;
			bar.classList.toggle("free", p !== null);
			bar.style.left = p === null ? "" : `${p.x}px`;
			bar.style.top = p === null ? "" : `${p.y}px`;
		}
		const drag = attachDrag(grip, {
			origin: () => {
				if (bar.classList.contains("pb-ghost")) return null;
				const r = bar.getBoundingClientRect();
				return {
					x: r.left,
					y: r.top
				};
			},
			canStart: () => !bar.classList.contains("pb-ghost"),
			onStart() {
				before = pos;
				bar.classList.add("dragging");
			},
			onMove(next) {
				apply(clampToViewport(next, win, box(), MARGIN));
			},
			onEnd({ dragged, started }) {
				bar.classList.remove("dragging");
				if (dragged) persist();
				else if (started) apply(before);
			}
		});
		function reset() {
			apply(null);
			persist();
		}
		function onResize() {
			if (pos !== null) apply(clampToViewport(pos, win, box(), MARGIN));
		}
		grip.addEventListener("dblclick", reset);
		win.addEventListener("resize", onResize);
		if (pos !== null) apply(clampToViewport(pos, win, box(), MARGIN));
		return {
			position: () => pos,
			reset,
			destroy() {
				drag.destroy();
				grip.removeEventListener("dblclick", reset);
				win.removeEventListener("resize", onResize);
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
	//#region src/ui/card-messages.ts
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
	/** "claude:lark-mac-agent" → "Claude · lark-mac-agent"; other shapes verbatim. */
	function agentName(origin) {
		const idx = origin.indexOf(":");
		if (idx <= 0) return origin;
		const agent = origin.slice(0, idx);
		return `${agent.charAt(0).toUpperCase()}${agent.slice(1)} · ${origin.slice(idx + 1)}`;
	}
	function messageHtml(m) {
		if (m.role === "agent") return `<div class="pb-msg"><div class="pb-av agent">AI</div><div class="col"><div class="line"><span class="who">${esc(m.origin === void 0 ? "Agent" : agentName(m.origin))}</span><span class="tm">${esc(timeOf(m.at))}</span></div><div class="txt">${esc(m.text)}</div>${attachmentsHtml(m)}</div></div>`;
		const mirror = m.role === "mirror";
		const origin = mirror ? m.origin ?? "mirror" : null;
		const who = origin ? origin.split(":")[1] ?? origin : "You";
		const initials = who.slice(0, 2).toUpperCase();
		const via = origin ? `<span class="via-tag"><span>${esc(origin)}</span></span>` : "";
		return `<div class="pb-msg you"><div class="pb-av${mirror ? " via" : ""}">${esc(initials)}</div><div class="col"><div class="line"><span class="who">${esc(who)}</span><span class="tm">${esc(timeOf(m.at))}</span>${via}</div><div class="txt">${esc(m.text)}</div>${attachmentsHtml(m)}</div></div>`;
	}
	/** The agent has the message and has not answered yet. Its own node, so patching never rebuilds. */
	const PENDING_HTML = {
		thinking: "<div class=\"pb-typing\"><div class=\"pb-av agent\">AI</div><div class=\"dots\"><i></i><i></i><i></i></div><div class=\"lbl\">THINKING</div></div>",
		waiting: "<div class=\"pb-typing quiet\"><div class=\"pb-av agent\">AI</div><div class=\"lbl\">WAITING FOR AGENT</div></div>"
	};
	/**
	* Show, restyle or hide the "working on it" row.
	*
	* Without it the card sits silent from the moment you comment until the answer lands, which reads
	* as nothing happening — the single most common report on the demo. With it forever, a pin nobody
	* answers "thinks" for two weeks (dogfood) — so the row has stages, and "stale"/"none" remove it
	* (the stale footer takes over, card-parts.ts).
	*/
	function patchPending(threadEl, kind) {
		const existing = threadEl.querySelector("[data-iid=\"pb-typing\"]");
		if (kind === "none" || kind === "stale") {
			existing?.remove();
			return;
		}
		const html = PENDING_HTML[kind];
		if (existing) {
			if (nodeMemo.get(existing) !== html) {
				existing.innerHTML = html;
				nodeMemo.set(existing, html);
			}
			threadEl.appendChild(existing);
			return;
		}
		const node = threadEl.ownerDocument.createElement("div");
		node.className = "pb-msg-w";
		node.setAttribute("data-iid", "pb-typing");
		node.innerHTML = html;
		nodeMemo.set(node, html);
		threadEl.appendChild(node);
		threadEl.scrollTop = threadEl.scrollHeight;
	}
	/** Keyed thread patching: appends/patches [data-iid] nodes only, never rebuilds. */
	function patchThread(threadEl, messages) {
		let appended = false;
		for (const m of messages) {
			let node = [...threadEl.children].find((c) => c.getAttribute("data-iid") === m.id) ?? null;
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
	//#endregion
	//#region src/ui/card-parts.ts
	const STATUS_LABEL = {
		open: "OPEN",
		waiting: "OPEN",
		replied: "REPLIED",
		resolved: "RESOLVED",
		verify: "VERIFY",
		note: "NOTE",
		stale: "NO RESPONSE"
	};
	const CHECK_ICON$1 = "<svg width=\"13\" height=\"13\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M3 8.5l3.2 3.2L13 4.8\"/></svg>";
	const X_ICON$1 = "<svg width=\"13\" height=\"13\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M4 4l8 8M12 4l-8 8\"/></svg>";
	const COPY_ICON = "<svg width=\"13\" height=\"13\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.4\"><rect x=\"5.5\" y=\"5.5\" width=\"8\" height=\"8\" rx=\"1\"/><path d=\"M10.5 3.5v-1a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h1\"/></svg>";
	function hdHtml(n, targetLabel, status, resolvable, copyable) {
		return `<div class="meta"><span class="num">${pinNumber(n)}</span><span>${esc(targetLabel)}</span><span class="st">${esc(status)}</span></div><div style="display:flex;gap:2px">` + (copyable ? `<button type="button" class="pb-ico" data-action="copy" title="Copy this pin">${COPY_ICON}</button>` : "") + (resolvable ? `<button type="button" class="pb-ico ok" data-action="resolve" title="Resolve (R)">${CHECK_ICON$1}</button>` : "") + `<button type="button" class="pb-ico" data-action="close" title="Close (Esc)">${X_ICON$1}</button></div>`;
	}
	/** One name per locus: selector first, else anchor, else tag. */
	function locusName(t) {
		return t.selector ?? t.anchor ?? t.tag?.toUpperCase();
	}
	/** The extra loci of a multi-target pin — the anchor leads, extras follow. */
	function lociHtml(pin) {
		const target = pin?.target;
		const extras = target?.targets;
		if (target === void 0 || extras === void 0 || extras.length === 0) return "";
		const names = [target, ...extras].map((t) => esc(locusName(t) ?? "?"));
		return `<div class="pb-loci">${names.length} targets: ${names.join(" · ")}</div>`;
	}
	/** Link badge: pin.links[0] read-only — no picker, no unlink yet. */
	function linkHtml(pin) {
		const link = pin?.links?.[0];
		if (!link) return "";
		return `<div class="pb-linkbar"><span class="ch">${esc(link.connector)}</span><span class="mt">${esc(link.ref)}</span><span class="sp"></span><a class="pb-open" href="${esc(safeUrl(link.url))}" target="_blank" rel="noreferrer">OPEN</a></div>`;
	}
	/**
	* Who resolved the pin and what they said. The schema has carried `resolution.note` and
	* `.commit` since v1 (agents write them); the card never showed either, so a resolved pin
	* read as bare "RESOLVED" with the why one CLI call away.
	*/
	function resolutionHtml(pin) {
		const r = pin?.resolution;
		if (pin === null || r === void 0 || pin.status !== "resolved") return "";
		return `<div class="pb-resnote">Resolved by ${r.by === "agent" ? "agent" : "you"}${r.note === void 0 ? "" : ` · ${esc(r.note)}`}${r.commit === void 0 ? "" : ` <span class="hh">${esc(r.commit.slice(0, 7))}</span>`}</div>`;
	}
	/**
	* The pin has waited too long. Nudge re-posts your last message so a watcher re-triggers;
	* Resolve clears it — the two things you can actually do about a silent agent.
	*/
	function staleHtml(status) {
		if (status !== "stale") return "";
		return "<div class=\"pb-stale\"><span class=\"msg\">No agent has answered. It may not be running.</span><button type=\"button\" class=\"pb-bt-ghost\" data-action=\"nudge\" title=\"Re-send your last message\">Nudge</button><button type=\"button\" class=\"pb-bt-ok\" data-action=\"resolve\">Resolve</button></div>";
	}
	function verifyHtml(status) {
		if (status === "verify") return "<div class=\"pb-verify\"><button type=\"button\" class=\"pb-bt-ok\" data-action=\"verify-accept\">Looks good</button><button type=\"button\" class=\"pb-bt-ghost\" data-action=\"verify-reopen\">Reopen</button></div>";
		if (status === "resolved") return "<div class=\"pb-verify\"><button type=\"button\" class=\"pb-bt-ghost\" data-action=\"verify-reopen\">Unresolve</button></div>";
		return "";
	}
	/**
	* The composer row. A draft chooses what it is before it exists: "Ask agent" (the default —
	* a `note` pin an agent picks up) or "Note" (a `comment` pin, a remark for people that never
	* wakes an agent). A control on the draft, not a global toggle: a mode you set once and forget
	* makes the next pin silently the wrong kind.
	*/
	function rowHtml(hasThread, isDraft, kind) {
		return `${isDraft ? `<div class="pb-seg" role="radiogroup" aria-label="Pin kind"><button type="button" role="radio" aria-checked="${kind === "note"}" class="${kind === "note" ? "on" : ""}" data-kind="note" title="An agent picks this up">Ask agent</button><button type="button" role="radio" aria-checked="${kind === "comment"}" class="${kind === "comment" ? "on" : ""}" data-kind="comment" title="A remark for people; no agent acts on it">Note</button></div>` : ""}<div class="pb-kbd">⌘ ↵</div><button type="button" class="pb-bt-solid" data-action="send">${hasThread ? "Reply" : kind === "comment" ? "Leave note" : "Comment"}</button>`;
	}
	//#endregion
	//#region src/ui/pins.ts
	/** The prototype's `_h` innerHTML memo, kept off the DOM node. */
	const chipMemo = /* @__PURE__ */ new WeakMap();
	/** What the hub will number the next pin: max known `n`, else the pin count. */
	function nextOrdinal(pins) {
		return Math.max(pins.length, ...pins.map((p) => p.n ?? 0)) + 1;
	}
	/**
	* Does the pin's captured URL still describe the view on screen? Path + search
	* only — hashes are anchors, not views. An absent or unparseable URL never
	* gates: old pins (and CLI pins) keep rendering exactly as before.
	*/
	function sameView(win, url) {
		if (url === void 0) return true;
		try {
			const target = new URL(url, win.location.href);
			return target.pathname === win.location.pathname && target.search === win.location.search;
		} catch {
			return true;
		}
	}
	/** A stored (document-space) rect or point, in today's viewport. */
	function toViewport(win, p) {
		return {
			...p,
			x: p.x - win.scrollX,
			y: p.y - win.scrollY
		};
	}
	/**
	* Where the pin's anchor is NOW, in VIEWPORT space (dogfood #26: markers lingered over
	* unrelated views after SPA tab switches, because placement trusted the stored rect forever;
	* dogfood v4: pins drifted on scroll, because the layer was document-space and only
	* re-rendered on DOM mutation). Re-resolve the captured selector on every render:
	*  - it resolves with layout → the LIVE client rect, which is right inside inner scroll
	*    containers and on sticky/fixed anchors alike;
	*  - it resolves without layout (test DOMs, display:none) → stored rect minus scroll;
	*  - it does not resolve → no marker; the drawer stays the see-everything list.
	* A pin with no selector (terminal-adjacent) keeps its stored rect, as before.
	*/
	function anchorRect(doc, pin) {
		return targetRect(doc, pin.target);
	}
	/** The same resolution for any captured target — a pin's, or the draft's before it commits. */
	function targetRect(doc, target) {
		const stored = target?.rect;
		if (stored === void 0) return null;
		const win = doc.defaultView;
		if (win === null) return stored;
		if (!sameView(win, target?.url)) return null;
		const selector = target?.selector;
		if (selector === void 0) return toViewport(win, stored);
		let el;
		try {
			el = doc.querySelector(selector);
		} catch {
			return toViewport(win, stored);
		}
		if (el === null) return null;
		const r = el.getBoundingClientRect();
		if (r.width <= 0 && r.height <= 0) return toViewport(win, stored);
		return clipToScrollAncestors(win, el, {
			x: r.left,
			y: r.top,
			width: r.width,
			height: r.height
		});
	}
	const CLIPPING = /* @__PURE__ */ new Set([
		"auto",
		"scroll",
		"hidden",
		"clip"
	]);
	/**
	* The part of `rect` an ancestor scroll container actually shows. A row scrolled out of its
	* pane has a live client rect above or below the pane; drawing a marker there floats it over
	* unrelated content (dogfood: the draft on Record 12 sat on the heading once the pane scrolled).
	* Null when nothing of the element is visible; the drawer still lists the pin.
	*/
	function clipToScrollAncestors(win, el, rect) {
		let out = rect;
		for (let p = el.parentElement; p !== null && p !== win.document.body; p = p.parentElement) {
			const cs = win.getComputedStyle(p);
			if (![
				cs.overflow,
				cs.overflowX,
				cs.overflowY
			].some((v) => CLIPPING.has(v))) continue;
			const c = p.getBoundingClientRect();
			if (c.width <= 0 && c.height <= 0) continue;
			const x1 = Math.max(out.x, c.left);
			const y1 = Math.max(out.y, c.top);
			const x2 = Math.min(out.x + out.width, c.right);
			const y2 = Math.min(out.y + out.height, c.bottom);
			if (x2 <= x1 || y2 <= y1) return null;
			out = {
				x: x1,
				y: y1,
				width: x2 - x1,
				height: y2 - y1
			};
		}
		return out;
	}
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
	/**
	* Where the draft marker sits: its captured element's LIVE rect at the clicked spot, exactly as a
	* committed pin would (a draft on a sticky header must ride the header while you type). Null when
	* the element is scrolled out of its container or gone — no marker, and the card docks
	* (card.ts) instead of floating over whatever now occupies the stale point.
	*/
	function draftPoint(doc, draft) {
		const target = draft.target.target;
		const live = targetRect(doc, target);
		return live === null ? null : pinPoint(live, target.spot);
	}
	/** Chip contents (prototype chipBtnInner, lines 546–550): number + linked-channel tag,
	* plus the queued badge while the pin waits in the outbox for the reconnect flush. */
	function chipInner(n, pin, queued = false, stale = false) {
		const link = pin?.links?.[0];
		const badge = link ? `<span class="lk"><span>${esc(link.connector)}</span></span>` : "";
		const qd = queued ? "<span class=\"qd\">QUEUED</span>" : stale ? "<span class=\"qd\">NO REPLY</span>" : "";
		const nt = pin?.kind === "comment" ? "<span class=\"nt\" title=\"Note — no agent acts on this\">N</span>" : "";
		return `<span>${pinNumber(n)}</span>${nt}${badge}${qd}`;
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
		layer.hidden = state.pinsHidden;
		if (state.pinsHidden) return;
		const visible = state.pins.filter((p) => p.status !== "resolved" || p.id === state.activePinId);
		const placed = [];
		visible.forEach((pin, i) => {
			const rect = anchorRect(layer.ownerDocument, pin);
			if (rect === null) return;
			const spot = pin.target?.spot;
			const n = pin.n ?? i + 1;
			placed.push(spot === void 0 ? {
				pin,
				n,
				rect
			} : {
				pin,
				n,
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
			node.classList.toggle("note", pin.kind === "comment");
			const stale = deriveUiStatus(pin, state.threads.get(pin.id) ?? [], state) === "stale";
			node.classList.toggle("stale", stale);
			patchNode(node, pinPoint(rect, spot), hot, chipInner(n, pin, queued, stale));
		}
		const draftAt = state.draft ? draftPoint(layer.ownerDocument, state.draft) : null;
		if (draftAt === null) layer.querySelector("[data-pin=\"draft\"]")?.remove();
		if (state.draft && draftAt !== null) patchNode(ensureNode(layer, "draft", true), draftAt, true, chipInner(nextOrdinal(state.pins), null));
	}
	//#endregion
	//#region src/ui/card.ts
	const ctxByCard = /* @__PURE__ */ new WeakMap();
	/** .pb-card width (styles.ts). */
	const CARD_W = 344;
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
				actions: null,
				draftKind: "note"
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
		ctx.actions.send(ctx.pid === "draft" ? "draft" : ctx.pid, text, ctx.draftKind);
		ta.value = "";
	}
	/** The draft's kind control: pick, redraw the row, keep typing. */
	function onKindPick(card, ctx, kind) {
		ctx.draftKind = kind;
		setPart(card, ctx, "row", rowHtml(false, true, kind));
		card.querySelector("textarea")?.focus();
	}
	/** A moment of green on the copy button is the whole receipt — there is no toast layer,
	* and the header part-memo never resets a class toggle. */
	function flashCopied(card, from) {
		const btn = from.closest?.("[data-action=\"copy\"]");
		if (!btn) return;
		btn.classList.add("ok");
		card.ownerDocument.defaultView?.setTimeout(() => btn.classList.remove("ok"), 900);
	}
	/** Actions that need a committed pin (a draft has no id to act on). */
	const PIN_ACTIONS = {
		resolve: (_card, ctx, pid) => ctx.actions.resolve(pid),
		nudge: (_card, ctx, pid) => ctx.actions.nudge(pid),
		copy: (card, ctx, pid, from) => {
			ctx.actions.copy(pid);
			flashCopied(card, from);
		},
		"verify-accept": (_card, ctx, pid) => ctx.actions.verify(pid, "accepted"),
		"verify-reopen": (card, ctx, pid) => {
			ctx.actions.verify(pid, "reopened");
			card.querySelector("textarea")?.focus();
		}
	};
	function onCardClick(card, ctx, e) {
		const from = e.target;
		const kind = from.closest?.("[data-kind]")?.getAttribute("data-kind");
		if (kind === "note" || kind === "comment") {
			onKindPick(card, ctx, kind);
			return;
		}
		const action = from.closest?.("[data-action]")?.getAttribute("data-action");
		if (!action || !ctx.pid) return;
		if (action === "send") {
			submit(card, ctx);
			return;
		}
		if (action === "close") {
			ctx.actions.close();
			return;
		}
		if (ctx.pid !== "draft") PIN_ACTIONS[action]?.(card, ctx, ctx.pid, from);
	}
	function buildSkeleton(card, ctx, isDraft, hasThread) {
		card.innerHTML = "<div class=\"in\"><div class=\"pb-hd\" data-ref=\"hd\"></div><div data-ref=\"link\"></div><div data-ref=\"loci\"></div><div class=\"pb-thread\" data-ref=\"thread\"></div><div data-ref=\"verify\"></div><div class=\"pb-composer\"><textarea rows=\"2\"></textarea><div class=\"row\" data-ref=\"row\"></div></div></div>";
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
	/**
	* Viewport-aware placement, ported from the prototype (lines 660–668) into viewport space:
	* measure the rendered card, flip left when it would overflow right, clamp between the margin
	* and the command-bar clearance — never off-screen.
	*/
	function position(card, at) {
		const win = card.ownerDocument.defaultView;
		if (!win) return;
		const W = CARD_W;
		const m = 12;
		const barClear = 84;
		let left = at.x + 22;
		if (left + W > win.innerWidth - m) left = at.x - W - 22;
		left = Math.max(m, left);
		const h = card.querySelector(".in")?.offsetHeight ?? 0;
		const minTop = m;
		const maxTop = win.innerHeight - h - barClear;
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
	/** The pin's hub-born number; visible-index only for pre-`n` pins, drafts next up. */
	function ordinalOf(state, pin) {
		if (pin === null) return nextOrdinal(state.pins);
		if (pin.n !== void 0) return pin.n;
		return state.pins.filter((p) => p.status !== "resolved" || p.id === state.activePinId).indexOf(pin) + 1;
	}
	/**
	* Where the card tethers, in viewport space. The LIVE anchor when the pin's element is on this
	* view; otherwise (other URL, selector gone, a terminal `pinbox pin`) the middle of the viewport
	* — dogfood: the stored rect of a pin whose view had moved on put the card off-screen, so a pin
	* listed in the drawer could be opened but never seen, let alone resolved.
	*/
	function anchorOf(root, pin, draft) {
		const doc = root.ownerDocument;
		const win = doc.defaultView;
		let live = null;
		if (pin !== null) {
			const r = anchorRect(doc, pin);
			live = r === null ? null : {
				x: r.x + r.width / 2,
				y: r.y + r.height / 2
			};
		} else if (draft !== null) live = draftPoint(doc, draft);
		else return {
			x: 0,
			y: 0
		};
		if (live !== null) return live;
		if (win === null) return {
			x: 0,
			y: 0
		};
		return {
			x: win.innerWidth / 2 - CARD_W / 2 - 22,
			y: win.innerHeight / 3 + 60
		};
	}
	/**
	* The card's heading. A terminal `pinbox pin` has no anchor and no tag, so "PIN"
	* labels the card without claiming an element that was never captured.
	*/
	function labelOf(target) {
		return target?.anchor ?? target?.tag?.toUpperCase() ?? "PIN";
	}
	function viewOf(root, state) {
		const pin = activePin(state);
		const pid = pin?.id ?? (state.draft ? "draft" : null);
		if (!pid) return null;
		const thread = pin ? state.threads.get(pin.id) ?? [] : [];
		return {
			pid,
			pin,
			thread,
			n: ordinalOf(state, pin),
			status: pin ? deriveUiStatus(pin, thread, state) : null,
			label: labelOf(pin?.target ?? state.draft?.target.target),
			at: anchorOf(root, pin, state.draft)
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
		const view = viewOf(root, state);
		if (!view) {
			card.hidden = true;
			ctx.pid = null;
			return;
		}
		if (ctx.pid !== view.pid) {
			ctx.pid = view.pid;
			ctx.parts = {};
			ctx.draftKind = "note";
			buildSkeleton(card, ctx, view.pid === "draft", view.pin !== null || view.thread.length > 0);
		}
		card.hidden = false;
		const queued = view.pin !== null && state.queuedIds.has(view.pin.id);
		const statusLabel = queued ? "QUEUED" : view.status ? STATUS_LABEL[view.status] : "NEW";
		const resolvable = view.pin?.status === "open" && !queued;
		setPart(card, ctx, "hd", hdHtml(view.n, view.label, statusLabel, resolvable, view.pin !== null));
		setPart(card, ctx, "link", linkHtml(view.pin));
		setPart(card, ctx, "loci", lociHtml(view.pin));
		setPart(card, ctx, "verify", resolutionHtml(view.pin) + staleHtml(view.status) + verifyHtml(view.status));
		const messages = view.pin === null ? view.thread : [pinAsMessage(view.pin), ...view.thread];
		setPart(card, ctx, "row", rowHtml(messages.length > 0, view.pid === "draft", ctx.draftKind));
		const threadEl = card.querySelector("[data-ref=\"thread\"]");
		if (threadEl) {
			patchThread(threadEl, messages);
			patchPending(threadEl, queued || view.pin === null ? "none" : pendingKind(view.pin, view.thread, state));
		}
		position(card, view.at);
	}
	//#endregion
	//#region src/ui/drawer.ts
	const X_ICON = "<svg width=\"13\" height=\"13\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M4 4l8 8M12 4l-8 8\"/></svg>";
	const CHECK_ICON = "<svg width=\"13\" height=\"13\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M3 8.5l3.2 3.2L13 4.8\"/></svg>";
	const UNDO_ICON = "<svg width=\"13\" height=\"13\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M3.5 7.5h6a3 3 0 010 6H6\"/><path d=\"M6 4.5l-3 3 3 3\"/></svg>";
	/** How long a first click on Resolve-group waits for its confirming second click. */
	const CONFIRM_MS = 3e3;
	const STATUS_TEXT = {
		open: "OPEN",
		waiting: "OPEN",
		replied: "REPLIED",
		resolved: "RESOLVED",
		verify: "VERIFY",
		note: "NOTE",
		stale: "NO RESPONSE"
	};
	const STATUS_DOT = {
		open: "var(--pb-fg4)",
		waiting: "var(--pb-fg4)",
		replied: "var(--pb-info)",
		resolved: "var(--pb-ok)",
		verify: "var(--pb-amber)",
		note: "var(--pb-fg3)",
		stale: "var(--pb-amber)"
	};
	/**
	* The place a row names. A browser pin has a selector; a terminal `pinbox pin` has a
	* source anchor instead; a pin created with no anchor at all names nowhere.
	*/
	function locusOf(pin) {
		return pin.target?.selector ?? pin.target?.source?.file ?? "";
	}
	/** "github#58" — the same label `pinbox link` prints. */
	function linkKey(pin) {
		const link = pin.links?.[0];
		return link === void 0 ? null : `${link.connector}#${link.ref}`;
	}
	function itemHtml(pin, n, active, thread, queued, view) {
		const status = deriveUiStatus(pin, thread, view);
		const link = pin.links?.[0];
		const act = pin.status === "resolved" ? `<button type="button" class="pb-ico" data-act="unresolve" title="Unresolve">${UNDO_ICON}</button>` : queued ? "" : `<button type="button" class="pb-ico ok" data-act="resolve" title="Resolve">${CHECK_ICON}</button>`;
		return `<div class="pb-item${active ? " on" : ""}" data-item="${esc(pin.id)}"><button type="button" class="pb-item-main" data-open="${esc(pin.id)}"><span class="nn">${pinNumber(n)}</span><span class="cc"><span class="tt">${esc(pin.text)}</span><span class="mm"><span class="sdot" style="background:${queued ? "var(--pb-amber)" : STATUS_DOT[status]}"></span><span>${queued ? "QUEUED" : STATUS_TEXT[status]}</span>` + (link ? `<span class="lk">${esc(link.connector)}</span>` : "") + `<span>${esc(locusOf(pin))}</span></span></span></button><span class="acts">${act}</span></div>`;
	}
	function groupHtml(key, pins, confirming) {
		const link = pins[0]?.links?.[0];
		const open = link ? `<a class="pb-open" href="${esc(safeUrl(link.url))}" target="_blank" rel="noreferrer">OPEN</a>` : "";
		const label = confirming ? "CONFIRM?" : `RESOLVE ${pins.length}`;
		return `<div class="pb-group"><span class="gk">${esc(link?.connector ?? "")}</span><span class="gr">#${esc(link?.ref ?? "")}</span><span class="sp"></span>${open}<button type="button" class="pb-gres${confirming ? " confirm" : ""}" data-group-resolve="${esc(key)}" title="Resolve every pin linked to ${esc(key)}">${label}</button></div>`;
	}
	/** Open pins split into the ungrouped list and one group per tracker item, in first-seen order. */
	function groupByLink(open) {
		const loose = [];
		const groups = /* @__PURE__ */ new Map();
		for (const pin of open) {
			const key = linkKey(pin);
			if (key === null) loose.push(pin);
			else groups.set(key, [...groups.get(key) ?? [], pin]);
		}
		return {
			loose,
			groups
		};
	}
	function createDrawer(doc, on) {
		const root = doc.createElement("div");
		root.className = "pb-drawer";
		root.hidden = true;
		root.innerHTML = `<div class="dh"><span>INBOX</span><button type="button" class="pb-ico" data-ref="close" title="Close">${X_ICON}</button></div><div class="pb-tabs"><button type="button" class="pb-tab on" data-tab="open">OPEN · 0</button><button type="button" class="pb-tab" data-tab="notes">NOTES · 0</button><button type="button" class="pb-tab" data-tab="resolved">RESOLVED · 0</button></div><div class="pb-items" data-ref="items"></div><div class="pb-dfoot" data-ref="foot" hidden></div>`;
		let tab = "open";
		let last = null;
		let itemsMemo = "";
		/** Group key awaiting its confirming click, if any. */
		let confirming = null;
		let confirmTimer = 0;
		const items = root.querySelector("[data-ref=\"items\"]");
		const foot = root.querySelector("[data-ref=\"foot\"]");
		let footMemo = "";
		const tabButtons = [...root.querySelectorAll("[data-tab]")];
		const win = doc.defaultView;
		root.querySelector("[data-ref=\"close\"]")?.addEventListener("click", on.onClose);
		for (const btn of tabButtons) btn.addEventListener("click", () => {
			tab = btn.getAttribute("data-tab");
			if (last) render(last);
		});
		function setConfirming(key) {
			confirming = key;
			win?.clearTimeout(confirmTimer);
			if (key !== null) confirmTimer = win?.setTimeout(() => setConfirming(null), CONFIRM_MS) ?? 0;
			if (last) render(last);
		}
		function resolveGroup(key) {
			if (confirming !== key) {
				setConfirming(key);
				return;
			}
			setConfirming(null);
			const pins = last?.pins.filter((p) => p.status === "open" && linkKey(p) === key) ?? [];
			for (const pin of pins) on.onResolve(pin.id, `shipped in ${key}`);
		}
		/** Every open pin the agent never answered (dogfood #6–10): one click clears the backlog. */
		function stalePins(state) {
			return state.pins.filter((p) => p.status === "open" && !state.queuedIds.has(p.id) && deriveUiStatus(p, state.threads.get(p.id) ?? [], state) === "stale");
		}
		function resolveStale() {
			if (confirming !== "stale") {
				setConfirming("stale");
				return;
			}
			setConfirming(null);
			for (const pin of last ? stalePins(last) : []) on.onResolve(pin.id, "no agent response");
		}
		foot.addEventListener("click", (e) => {
			if (e.target.closest?.("[data-bulk]")) resolveStale();
		});
		items.addEventListener("click", (e) => {
			const target = e.target;
			const act = target.closest?.("[data-act]");
			if (act) {
				const id = act.closest("[data-item]")?.getAttribute("data-item");
				if (!id) return;
				if (act.getAttribute("data-act") === "resolve") on.onResolve(id);
				else on.onUnresolve(id);
				return;
			}
			const group = target.closest?.("[data-group-resolve]")?.getAttribute("data-group-resolve");
			if (group) {
				resolveGroup(group);
				return;
			}
			const id = target.closest?.("[data-open]")?.getAttribute("data-open");
			if (id) on.onActivate(id);
		});
		const rowOf = (state) => (p) => itemHtml(p, p.n ?? state.pins.indexOf(p) + 1, p.id === state.activePinId, state.threads.get(p.id) ?? [], state.queuedIds.has(p.id), state);
		function openHtml(state, open) {
			const row = rowOf(state);
			const { loose, groups } = groupByLink(open);
			let html = loose.map(row).join("");
			for (const [key, pins] of groups) html += groupHtml(key, pins, confirming === key) + pins.map(row).join("");
			return html;
		}
		/** The bulk footer: present on the OPEN tab exactly while some pin has had no response. */
		function renderFoot(state) {
			const stale = tab === "open" ? stalePins(state) : [];
			const html = stale.length === 0 ? "" : `<button type="button" class="pb-gres${confirming === "stale" ? " confirm" : ""}" data-bulk="stale">${confirming === "stale" ? "CONFIRM?" : `RESOLVE ${stale.length} WITH NO RESPONSE`}</button>`;
			if (footMemo === html) return;
			foot.innerHTML = html;
			foot.hidden = html === "";
			footMemo = html;
		}
		function render(state) {
			const open = state.pins.filter((p) => p.status === "open" && p.kind !== "comment");
			const counts = {
				open,
				notes: state.pins.filter((p) => p.status === "open" && p.kind === "comment"),
				resolved: state.pins.filter((p) => p.status === "resolved")
			};
			for (const btn of tabButtons) {
				const key = btn.getAttribute("data-tab");
				btn.textContent = `${key.toUpperCase()} · ${counts[key].length}`;
				btn.classList.toggle("on", tab === key);
			}
			renderFoot(state);
			const list = counts[tab];
			const html = list.length ? tab === "open" ? openHtml(state, open) : list.map(rowOf(state)).join("") : "<div class=\"pb-empty\">Nothing here yet.</div>";
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
	//#region src/ui/puck.ts
	/** The bar's ident mark, sized up for the 48px puck face. */
	const PUCK_ICON = "<svg width=\"17\" height=\"17\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.4\"><rect x=\"2.5\" y=\"1.5\" width=\"11\" height=\"7\" rx=\"1\"/><path d=\"M8 8.5v6\"/><circle cx=\"8\" cy=\"14.6\" r=\".9\" fill=\"currentColor\" stroke=\"none\"/></svg>";
	/** Everything in the action table that asked for a fan item, in table order. */
	const FAN_ACTIONS = ACTIONS.filter((a) => a.fan !== void 0);
	function fanItem(a, index) {
		const act = a.fan?.act ?? a.id;
		const label = a.fan?.label ?? a.label;
		const glyph = act === "expand" ? EXPAND_GLYPH : a.glyph ?? "";
		const badge = a.id === "inbox" ? "<span class=\"badge\" data-ref=\"count\" hidden>0</span>" : "";
		return `<button type="button" class="pb-fan-item" data-act="${act}" style="--i:${index}" aria-label="${label}">${icon(glyph, 15)}${badge}<span class="fl">${label.toUpperCase()}<i>${keyLabelOf(a)}</i></span></button>`;
	}
	function createMinimizeUi(doc) {
		const puck = doc.createElement("button");
		puck.type = "button";
		puck.className = "pb-puck pb-ghost";
		puck.setAttribute("aria-label", "Pinbox menu");
		puck.setAttribute("aria-haspopup", "menu");
		puck.innerHTML = `<span class="in">${PUCK_ICON}</span><span class="badge" data-ref="count" hidden>0</span><span class="cdot"></span>`;
		const fan = doc.createElement("div");
		fan.className = "pb-fan";
		fan.hidden = true;
		fan.setAttribute("role", "menu");
		fan.innerHTML = FAN_ACTIONS.map(fanItem).join("");
		const morphWrap = doc.createElement("div");
		morphWrap.className = "pb-morph-wrap";
		morphWrap.hidden = true;
		const surface = doc.createElement("div");
		surface.className = "pb-morph";
		const carrier = doc.createElement("div");
		carrier.className = "pb-carrier";
		carrier.innerHTML = `${PUCK_ICON}<span class="badge" data-ref="count" hidden>0</span>`;
		morphWrap.appendChild(surface);
		morphWrap.appendChild(carrier);
		const badges = [
			puck.querySelector("[data-ref=\"count\"]"),
			carrier.querySelector("[data-ref=\"count\"]"),
			fan.querySelector("[data-ref=\"count\"]")
		];
		const hideItem = fan.querySelector("[data-act=\"hide\"]");
		/** Last-rendered hide state; the item's markup is swapped only on change. */
		let hideShown = null;
		return {
			puck,
			fan,
			morphWrap,
			surface,
			carrier,
			update(state) {
				const open = String(openTaskCount(state.pins));
				for (const badge of badges) {
					if (badge.textContent !== open) badge.textContent = open;
					badge.hidden = open === "0";
				}
				const degraded = state.connection === "offline" || state.connection === "incompatible";
				puck.classList.toggle("degraded", degraded);
				puck.classList.toggle("armed", state.mode === "placing");
				if (hideShown !== state.pinsHidden) {
					hideShown = state.pinsHidden;
					const label = state.pinsHidden ? "Show pins" : "Hide pins";
					hideItem.innerHTML = icon(state.pinsHidden ? EYE_GLYPH : EYE_OFF_GLYPH, 15) + `<span class="fl">${label.toUpperCase()}<i>H</i></span>`;
					hideItem.setAttribute("aria-label", label);
					hideItem.classList.toggle("lit", state.pinsHidden);
				}
			}
		};
	}
	//#endregion
	//#region src/ui/shortcuts.ts
	/** The action table's keyed entries, plus the composer chord the table cannot know about. */
	const ROWS = [
		...ACTIONS.filter((a) => a.key !== void 0 && a.help !== false).map((a) => [a.label, keyLabelOf(a)]),
		["Send comment", "⌘ ↵"],
		["Move toolbar", "DRAG ⋮"],
		["Reset toolbar position", "2× GRIP"]
	];
	function createShortcutsModal(doc, onClose) {
		const root = doc.createElement("div");
		root.className = "pb-modal";
		root.hidden = true;
		root.innerHTML = `<div class="mx"><div class="mh">SHORTCUTS</div><div style="padding:8px 20px 18px">${ROWS.map(([what, key]) => `<div class="mr"><span class="mw">${esc(what)}</span><span class="mk">${esc(key)}</span></div>`).join("")}</div><div class="mf">Shortcuts need the page focused. Inside an embedded frame, click the page first.</div></div>`;
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

/* overlay layer in VIEWPORT space: fixed, re-laid out on every scroll/resize frame (element.ts).
   Document-space it drifted — inner scroll containers, sticky anchors and any transformed
   ancestor of the host all broke the "page scrolls on window from the origin" assumption. */
.pb-overlay { position: fixed; inset: 0; pointer-events: none; }

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

.pb-pin { position: absolute; pointer-events: auto; }
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
.pb-pin.stale:not(.hot) .pb-chipBtn { border-color: var(--pb-amber); }
.pb-pin.stale:not(.hot) .pb-chipBtn .qd { color: var(--pb-amber); }
/* comment pins: muted, an N glyph; hot state stays amber so the active one is unmistakable */
.pb-pin.note .dot { background: var(--pb-fg3); }
.pb-pin.note .needle { background: linear-gradient(to top, var(--pb-fg3), color-mix(in srgb, var(--pb-fg3) 35%, transparent)); }
.pb-pin.note:not(.hot) .pb-chipBtn { color: var(--pb-fg2); border-color: var(--pb-line); }
.pb-chipBtn .nt { display: flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 2px; background: var(--pb-fg3); color: var(--pb-canvas); font-size: 8.5px; letter-spacing: 0; }
.pb-pin.hot .pb-chipBtn .nt { background: var(--pb-amber-ink); color: var(--pb-amber); }
.pb-chipBtn .qd { padding-left: 6px; margin-left: 1px; border-left: 1px solid var(--pb-line-2); font-size: 9px; letter-spacing: .12em; color: var(--pb-amber); }
.pb-pin.hot .pb-chipBtn .qd { color: var(--pb-amber-ink); border-left-color: color-mix(in srgb, var(--pb-amber-ink) 28%, transparent); }

/* thread card (ui/card.ts) — prototype lines 121–190 */
.pb-card { position: absolute; z-index: 80; width: 344px; pointer-events: auto; }
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
.pb-stale { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: color-mix(in srgb, var(--pb-amber) 8%, var(--pb-surface)); border-top: 1px solid var(--pb-line); font-size: 11.5px; color: var(--pb-fg2); }
.pb-stale .msg { flex: 1; min-width: 0; }
.pb-typing.quiet .lbl { color: var(--pb-fg3); }
.pb-dfoot { padding: 10px 16px; border-top: 1px solid var(--pb-line); display: flex; justify-content: flex-end; }
.pb-resnote { padding: 8px 12px; font-size: 11.5px; line-height: 1.45; color: var(--pb-fg2); border-top: 1px solid var(--pb-line); }
.pb-resnote .hh { font-family: var(--pb-font-mono); font-size: 10px; color: var(--pb-fg3); }
.pb-seg { display: flex; margin-right: auto; border: 1px solid var(--pb-line-2); border-radius: 2px; overflow: hidden; }
.pb-seg button { height: 24px; padding: 0 9px; font-size: 10.5px; color: var(--pb-fg3); transition: background 120ms linear, color 120ms linear; }
.pb-seg button + button { border-left: 1px solid var(--pb-line-2); }
.pb-seg button:hover { color: var(--pb-fg1); }
.pb-seg button.on { background: var(--pb-hover); color: var(--pb-fg1); }
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
/* Dragged once: explicit left/top (inline) replace the bottom-centre default. */
.pb-bar.free { bottom: auto; transform: none; }
.pb-bar .grip { display: flex; align-items: center; justify-content: center; width: 14px; height: 32px; margin-left: 2px; color: var(--pb-fg4); cursor: grab; touch-action: none; border-radius: 2px; }
.pb-bar .grip:hover { color: var(--pb-fg2); background: var(--pb-hover); }
.pb-bar.dragging .grip { cursor: grabbing; }
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
.pb-item { display: flex; align-items: flex-start; border-bottom: 1px solid var(--pb-line); }
.pb-item:hover { background: var(--pb-hover); }
.pb-item-main { flex: 1; min-width: 0; text-align: left; display: flex; gap: 11px; padding: 14px 0 14px 16px; }
/* Row actions show on hover/focus; always on touch, where there is no hover. */
.pb-item .acts { display: flex; flex-direction: column; gap: 2px; padding: 12px 10px 0 6px; opacity: 0; transition: opacity 120ms linear; }
.pb-item:hover .acts, .pb-item:focus-within .acts { opacity: 1; }
@media (hover: none) { .pb-item .acts { opacity: 1; } }
.pb-group { display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: color-mix(in srgb, var(--pb-info) 7%, var(--pb-surface)); border-bottom: 1px solid var(--pb-line); font-family: var(--pb-font-mono); font-size: 9.5px; letter-spacing: .14em; color: var(--pb-fg2); }
.pb-group .gr { color: var(--pb-fg1); }
.pb-group .sp { flex: 1; }
.pb-gres { height: 22px; padding: 0 8px; border: 1px solid var(--pb-line-2); border-radius: 2px; font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .14em; color: var(--pb-fg1); transition: color 120ms linear, border-color 120ms linear; }
.pb-gres:hover, .pb-gres.confirm { border-color: var(--pb-ok); color: var(--pb-ok); }
.pb-item .nn { flex: none; display: flex; align-items: center; justify-content: center; min-width: 24px; height: 20px; border-radius: 2px; border: 1px solid var(--pb-line-2); color: var(--pb-fg2); font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .06em; }
.pb-item.on .nn { background: var(--pb-amber); color: var(--pb-amber-ink); border-color: var(--pb-amber); }
.pb-item .cc { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.pb-item .tt { font-size: 12.5px; line-height: 1.45; letter-spacing: -.005em; color: var(--pb-fg1); text-wrap: pretty; }
.pb-item .mm { display: flex; align-items: center; gap: 7px; font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .14em; color: var(--pb-fg4); }
.pb-item .mm .sdot { width: 5px; height: 5px; border-radius: 999px; }
.pb-empty { padding: 26px 16px; font-size: 12.5px; color: var(--pb-fg3); }

/* minimize: floating puck + morph layer (ui/puck.ts, minimize.ts) — v3 design.
   The morph surface is styled identically to the bar so endpoint handoffs are
   pixel-invisible. Ghosting keeps layout (getBoundingClientRect still measures
   morph targets) while dropping the element from paint and the tab order. */
.pb-ghost { opacity: 0 !important; pointer-events: none !important; visibility: hidden; transition: opacity 90ms linear, visibility 0s 90ms; }
.pb-bar { transition: opacity 90ms linear; }
.pb-morph-wrap { position: fixed; inset: 0; z-index: 89; pointer-events: none; opacity: 0; transition: opacity 90ms linear; }
.pb-morph-wrap.on { opacity: 1; }
.pb-morph { position: absolute; left: 0; top: 0; background: var(--pb-bar); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--pb-line-2); box-shadow: var(--pb-shadow); will-change: transform, width, height; }
.pb-carrier { position: absolute; left: 0; top: 0; width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; color: var(--pb-amber); opacity: 0; transition: opacity 140ms linear; will-change: transform; }
.pb-carrier.show { opacity: 1; }
/* Above the bar (90) and drawer (85), below the aim layer (100) and modal (120). */
.pb-puck { position: fixed; left: 0; top: 0; width: 48px; height: 48px; z-index: 95; border-radius: 999px; background: var(--pb-bar); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--pb-line-2); box-shadow: var(--pb-shadow); display: flex; align-items: center; justify-content: center; color: var(--pb-amber); cursor: grab; touch-action: none; transition: opacity 90ms linear; }
.pb-puck:active { cursor: grabbing; }
.pb-puck .in { display: flex; transition: transform 160ms var(--pb-ease); }
.pb-puck:hover .in { transform: scale(1.12); }
.pb-puck .badge, .pb-carrier .badge, .pb-fan-item .badge { position: absolute; top: -5px; right: -5px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--pb-amber); color: var(--pb-amber-ink); font-family: var(--pb-font-mono); font-size: 9px; font-weight: 500; display: flex; align-items: center; justify-content: center; }
/* The bar says "· OFFLINE" in words; the puck's amber dot is the same signal. */
.pb-puck .cdot { position: absolute; bottom: -1px; right: -1px; width: 9px; height: 9px; border-radius: 999px; background: var(--pb-amber); border: 2px solid var(--pb-canvas); display: none; }
.pb-puck.degraded .cdot { display: block; }
/* Placing armed from the fan: the bar's armed-ring is hidden with the bar. */
.pb-puck.armed { border-color: var(--pb-amber); box-shadow: 0 0 0 4px var(--pb-amber-soft), var(--pb-shadow); }

/* puck fan menu (ui/puck.ts, minimize.ts) — tap the puck and a vertical
   quick-menu fans out of it; EXPAND is how the bar comes back. Items stagger
   from the puck; hovering slides a label + key chip toward screen center. */
.pb-fan { position: fixed; z-index: 96; display: flex; flex-direction: column; gap: 6px; align-items: center; }
.pb-fan-item { position: relative; width: 40px; height: 40px; border-radius: 999px; background: var(--pb-bar); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--pb-line-2); box-shadow: var(--pb-shadow); color: var(--pb-fg2); display: flex; align-items: center; justify-content: center; opacity: 0; transform: var(--fan-from) scale(0.5); transition: transform 300ms var(--pb-ease), opacity 180ms linear, color 140ms linear, border-color 140ms linear; transition-delay: calc(var(--i) * 35ms); }
.pb-fan.up { --fan-from: translateY(16px); }
.pb-fan.down { --fan-from: translateY(-16px); }
.pb-fan.on .pb-fan-item { opacity: 1; transform: none; }
.pb-fan-item:hover { color: var(--pb-amber); border-color: var(--pb-amber); }
.pb-fan-item.lit { color: var(--pb-amber); border-color: var(--pb-amber); }
.pb-multi-mark { position: absolute; border: 1.5px dashed var(--pb-amber); border-radius: 4px; pointer-events: none; z-index: 15; }
.pb-multi-mark span { position: absolute; top: -9px; left: -9px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--pb-amber); color: var(--pb-amber-ink); font-family: var(--pb-font-mono); font-size: 9px; font-weight: 500; display: flex; align-items: center; justify-content: center; }
.pb-loci { padding: 6px 14px 0; font-family: var(--pb-font-mono); font-size: 9.5px; letter-spacing: .04em; color: var(--pb-fg3); overflow-wrap: anywhere; }
.pb-fan-item .badge { pointer-events: none; }
.pb-fan-item .fl { position: absolute; top: 50%; display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--pb-elev); border: 1px solid var(--pb-line-2); border-radius: 2px; box-shadow: var(--pb-shadow); font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .14em; color: var(--pb-fg1); white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity 140ms linear, transform 200ms var(--pb-ease); }
.pb-fan.labels-right .fl { left: calc(100% + 10px); transform: translateY(-50%) translateX(-6px); }
.pb-fan.labels-left .fl { right: calc(100% + 10px); transform: translateY(-50%) translateX(6px); }
.pb-fan-item:hover .fl { opacity: 1; transform: translateY(-50%) translateX(0); }
.pb-fan-item .fl i { font-style: normal; padding: 1px 5px; border: 1px solid var(--pb-line-2); border-radius: 2px; background: var(--pb-sunken); color: var(--pb-fg3); }

/* shortcuts modal (ui/shortcuts.ts) — prototype lines 226–232 */
.pb-modal { position: fixed; inset: 0; z-index: 120; display: flex; align-items: center; justify-content: center; background: var(--pb-scrim); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); animation: pb-fade 200ms ease-out both; }
.pb-modal .mx { width: 430px; background: var(--pb-elev); border: 1px solid var(--pb-line-2); border-radius: 4px; box-shadow: var(--pb-shadow); animation: pb-in 280ms var(--pb-ease) both; }
.pb-modal .mh { padding: 18px 20px 14px; border-bottom: 1px solid var(--pb-line); font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .24em; }
.pb-modal .mr { display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--pb-line); }
.pb-modal .mw { font-size: 13px; letter-spacing: -.005em; color: var(--pb-fg2); }
.pb-modal .mf { padding: 0 20px 16px; font-size: 10.5px; color: var(--pb-fg2); }
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
	/** How long a pin commit waits for its picture before shipping without one. */
	const CAPTURE_TIMEOUT_MS = 4e3;
	const BaseElement = globalThis.HTMLElement ?? class {};
	var PinboxToolbarElement = class extends BaseElement {
		static tagName = "pinbox-toolbar";
		/** Watched so a config that arrives after insertion can still start the transport. */
		static observedAttributes = ["hub", "token"];
		store = createStore();
		/** Card → transport seam (wired by #startTransport once a config exists). */
		actions = {};
		#config = null;
		#transport = null;
		/**
		* Connected-lifetime counter, bumped on disconnect. #startTransport can park at
		* an await (getToken, or `await undefined` on the token-less path); a
		* continuation that crossed a disconnect must not install a transport into a
		* later lifetime, where it would shadow or duplicate that lifetime's own start.
		*/
		#lifetime = 0;
		/** One deferred start per tick, however many attribute callbacks land in it. */
		#startQueued = false;
		#token = "";
		#built = false;
		#bar = null;
		#pinsLayer = null;
		#drawer = null;
		/** Reticle, drag-aim and multi-target capture — see placement.ts. */
		#placement = null;
		#modal = null;
		#minUi = null;
		#min = null;
		/** The bar's grip drag; same lifetime as the minimize controller. */
		#barDrag = null;
		/** SPA view watcher: DOM/history changes re-run the anchor-gated render. */
		#anchors = null;
		#helpOpen = false;
		/** The 30 s wall-clock tick that ages pending pins into WAITING / NO RESPONSE. 0 when idle. */
		#clockTimer = 0;
		/** Pending viewport re-layout frame, 0 when none is queued. */
		#layoutFrame = 0;
		#resizeObserver = null;
		#pageStyle = null;
		#unsubscribe = null;
		/** Card → element: send/verify/resolve forward to the transport seam; close dismisses. */
		#cardActions = {
			send: (pinId, text, kind) => this.actions.send?.(pinId, text, kind),
			verify: (pinId, outcome) => this.actions.verify?.(pinId, outcome),
			resolve: (pinId) => this.actions.resolve?.(pinId),
			nudge: (pinId) => this.#nudge(pinId),
			copy: (pinId) => this.#copyPin(pinId),
			close: () => this.#dismiss()
		};
		/** Programmatic path (Pinbox.init). The snippet path reads hub/token attributes. */
		configure(config) {
			this.#config = config;
			if (this.isConnected) this.#queueStart();
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
			this.#applyPageDefaults();
			if (this.shadowRoot) this.#placement?.connect(this.shadowRoot);
			if (this.#min === null) this.#mountMinimize();
			if (this.#barDrag === null) this.#mountBarDrag();
			this.#anchors = watchAnchors(window, () => this.#render(this.store.get()));
			this.#listen();
			this.#unsubscribe = this.store.subscribe((s) => this.#render(s));
			this.#render(this.store.get());
			this.#startClock();
			this.store.update({ captureMode: this.#loadCaptureMode() });
			this.#queueStart();
		}
		/** Persisted per endpoint beside the puck dock; PinboxConfig.capture is the first-run default. */
		#loadCaptureMode() {
			const key = captureKey(`pinbox:${this.config?.endpoint ?? ""}`);
			return loadCaptureMode(globalThis.localStorage, key, this.config?.capture ?? "dom");
		}
		#toggleCapture() {
			const next = this.store.get().captureMode === "tab" ? "dom" : "tab";
			this.store.update({ captureMode: next });
			if (next === "dom") releaseCapture();
			saveCaptureMode(globalThis.localStorage, captureKey(`pinbox:${this.config?.endpoint ?? ""}`), next);
			return true;
		}
		/** Theme from the OS when the host set none; the page-level CSS (placing cursor) into <head>. */
		#applyPageDefaults() {
			if (!this.hasAttribute("data-pb")) {
				const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
				this.setAttribute("data-pb", dark ? "dark" : "light");
			}
			const style = document.createElement("style");
			style.textContent = PAGE_CSS;
			document.head.appendChild(style);
			this.#pageStyle = style;
		}
		#mountBarDrag() {
			if (this.#bar === null) return;
			this.#barDrag = createBarDrag({
				win: window,
				bar: this.#bar.root,
				grip: this.#bar.grip,
				storage: globalThis.localStorage ?? null,
				storagePrefix: `pinbox:${this.config?.endpoint ?? ""}`
			});
		}
		/** The page-level listeners of one connected lifetime; disconnectedCallback removes them. */
		#listen() {
			document.addEventListener("click", this.#onClickCapture, true);
			window.addEventListener("keydown", this.#onKeyDown, true);
			document.addEventListener("scroll", this.#onLayoutChange, {
				capture: true,
				passive: true
			});
			window.addEventListener("resize", this.#onLayoutChange);
			const RO = globalThis.ResizeObserver;
			if (typeof RO === "function") {
				this.#resizeObserver = new RO(this.#onLayoutChange);
				this.#resizeObserver.observe(document.body);
			}
		}
		/** Age is state (state.ts `clock`), so a tick is a render and stale pins flip without a hub event. */
		#startClock() {
			const tick = () => this.store.update({ clock: Date.now() });
			tick();
			this.#clockTimer = window.setInterval(tick, 3e4);
		}
		/**
		* Late-config rescue: an element inserted BEFORE its hub/token attributes were
		* set connected configless and #startTransport bailed. Starting here the moment
		* a config first exists keeps such an element from staying silently dead.
		* Config is still read once — a running transport is never reconfigured.
		*/
		attributeChangedCallback() {
			if (this.isConnected && this.config !== null) this.#queueStart();
		}
		/**
		* Start at the END of the current tick, not synchronously: a config assembled
		* attribute-by-attribute on a connected element (append → set hub → set token)
		* must be read whole. A synchronous start at the first fragment would connect
		* token-less and, per the read-once rule, drop the token forever.
		*/
		#queueStart() {
			if (this.#startQueued) return;
			this.#startQueued = true;
			queueMicrotask(() => {
				this.#startQueued = false;
				this.#startTransport();
			});
		}
		disconnectedCallback() {
			this.#lifetime += 1;
			this.#transport?.close();
			this.#transport = null;
			document.removeEventListener("click", this.#onClickCapture, true);
			window.removeEventListener("keydown", this.#onKeyDown, true);
			document.removeEventListener("scroll", this.#onLayoutChange, { capture: true });
			window.removeEventListener("resize", this.#onLayoutChange);
			this.#resizeObserver?.disconnect();
			this.#resizeObserver = null;
			if (this.#layoutFrame !== 0) cancelAnimationFrame(this.#layoutFrame);
			this.#layoutFrame = 0;
			this.#placement?.disconnect();
			this.#min?.destroy();
			this.#min = null;
			this.#barDrag?.destroy();
			this.#barDrag = null;
			releaseCapture();
			this.#anchors?.destroy();
			this.#anchors = null;
			this.#unsubscribe?.();
			this.#unsubscribe = null;
			window.clearInterval(this.#clockTimer);
			this.#clockTimer = 0;
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
			this.#placement = createPlacement({
				win: window,
				host: this,
				store: this.store,
				pinsLayer: this.#pinsLayer,
				onCancel: () => this.#dismiss()
			});
			overlay.appendChild(this.#placement.outline);
			const card = document.createElement("div");
			card.className = "pb-card";
			card.hidden = true;
			overlay.appendChild(card);
			shadow.appendChild(overlay);
			shadow.appendChild(this.#placement.crosshair);
			this.#bar = createBar(document, { onAction: (id, keyboard) => this.#runAction(id, keyboard) });
			shadow.appendChild(this.#bar.root);
			this.#minUi = createMinimizeUi(document);
			shadow.appendChild(this.#minUi.morphWrap);
			shadow.appendChild(this.#minUi.puck);
			shadow.appendChild(this.#minUi.fan);
			this.#drawer = createDrawer(document, {
				onActivate: (pinId) => this.#activateFromInbox(pinId),
				onClose: () => this.store.update({ inboxOpen: false }),
				onResolve: (pinId, note) => this.actions.resolve?.(pinId, note),
				onUnresolve: (pinId) => this.actions.verify?.(pinId, "reopened")
			});
			shadow.appendChild(this.#drawer.root);
			this.#modal = createShortcutsModal(document, () => this.#setHelp(false));
			shadow.appendChild(this.#modal.root);
			this.#pinsLayer.addEventListener("click", (e) => this.#onChipClick(e));
		}
		/** Same lifetime split as #mountAim: the controller's window listeners and timers die on
		* disconnect, so it is (re)built on connect and re-applies the persisted resting state. */
		#mountMinimize() {
			const ui = this.#minUi;
			const bar = this.#bar;
			if (ui === null || bar === null) return;
			this.#min = createMinimize({
				win: window,
				bar: bar.root,
				ui,
				storage: globalThis.localStorage ?? null,
				storagePrefix: `pinbox:${this.config?.endpoint ?? ""}`,
				reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
				initialMinimized: this.config?.minimized === true,
				onSettled: (minimized, keyboard) => this.#onMinimizeSettled(minimized, keyboard),
				onFanAction: (action) => this.#runAction(action, false)
			});
			this.#min.applyInitial();
		}
		#onMinimizeSettled(minimized, keyboard) {
			if (this.store.get().minimized !== minimized) this.store.update({ minimized });
			this.dispatchEvent(new CustomEvent(minimized ? "pinbox:minimize" : "pinbox:restore", {
				bubbles: true,
				composed: true
			}));
			if (!keyboard) return;
			if (minimized) this.#minUi?.puck.focus();
			else this.#bar?.root.querySelector("[data-ref=\"min\"]")?.focus();
		}
		/** Public: collapse the bar to the floating puck. Bar surfaces close first —
		* the morph must never sweep over an open card, drawer, or armed reticle. */
		minimize(keyboard = false) {
			const state = this.store.get();
			if (state.mode === "placing" || state.activePinId !== null || state.draft !== null) this.#dismiss();
			if (state.inboxOpen) this.store.update({ inboxOpen: false });
			this.#setHelp(false);
			this.#min?.minimize(keyboard);
		}
		/** Public: bring the bar back from the puck. */
		restore(keyboard = false) {
			this.#min?.restore(keyboard);
		}
		/**
		* Task 8 wiring: WS events mutate the store, connection state renders in the
		* bar, card actions hit the hub. The mirror seeds pins so an offline reload
		* still renders read-only threads and queued drafts.
		*/
		async #startTransport() {
			if (this.#transport !== null || !this.isConnected) return;
			const cfg = this.config;
			if (cfg === null) return;
			const lifetime = this.#lifetime;
			const token = cfg.token ?? await cfg.getToken?.().catch(() => void 0) ?? "";
			if (this.#lifetime !== lifetime || this.#transport !== null || !this.isConnected) return;
			this.#token = token;
			const transport = new HubTransport({
				endpoint: cfg.endpoint,
				token: this.#token,
				onEvent: (e) => applyHubEvent(this.store, e),
				onConnection: (connection) => this.store.update({ connection }),
				onPins: (pins) => this.store.update({ pins }),
				onSessions: (sessions) => this.store.update({ agentLive: agentIsLive(sessions, Date.now()) }),
				onOutbox: (ids) => this.store.update({ queuedIds: new Set(ids) })
			});
			this.#transport = transport;
			const queued = transport.outboxPins();
			const seed = [...transport.mirrorPins(), ...queued];
			if (seed.length > 0 && this.store.get().pins.length === 0) this.store.update({ pins: seed });
			if (queued.length > 0) this.store.update({ queuedIds: new Set(queued.map((p) => p.id)) });
			this.actions.send = (pinId, text, kind) => void this.#send(transport, pinId, text, kind);
			this.actions.resolve = (pinId, note) => void transport.resolve(pinId, note).then((pin) => upsertPin(this.store, pin)).catch(() => {});
			this.actions.verify = (pinId, outcome) => void transport.verify(pinId, outcome).then((pin) => {
				upsertPin(this.store, pin);
				if (outcome === "accepted") this.#dismiss();
			}).catch(() => {});
			transport.connect();
		}
		/** draft ⇒ compose PinInput (+ best-effort screenshot) and createPin; else thread reply. */
		async #send(transport, pinId, text, kind) {
			try {
				if (pinId === "draft") {
					const draft = this.store.get().draft;
					if (draft === null) return;
					const input = {
						text,
						kind,
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
		/**
		* Best-effort element screenshot: draft submit → capture → uploadAttachment. The capture is
		* bounded — a slow rasterize or a prompt left hanging must not hold the pin hostage, so past
		* CAPTURE_TIMEOUT_MS the pin ships without pixels (structured capture still carries it).
		*/
		async #screenshot(selector) {
			const cfg = this.config;
			if (cfg === null) return null;
			if (cfg.screenshots === false) return null;
			try {
				const el = document.querySelector(selector);
				if (el === null) return null;
				const capture = this.store.get().captureMode === "tab" ? captureElement(el) : captureElementDom(el);
				const timeout = new Promise((resolve) => window.setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS));
				const img = await Promise.race([capture, timeout]);
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
			const rect = pin === void 0 ? null : anchorRect(document, pin);
			if (rect) {
				const y = window.scrollY + rect.y + rect.height / 2;
				window.scrollTo({
					top: Math.max(0, y - window.innerHeight / 2),
					behavior: "smooth"
				});
			}
		}
		/**
		* Nudge a stale pin: re-post the last human message as a new thread message. A watcher that
		* missed the original (crashed, restarted, registered late) gets a fresh event to wake on.
		*/
		#nudge(pinId) {
			const state = this.store.get();
			const pin = state.pins.find((p) => p.id === pinId);
			if (pin === void 0) return;
			const last = [...state.threads.get(pinId) ?? []].reverse().find((m) => m.role === "human");
			this.actions.send?.(pinId, last?.text ?? pin.text, "note");
		}
		/** The markdown offline fallback: copy every open pin's block to the clipboard. */
		#copyOpenPins() {
			const state = this.store.get();
			try {
				navigator.clipboard.writeText(pinsToMarkdown(state.pins, state.threads));
			} catch {}
			return true;
		}
		/** The card's copy: exactly the pin you are looking at, thread included. */
		#copyPin(pinId) {
			const state = this.store.get();
			const pin = state.pins.find((p) => p.id === pinId);
			if (pin === void 0) return;
			try {
				navigator.clipboard.writeText(pinToMarkdown(pin, state.threads.get(pinId) ?? []));
			} catch {}
		}
		#togglePinsHidden() {
			this.store.update({ pinsHidden: !this.store.get().pinsHidden });
			return true;
		}
		#setHelp(open) {
			this.#helpOpen = open;
			this.#modal?.set(open);
		}
		#toggleHelp() {
			this.#setHelp(!this.#helpOpen);
			return true;
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
			this.store.update(placing ? {
				mode: "idle",
				activePinId: null
			} : {
				mode: "placing",
				activePinId: null,
				pinsHidden: false
			});
			return true;
		}
		#toggleInbox() {
			this.store.update({ inboxOpen: !this.store.get().inboxOpen });
			return true;
		}
		#toggleTheme() {
			const next = this.getAttribute("data-pb") === "dark" ? "light" : "dark";
			this.setAttribute("data-pb", next);
			return true;
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
		#onClickCapture = (e) => {
			if (e.composedPath().includes(this)) return;
			const state = this.store.get();
			if (state.mode === "placing") {
				this.#placement?.handleClick(e);
				return;
			}
			if (state.inboxOpen) this.store.update({ inboxOpen: false });
			if (state.activePinId || state.draft) this.#dismiss();
		};
		/**
		* One handler per action, for every surface: bar buttons, fan items and keys all name an
		* action from the table (ui/actions.ts). A handler returns false when nothing was there to act
		* on, so the key path can let the host have the keystroke (an Esc with nothing open is the
		* page's Esc; R with no active pin is the page's R).
		*/
		#handlers = {
			escape: () => {
				if (this.#min?.closeFan() === true) return true;
				const s = this.store.get();
				const open = s.mode === "placing" || s.activePinId !== null || s.draft !== null || this.#helpOpen;
				this.#dismiss();
				return open;
			},
			pin: () => this.#togglePlacing(),
			inbox: () => this.#toggleInbox(),
			theme: () => this.#toggleTheme(),
			copy: () => this.#copyOpenPins(),
			hide: () => this.#togglePinsHidden(),
			capture: () => this.#toggleCapture(),
			help: () => this.#toggleHelp(),
			resolve: () => {
				const active = this.store.get().activePinId;
				if (active === null) return false;
				this.actions.resolve?.(active);
				return true;
			},
			minimize: (keyboard) => {
				if (this.#min?.minimized() === true) this.restore(keyboard);
				else this.minimize(keyboard);
				return true;
			}
		};
		#runAction(id, keyboard) {
			return this.#handlers[id](keyboard);
		}
		#onKeyDown = (e) => {
			const id = shortcutFor(e, this.config?.shortcuts ?? "all");
			if (id === null) return;
			if (!this.#runAction(id, true)) return;
			e.preventDefault();
			e.stopPropagation();
		};
		/**
		* The viewport moved under the overlay (scroll, resize, layout shift): re-place what is
		* anchored to the page — pins, the card, multi-target marks — once per frame. Not a store
		* update: nothing about the pins changed, only where their anchors are on screen.
		*/
		#onLayoutChange = () => {
			if (this.#layoutFrame !== 0) return;
			this.#layoutFrame = requestAnimationFrame(() => {
				this.#layoutFrame = 0;
				const state = this.store.get();
				if (this.#pinsLayer) renderPins(this.#pinsLayer, state);
				if (this.shadowRoot) renderCard(this.shadowRoot, state, this.#cardActions);
				this.#placement?.render(state.mode === "placing");
			});
		};
		#render(state) {
			const placing = state.mode === "placing";
			this.toggleAttribute("data-placing", placing);
			document.body.classList.toggle(PAGE_PLACING_CLASS, placing);
			this.#placement?.render(placing);
			if (this.#pinsLayer) renderPins(this.#pinsLayer, state);
			if (this.shadowRoot) renderCard(this.shadowRoot, state, this.#cardActions);
			this.#drawer?.update(state);
			this.#bar?.update(state);
			this.#minUi?.update(state);
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
