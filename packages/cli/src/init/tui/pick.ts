// pinbox CLI — one-shot OpenTUI select session for init's interactive seams.
// Alternate screen, pinbox palette, destroy on settle. Returns null on cancel/Ctrl-C.
import {
  Box,
  Text,
  SelectRenderable,
  SelectRenderableEvents,
  TextAttributes,
  createCliRenderer,
  type SelectOption,
} from "@opentui/core";
import { TUI } from "./theme.ts";

export type PickOption<T> = {
  name: string;
  description?: string;
  value: T;
};

/** Soft readability cap on ultrawide terminals; under this, the card tracks the tty. */
const PANEL_MAX_WIDTH = 88;

/**
 * Show a titled select list; resolve with the chosen value, or null if the user cancels.
 * Owns the terminal only for the duration of the pick — Layer 1/2 text resumes after destroy.
 */
export async function pickOne<T>(opts: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  options: PickOption<T>[];
  height?: number;
}): Promise<T | null> {
  if (opts.options.length === 0) return null;

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
    targetFps: 30,
    backgroundColor: TUI.ink,
  });

  let settled = false;
  let resolvePick!: (value: T | null) => void;
  const result = new Promise<T | null>((resolve) => {
    resolvePick = resolve;
  });

  const finish = (value: T | null): void => {
    if (settled) return;
    settled = true;
    if (!renderer.isDestroyed) renderer.destroy();
    resolvePick(value);
  };

  const showDescription = opts.options.some((option) => option.description !== undefined);
  // Each option is one row; descriptions add a second row per option.
  const menuHeight =
    opts.height ?? Math.min(12, opts.options.length * (showDescription ? 2 : 1) + 1);

  const selectOptions: SelectOption[] = opts.options.map((option) => ({
    name: option.name,
    description: option.description ?? "",
  }));

  const menu = new SelectRenderable(renderer, {
    id: "init-pick",
    width: "100%",
    flexGrow: 0,
    flexShrink: 0,
    height: menuHeight,
    options: selectOptions,
    backgroundColor: TUI.inkRaised,
    selectedBackgroundColor: TUI.amber,
    selectedTextColor: TUI.amberInk,
    textColor: TUI.bone,
    descriptionColor: TUI.stone,
    selectedDescriptionColor: TUI.amberInk,
    showDescription,
    wrapSelection: true,
    showScrollIndicator: opts.options.length > 6,
  });

  menu.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    const chosen = opts.options[index];
    finish(chosen === undefined ? null : chosen.value);
  });

  renderer.on("destroy", () => {
    finish(null);
  });

  // Percentage + maxWidth: Yoga reflows on terminal resize — no manual width math.
  const panel = Box(
    {
      width: "100%",
      maxWidth: PANEL_MAX_WIDTH,
      minWidth: 36,
      marginX: 2,
      padding: 1,
      flexDirection: "column",
      gap: 1,
      flexShrink: 0,
      borderStyle: "single",
      borderColor: TUI.hairline,
      backgroundColor: TUI.inkRaised,
    },
    Text({
      content: opts.eyebrow,
      fg: TUI.amber,
      attributes: TextAttributes.BOLD,
    }),
    Text({
      content: opts.title,
      fg: TUI.bone,
      wrapMode: "word",
    }),
    ...(opts.subtitle === undefined
      ? []
      : [
          Text({
            content: opts.subtitle,
            fg: TUI.stoneSoft,
            wrapMode: "word",
          }),
        ]),
    menu,
    Text({
      content: "↑↓ navigate · enter confirm · ctrl-c cancel",
      fg: TUI.stone,
    }),
  );

  const stage = Box(
    {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: TUI.ink,
    },
    panel,
  );

  menu.focus();
  renderer.root.add(stage);
  return result;
}
