import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import net from 'node:net';
import { onRequest, publicAddress, resolveTarget } from './agents/tunnel/index.js';

const id = '0123456789abcdef0123456789abcdef';
function context(action, extra = {}) {
  return {
    conversation_id: id,
    env: { CLOUDPROXY_NODE_TOKEN: 'test-token' },
    request: {
      headers: { 'x-tunnel-token': 'test-token', 'x-tunnel-protocol': '5' },
      body: { action, ...extra },
    },
  };
}

test('private and IPv6 targets are rejected', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '224.0.0.1']) {
    assert.equal(publicAddress(ip), false);
  }
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700::1111'), false);
  await assert.rejects(resolveTarget('localhost:80'));
  await assert.rejects(resolveTarget('8.8.8.8:0'));
});

async function readSSE(reader) {
  for (;;) {
    let text = '';
    while (!text.includes('\n\n')) {
      const { done, value } = await reader.read();
      if (done) throw Error('unexpected EOF');
      text += new TextDecoder().decode(value);
    }
    const match = text.match(/data:([A-Za-z0-9+/=]+)\n\n/);
    if (match) return Buffer.from(match[1], 'base64').toString();
  }
}

test('agent session supports repeated writes and a streaming response', async (t) => {
  const socket = new Duplex({
    read() {},
    write(chunk, encoding, callback) { this.push(chunk); callback(); },
  });
  socket.setTimeout = () => {};
  t.mock.method(net, 'connect', () => {
    process.nextTick(() => socket.emit('connect'));
    return socket;
  });
  t.after(() => socket.destroy());
  const opened = await onRequest(context('open', { target: '8.8.8.8:80' }));
  assert.equal(opened.status, 200, opened.status === 200 ? '' : await opened.text());
  assert.equal(opened.headers.get('X-Tunnel-Ready'), 'pending');
  assert.equal(opened.headers.get('Transfer-Encoding'), 'chunked');
  const reader = opened.body.getReader();
  for (const value of ['first', 'second']) {
    const upload = await onRequest(context('write', { data: Buffer.from(value).toString('base64') }));
    assert.equal(upload.status, 204);
    assert.equal(await readSSE(reader), value);
  }
  assert.equal((await onRequest(context('close'))).status, 204);
});

test('a missing session never silently opens a replacement socket', async () => {
  const missing = await onRequest(context('write', { data: Buffer.from('no-replay').toString('base64') }));
  assert.equal(missing.status, 409);
});
