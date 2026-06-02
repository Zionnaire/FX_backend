// src/websocket/wsServer.ts
// Authenticated WebSocket broadcast server.
//
// Architecture:
//   - One WebSocketServer bound to the HTTP server (not a separate port)
//   - Clients authenticate via JWT in the query string: ws://host/ws?token=<jwt>
//   - A ConnectionRegistry maps userId → Set<WebSocket> for targeted broadcasts
//   - Heartbeat ping/pong every 30s to cull stale connections
//
// Broadcasting from any service:
//   import { broadcast } from '../websocket/wsServer';
//   broadcast(userId, 'signal:new', { pair, confidence });
//
// Client-side event shape:
//   { event: string; data: unknown; timestamp: string }

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';
import { verifyAccessToken } from '../utils/jwt.utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthenticatedWS extends WebSocket {
  userId?:   string;
  isAlive?:  boolean;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const registry = new Map<string, Set<AuthenticatedWS>>();

function register(userId: string, ws: AuthenticatedWS): void {
  if (!registry.has(userId)) registry.set(userId, new Set());
  registry.get(userId)!.add(ws);
}

function deregister(userId: string, ws: AuthenticatedWS): void {
  const conns = registry.get(userId);
  if (!conns) return;
  conns.delete(ws);
  if (conns.size === 0) registry.delete(userId);
}

// ─── Public broadcast ─────────────────────────────────────────────────────────

export function broadcast(userId: string, event: string, data: unknown): void {
  const conns = registry.get(userId);
  if (!conns || conns.size === 0) return;

  const payload = JSON.stringify({ event, data, timestamp: new Date().toISOString() });

  for (const ws of conns) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload, (err) => {
        if (err) console.warn(`[WS] Send failed for user ${userId}:`, err.message);
      });
    }
  }
}

/** Returns active connection count across all users (for monitoring). */
export function getConnectionCount(): number {
  let total = 0;
  for (const set of registry.values()) total += set.size;
  return total;
}

// ─── Server setup ─────────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;

export function initWebSocketServer(server: Server): void {
  if (wss) return;  // already initialized

  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: AuthenticatedWS, req: IncomingMessage) => {
    // ── Authentication ──────────────────────────────────────────────────────
    const url    = new URL(req.url ?? '/', `http://localhost`);
    const token  = url.searchParams.get('token');

    if (!token) {
      ws.close(4001, 'Authentication required');
      return;
    }

    let userId: string;
    try {
      const payload = verifyAccessToken(token) as { id?: string; userId?: string };
      userId = (payload.id ?? payload.userId ?? '').toString();
      if (!userId) throw new Error('No userId in token');
    } catch {
      ws.close(4003, 'Invalid token');
      return;
    }

    ws.userId  = userId;
    ws.isAlive = true;

    register(userId, ws);
    console.info(`[WS] Connected: user=${userId} total=${getConnectionCount()}`);

    // ── Heartbeat ────────────────────────────────────────────────────────────
    ws.on('pong', () => { ws.isAlive = true; });

    // ── Close handler ────────────────────────────────────────────────────────
    ws.on('close', () => {
      deregister(userId, ws);
      console.info(`[WS] Disconnected: user=${userId} remaining=${getConnectionCount()}`);
    });

    // ── Error handler ────────────────────────────────────────────────────────
    ws.on('error', (err) => {
      console.warn(`[WS] Error for user=${userId}:`, err.message);
      deregister(userId, ws);
    });

    // ── Welcome frame ────────────────────────────────────────────────────────
    ws.send(JSON.stringify({
      event:     'connected',
      data:      { message: 'WebSocket authenticated', userId },
      timestamp: new Date().toISOString(),
    }));
  });

  // ── Periodic heartbeat to cull dead connections ──────────────────────────
  const heartbeat = setInterval(() => {
    if (!wss) { clearInterval(heartbeat); return; }
    wss.clients.forEach((client) => {
      const ws = client as AuthenticatedWS;
      if (ws.isAlive === false) {
        if (ws.userId) deregister(ws.userId, ws);
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeat));
  console.info('[WS] WebSocket server initialized on path /ws');
}
