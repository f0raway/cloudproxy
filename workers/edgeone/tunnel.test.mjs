import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { authorized, onRequest, publicAddress, resolveTarget } from './cloud-functions/tunnel/index.js';

const request = (token = 'test-token', target = '127.0.0.1:80') => ({ headers: new Headers({ upgrade: 'websocket', 'x-tunnel-token': token, 'x-tunnel-protocol': '2', 'x-tunnel-target': target }) });

test('token is required and compared as bytes', async () => {
  assert.equal(authorized(request(), 'test-token'), true);
  assert.equal(authorized(request('wrong'), 'test-token'), false);
  assert.equal(authorized(request(), ''), false);
  assert.equal((await onRequest({ request: { headers: new Headers() } })).status, 426);
});

test('private, reserved and invalid destinations are rejected before dialing', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '224.0.0.1', '0.0.0.0', '::1', 'fd00::1', '::ffff:127.0.0.1', 'fe80::1']) {
    assert.equal(publicAddress(address), false, address);
  }
  assert.equal(publicAddress('2606:4700::1111'), true);
  await assert.rejects(resolveTarget('localhost:80'));
  await assert.rejects(resolveTarget('127.0.0.1:80'));
  await assert.rejects(resolveTarget('8.8.8.8:0'));
});

test('real TCP stream is bridged after protocol 2 acknowledgement', async (t) => {
  const echo = net.createServer(socket => socket.pipe(socket));
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  t.after(() => echo.close());
  const original = net.connect;
  let socket;
  t.mock.method(net, 'connect', () => {
    socket = original.call(net, { host: '127.0.0.1', port: echo.address().port });
    return socket;
  });
  t.after(() => socket?.destroy());
  const sent = [];
  const ws = { send: data => sent.push(data), close: () => {} };
  const handler = (await onRequest({ request: request('test-token', '8.8.8.8:80'), env: { CLOUDPROXY_NODE_TOKEN: 'test-token' } })).websocket;
  await handler.onopen(ws);
  for (let i = 0; i < 100 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(sent, [JSON.stringify({ ok: true })]);
  const payload = Buffer.from([0, 1, 2, 255]);
  handler.onmessage(ws, payload, true);
  for (let i = 0; i < 100 && !Buffer.isBuffer(sent[1]); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(sent[1], payload);
  handler.onmessage(ws, 'EOF', false);
  for (let i = 0; i < 100 && sent.at(-1) !== 'EOF'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent.at(-1), 'EOF');
  handler.onclose();
});

test('an unavailable target is reported in the WebSocket acknowledgement', async (t) => {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  listener.close();
  await once(listener, 'close');
  t.mock.method(net, 'connect', () => net.createConnection({ host: '127.0.0.1', port }));
  const sent = [];
  const ws = { send: data => sent.push(data), close: () => {} };
  const handler = (await onRequest({ request: request('test-token', '8.8.8.8:80'), env: { CLOUDPROXY_NODE_TOKEN: 'test-token' } })).websocket;
  await handler.onopen(ws);
  for (let i = 0; i < 100 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.parse(sent[0]).error, 'target');
});
