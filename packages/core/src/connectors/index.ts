// @autono/pinbox-core/connectors — the connector seam's public surface:
// interface types, the core-enforced anti-echo mirror sinks, and the due_at poll
// reconciler the serve boot wires. One subpath so hosts (CLI serve,
// the Worker) import the seam whole; github ships on ./connectors/github.
export * from "./mirror.ts";
export * from "./poll.ts";
// Slack rides this barrel rather than a new subpath: the export map is final
// and lists only ./connectors and ./connectors/github. slack.ts is pure fetch, so the
// Worker can import the barrel safely.
export * from "./slack.ts";
export * from "./types.ts";
