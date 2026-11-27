import { default as net } from 'node:net';
import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { timingSafeEqual } from 'node:crypto';

function header(request, name) {
  return request?.headers?.get(name) || '';
}

export function authorized(request, token) {
  if (!token) return false;
  const a = Buffer.from(header(request, 'x-tunnel-token'));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function publicAddress(host) {
  const address = ipaddr.parse(host);
  if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) {
    return publicAddress(address.toIPv4Address().toString());
  }
  const ranges = address.kind() === 'ipv6'
    ? ['unspecified', 'loopback', 'linkLocal', 'uniqueLocal', 'ipv4Mapped', 'multicast', 'reserved']
    : ['unspecified', 'loopback', 'linkLocal', 'private', 'broadcast', 'carrierGradeNat', 'multicast', 'reserved'];
  return ranges.indexOf(address.range()) === -1;
}

export async function resolveTarget(raw) {
  if (!raw || raw.length > 260 || /[\r\n@/?#\s]/.test(raw)) throw Error('invalid target');
  const colon = raw.lastIndexOf(':');
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.slice(0, colon);
  const port = Number(raw.slice(colon + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || (raw.startsWith('[') && !raw.startsWith('[' + host + ']:'))) {
    throw Error('invalid target');
  }
  const addresses = ipaddr.isValid(host) ? [{ address: host, family: ipaddr.parse(host).kind() === 'ipv6' ? 6 : 4 }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw Error('target address is not public');
  return { host, port };
}

export function connectTarget(target) {
  const socket = net.connect({ host: target.host, port: target.port, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 2500, timeout: 8000 });
  socket.on('timeout', () => socket.destroy(Error('target connect timeout')));
  return socket;
}

export async function onRequest(context) {
  if (header(context.request, 'upgrade').toLowerCase() !== 'websocket') {
    return new Response(JSON.stringify({ runtime: typeof net.connect, dns: typeof dns.lookup, websocketHandler: 'node' }), { status: 426, headers: { 'Content-Type': 'application/json' } });
  }
  return { websocket: createTunnel(context) };
}

function createTunnel({ request, env = {} }) {
  let target;
  let ready = false;
  let ended = false;
  const fail = () => { if (target && !target.destroyed) target.destroy(); };
  const send = (ws, data) => { if (!ended) ws.send(data); };
  return {
    async onopen(ws) {
      try {
        if (!authorized(request, env.CLOUDPROXY_NODE_TOKEN)) throw Error('invalid node token');
        if (header(request, 'x-tunnel-protocol') !== '2') throw Error('protocol 2 required');
        const address = await resolveTarget(header(request, 'x-tunnel-target'));
        target = connectTarget(address);
        target.once('connect', () => {
          if (ended) { target.destroy(); return; }
          ready = true;
          send(ws, JSON.stringify({ ok: true }));
          target.on('data', chunk => send(ws, chunk));
          target.on('end', () => send(ws, 'EOF'));
          target.on('close', () => { ended = true; ws.close(1000); });
          target.on('error', () => { if (ready) { ended = true; ws.close(1011, 'target connection failed'); } });
        });
        target.once('error', error => {
          if (ready) return;
          send(ws, JSON.stringify({ ok: false, error: 'target', detail: String(error?.message || error).slice(0, 400) }));
          ended = true;
          ws.close(1000, 'target unavailable');
        });
      } catch (error) {
        send(ws, JSON.stringify({ ok: false, error: 'target', detail: String(error?.message || error).slice(0, 400) }));
        ended = true;
        ws.close(1000, 'target unavailable');
      }
    },
    onmessage(ws, data, isBinary) {
      if (!ready || ended) return;
      if (!isBinary) {
        if (String(data) === 'EOF') target.end();
        return;
      }
      target.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
    },
    onclose() { ended = true; fail(); },
    onerror() { ended = true; fail(); },
  };
}
