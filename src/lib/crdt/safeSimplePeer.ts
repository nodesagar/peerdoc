/**
 * Stand-in for '@thaunknown/simple-peer', aliased in by vite.config.ts.
 *
 * trystero 0.20 attaches an 'error' listener to a peer only once it has
 * connected; peers still negotiating have none. simple-peer is a streamx
 * Duplex, so when ICE fails it emits 'error' with no listener, which throws:
 * an uncaught "Connection failed." in the console, and the throw also aborts
 * the rest of simple-peer's teardown callback. trystero's 'close' handler
 * already cleans up, so a listener that only logs is enough.
 *
 * Remove when moving to a trystero version that handles this (0.26 rewrote
 * peers without simple-peer).
 */
// The real module, by file path: the alias only matches the bare package name.
// @ts-expect-error simple-peer ships no type definitions
import SimplePeer from '@thaunknown/simple-peer/index.js';

type PeerOptions = Record<string, unknown>;

const Base = SimplePeer as unknown as new (opts?: PeerOptions) => {
  on(event: 'error', listener: (err: Error & { code?: string }) => void): unknown;
};

export default class SafeSimplePeer extends Base {
  constructor(opts?: PeerOptions) {
    super(opts);
    this.on('error', (err) => {
      console.debug('[EditorDoc] WebRTC peer closed:', err.code ?? err.message);
    });
  }
}
