import net from 'node:net';
import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';

const sessions = new Map();

function authorized(request, token) {
  if (!token) return false;
  const supplied = request?.headers?.['x-tunnel-token'] || '';
  const a = Buffer.from(Array.isArray(supplied) ? supplied[0] : supplied);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function publicAddress(host) {
  const address = ipaddr.parse(host);
  if (address.kind() !== 'ipv4') return false;
  return ['unspecified', 'loopback', 'linkLocal', 'private', 'broadcast', 'carrierGradeNat', 'multicast', 'reserved'].indexOf(address.range()) === -1;
}

export async function resolveTarget(raw) {
  if (!raw || raw.length > 260 || /[\r\n@/?#\s]/.test(raw)) throw Error('invalid target');
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:]+):([0-9]+)$/.exec(raw);
  if (!match) throw Error('invalid target');
  const host = match[1].replace(/^\[|\]$/g, '');
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw Error('invalid target');
  const addresses = ipaddr.isValid(host) ? [{ address: host, family: 4 }] : await dns.lookup(host, { all: true, family: 4, verbatim: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw Error('target address is not public or has no IPv4 route');
  return { host, port };
}

export function connectTarget(target) {
  const socket = net.connect({ host: target.host, port: target.port, family: 4, timeout: 8000 });
  socket.on('timeout', () => socket.destroy(Error('target connect timeout')));
  return socket;
}

function text(value) {
  return String(value || '').slice(0, 400);
}

function errorResponse(error, status = 502) {
  return new Response(JSON.stringify({ ok: false, error: 'target', detail: text(error?.message || error) }), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequest(context) {
  const { request, env = {}, conversation_id: conversationId } = context;
  if (request?.headers?.['x-tunnel-protocol'] !== '5') {
    return errorResponse('protocol 5 required', 400);
  }
  if (!authorized(request, env.CLOUDPROXY_NODE_TOKEN)) {
    return errorResponse('invalid node token', 403);
  }
  if (!/^[0-9a-f]{32}$/.test(conversationId || '')) {
    return errorResponse('invalid conversation id', 400);
  }
  let body = request?.body || {};
  try {
    if (typeof body === 'string') body = JSON.parse(body);
    switch (body.action) {
      case 'open':
        return await openTunnel(conversationId, body.target, request.signal);
      case 'write': {
        const session = sessions.get(conversationId);
        if (!session) return errorResponse('tunnel session unavailable', 409);
        await ensureConnected(session);
        const bytes = Buffer.from(body.data || '', 'base64');
        if (bytes.length > 64 * 1024 || (body.data && Buffer.from(body.data, 'base64').toString('base64') !== body.data)) {
          return errorResponse('invalid upload', 400);
        }
        if (!session.socket.write(bytes)) await once(session.socket, 'drain');
        return new Response(null, { status: 204, headers: { 'X-Tunnel-Ready': 'true' } });
      }
      case 'eof': {
        const session = sessions.get(conversationId);
        if (!session) return errorResponse('tunnel session unavailable', 409);
        session.socket?.end();
        return new Response(null, { status: 204 });
      }
      case 'close': {
        const session = sessions.get(conversationId);
        session?.socket?.destroy();
        sessions.delete(conversationId);
        return new Response(null, { status: 204 });
      }
      default:
        return errorResponse('invalid tunnel action', 400);
    }
  } catch (error) {
    sessions.get(conversationId)?.socket?.destroy();
    sessions.delete(conversationId);
    return errorResponse(error);
  }
}

async function openTunnel(id, rawTarget, signal) {
  if (sessions.has(id)) return errorResponse('session already exists', 409);
  if (sessions.size >= 40) return errorResponse('too many sessions', 503);
  const encoder = new TextEncoder();
  let session;
  const stream = new ReadableStream({
    start(controller) {
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { /* closed */ }
      }, 15000);
      session = {
        target: rawTarget,
        controller,
        socket: null,
        connectPromise: null,
        closed: false,
        cleanup() {
          this.closed = true;
          clearInterval(heartbeat);
          sessions.delete(id);
          this.socket?.destroy();
        },
        finish(event) {
          if (this.closed) return;
          try { controller.enqueue(encoder.encode(`event: ${event}\n\n`)); } catch { return; }
          if (event === 'eof' || event === 'error') {
            if (this.closed) return;
            this.closed = true;
            controller.close();
            this.cleanup();
          }
        },
      };
      sessions.set(id, session);
      signal?.addEventListener('abort', () => session.cleanup(), { once: true });
      queueMicrotask(() => {
        ensureConnected(session).catch(() => session.finish('error'));
      });
    },
    pull() {
      session?.socket?.resume();
    },
    cancel() {
      session?.cleanup();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Transfer-Encoding': 'chunked',
      'X-Accel-Buffering': 'no',
      'X-Tunnel-Ready': 'pending',
    },
  });
}

async function ensureConnected(session) {
  if (session.socket) return;
  if (session.connectPromise) return session.connectPromise;
  session.connectPromise = (async () => {
    const address = await resolveTarget(session.target);
    const socket = connectTarget(address);
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.off('connect', onConnect);
        socket.off('error', onError);
      };
      const onConnect = () => { cleanup(); resolve(); };
      const onError = error => { cleanup(); reject(error); };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
    // net.connect's timeout also applies to post-connect inactivity.
    socket.setTimeout(0);
    if (session.closed) {
      socket.destroy();
      return;
    }
    session.socket = socket;
    socket.on('data', chunk => {
      if (session.closed) return;
      session.controller.enqueue(new TextEncoder().encode(`data:${chunk.toString('base64')}\n\n`));
      if (session.controller.desiredSize !== null && session.controller.desiredSize < -256 * 1024) socket.pause();
    });
    socket.on('end', () => session.finish('eof'));
    socket.on('error', () => session.finish('error'));
    socket.on('close', () => session.cleanup());
    session.finish('ready');
  })();
  return session.connectPromise;
}
