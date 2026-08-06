// @autono/pinbox-toolbar/react — thin React wrapper (subpath ./react)
// react is an OPTIONAL peer: this module is only evaluated when the consumer
// imports the subpath, so the bare `react` import never taxes non-React users.
//
// Why imperative create instead of rendering <pinbox-toolbar> as a host element: React
// attaches refs AFTER the node is inserted, but the element starts its transport in
// connectedCallback — a configure() delivered via ref would arrive too late and the
// element would sit configless forever. Creating + configuring BEFORE appendChild is the
// only ordering that works, so the wrapper renders a display:contents host div and mounts
// the element into it on mount.
import { createElement, type ReactElement, useEffect, useRef } from "react";
import { defineToolbarElement, type PinboxConfig, PinboxToolbarElement } from "./index.ts";

/**
 * `<PinboxToolbar endpoint="http://127.0.0.1:4242" />` — forwards the config ONCE on
 * mount and removes the element on unmount. The element does not support live
 * reconfiguration; remount with a `key` to change endpoints.
 */
export function PinboxToolbar(props: PinboxConfig): ReactElement {
  const host = useRef<HTMLDivElement | null>(null);
  const config = useRef(props);
  config.current = props;

  useEffect(() => {
    defineToolbarElement();
    const el = document.createElement(PinboxToolbarElement.tagName) as PinboxToolbarElement;
    el.configure(config.current);
    host.current?.appendChild(el);
    return () => {
      el.remove();
    };
  }, []);

  return createElement("div", { ref: host, style: { display: "contents" } });
}
