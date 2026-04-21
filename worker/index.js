// SnapText Relay Worker - Cloudflare Workers + Durable Objects
// Handles room creation, QR code sessions, and WebSocket relay

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Route: Ping / warm-up
    if (url.pathname === '/api/ping') {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Route: Create a new room
    if (url.pathname === '/api/room/create' && request.method === 'POST') {
      const body = await request.json();
      const receiverType = body.receiverType || 'desktop'; // 'desktop' or 'mobile'

      const roomId = generateRoomId();
      const code = receiverType === 'mobile' ? generateNumericCode() : null;
      const expiresAt = Date.now() + 60 * 1000; // 60 seconds

      const id = env.ROOMS.idFromName(roomId);
      const room = env.ROOMS.get(id);

      await room.fetch(new Request('https://internal/init', {
        method: 'POST',
        body: JSON.stringify({ roomId, code, expiresAt, receiverType }),
      }));

      return new Response(JSON.stringify({ roomId, code, expiresAt }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Route: Join by numeric code (mobile receiver)
    if (url.pathname === '/api/room/join-by-code' && request.method === 'POST') {
      const { code } = await request.json();

      // Search active rooms by code
      // We encode roomId in the code lookup via a KV or DO index
      const id = env.ROOMS.idFromName(`code:${code}`);
      const room = env.ROOMS.get(id);
      const res = await room.fetch(new Request('https://internal/lookup-code', {
        method: 'POST',
        body: JSON.stringify({ code }),
      }));

      const data = await res.json();
      if (!data.roomId) {
        return new Response(JSON.stringify({ error: 'Code not found or expired' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ roomId: data.roomId }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Route: WebSocket upgrade for room
    if (url.pathname.startsWith('/ws/')) {
      const roomId = url.pathname.replace('/ws/', '');
      if (!roomId) return new Response('Missing room ID', { status: 400 });

      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      const id = env.ROOMS.idFromName(roomId);
      const room = env.ROOMS.get(id);
      return room.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};

// ---- Durable Object: Room ----
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // sessionId -> WebSocket
    this.roomMeta = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init') {
      const data = await request.json();
      this.roomMeta = data;
      // Store code mapping if numeric code
      if (data.code) {
        // Store in another DO for lookup
        const codeId = this.env.ROOMS.idFromName(`code:${data.code}`);
        const codeDO = this.env.ROOMS.get(codeId);
        await codeDO.fetch(new Request('https://internal/set-code', {
          method: 'POST',
          body: JSON.stringify({ code: data.code, roomId: data.roomId, expiresAt: data.expiresAt }),
        }));
      }
      return new Response(JSON.stringify({ ok: true }));
    }

    if (url.pathname === '/set-code') {
      const data = await request.json();
      this.codeData = data;
      return new Response(JSON.stringify({ ok: true }));
    }

    if (url.pathname === '/lookup-code') {
      if (!this.codeData || Date.now() > this.codeData.expiresAt) {
        return new Response(JSON.stringify({ roomId: null }));
      }
      return new Response(JSON.stringify({ roomId: this.codeData.roomId }));
    }

    // WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      return this.handleWebSocket(request);
    }

    return new Response('Not found', { status: 404 });
  }

  async handleWebSocket(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role'); // 'sender' or 'receiver'
    const sessionId = generateId();

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    this.sessions.set(sessionId, { ws: server, role });

    server.addEventListener('message', async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'TEXT_PAYLOAD') {
        // Relay to all receivers (or senders depending on direction)
        const targetRole = role === 'sender' ? 'receiver' : 'sender';
        this.broadcast(targetRole, {
          type: 'TEXT_RECEIVED',
          text: msg.text,
          fromRole: role,
          timestamp: Date.now(),
        }, sessionId);
      }

      if (msg.type === 'PING') {
        server.send(JSON.stringify({ type: 'PONG' }));
      }

      if (msg.type === 'READY') {
        // Notify other party that peer connected
        const targetRole = role === 'sender' ? 'receiver' : 'sender';
        this.broadcast(targetRole, { type: 'PEER_CONNECTED', role }, sessionId);
      }
    });

    server.addEventListener('close', () => {
      this.sessions.delete(sessionId);
      const targetRole = role === 'sender' ? 'receiver' : 'sender';
      this.broadcast(targetRole, { type: 'PEER_DISCONNECTED', role }, sessionId);
    });

    // Confirm connection
    server.send(JSON.stringify({ type: 'CONNECTED', sessionId, role }));

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(targetRole, message, exceptSessionId) {
    const payload = JSON.stringify(message);
    for (const [id, session] of this.sessions) {
      if (id !== exceptSessionId && session.role === targetRole) {
        try { session.ws.send(payload); } catch {}
      }
    }
  }
}

function generateRoomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateNumericCode() {
  const arr = crypto.getRandomValues(new Uint32Array(1));
  return String(arr[0] % 900000 + 100000); // 6-digit
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}
