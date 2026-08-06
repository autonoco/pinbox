// @autono/pinbox-core/ws — realtime fan-out seam. Bun and Durable Objects have exactly
// inverted WebSocket capabilities: Bun has topic pub/sub (server.publish) but cannot
// enumerate sockets; DOs enumerate sockets by tag (ctx.getWebSockets) but have no pub/sub
// primitive. Everything above this interface — hello → catch-up → events, cursor replay,
// version handshake — is shared.
export interface Broadcaster {
  publish(topic: string, data: string): void;
  subscriberCount(topic: string): number;
}
