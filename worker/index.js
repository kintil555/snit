// ScanText Relay Worker — Cloudflare Workers + Durable Objects (Hibernation API)
import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // Ping / warm-up
    if (url.pathname === '/api/ping') {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Create room
    if (url.pathname === '/api/room/create' && request.method === 'POST') {
      const roomId = generateId(16);
      const expiresAt = Date.now() + 60 * 1000; // 1 minute

      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      await stub.init(roomId, expiresAt);

      return new Response(JSON.stringify({ roomId, expiresAt }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // WebSocket upgrade
    if (url.pathname.startsWith('/ws/')) {
      const roomId = url.pathname.slice(4);
      if (!roomId) return new Response('Missing room ID', { status: 400 });

      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      return stub.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async init(roomId, expiresAt) {
    await this.ctx.storage.put('meta', { roomId, expiresAt });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role') || 'sender';

    const { 0: client, 1: server } = new WebSocketPair();

    // Use Hibernation API — keeps DO alive across idle periods
    this.ctx.acceptWebSocket(server, [role]);

    return new Response(null, { status: 101, webSocket: client });
  }

  // Called when a WS message arrives (Hibernation API)
  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }

    const [role] = this.ctx.getTags(ws);

    if (msg.type === 'READY') {
      // Notify all peers with opposite role
      this.broadcast(ws, role, { type: 'PEER_CONNECTED', role });
    }

    if (msg.type === 'TEXT_PAYLOAD') {
      const targetRole = role === 'sender' ? 'receiver' : 'sender';
      this.broadcast(ws, role, {
        type: 'TEXT_RECEIVED',
        text: msg.text,
        timestamp: Date.now(),
      }, targetRole);
    }

    if (msg.type === 'PING') {
      ws.send(JSON.stringify({ type: 'PONG' }));
    }
  }

  // Called when a WS closes (Hibernation API)
  async webSocketClose(ws, code, reason) {
    const [role] = this.ctx.getTags(ws);
    this.broadcast(ws, role, { type: 'PEER_DISCONNECTED', role });
    ws.close(code, reason);
  }

  async webSocketError(ws) {
    const [role] = this.ctx.getTags(ws);
    this.broadcast(ws, role, { type: 'PEER_DISCONNECTED', role });
  }

  // Broadcast to all sockets with targetRole (or opposite role if targetRole not given)
  broadcast(fromWs, fromRole, message, targetRole = null) {
    const tRole = targetRole ?? (fromRole === 'sender' ? 'receiver' : 'sender');
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets(tRole)) {
      try { ws.send(payload); } catch {}
    }
  }
}

function generateId(bytes = 16) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
