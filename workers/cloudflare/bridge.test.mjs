import test from 'node:test';
import assert from 'node:assert/strict';
import {destination,makeWorker} from './bridge.mjs';

test('reserved/fake IPs and private destinations never dial',()=>{
 for(const value of ['198.18.2.150:443','198.19.1.1:80','100.64.1.1:443','127.0.0.1:80','10.1.2.3:443','192.168.1.1:443','[::1]:80','[::ffff:127.0.0.1]:80','[2001:db8::1]:443','[fc00::1]:443','example.com:0','user@host:443','host/path:443'])assert.throws(()=>destination(value));
 assert.deepEqual(destination('example.com:443'),{hostname:'example.com',port:443});
 assert.deepEqual(destination('[2606:4700:4700::1111]:443'),{hostname:'2606:4700:4700::1111',port:443});
});
test('unauthorized and malformed requests cannot create TCP sockets',async()=>{
 let calls=0;const worker=makeWorker(()=>{calls++;throw Error('must not dial')});
 const context={waitUntil(){}};
 let response=await worker.fetch(new Request('https://worker.example/tunnel'),{CLOUD_PROXY_TOKEN:'test-token'},context);assert.equal(response.status,403);
 response=await worker.fetch(new Request('https://worker.example/tunnel',{headers:{'X-Tunnel-Token':'test-token'}}),{CLOUD_PROXY_TOKEN:'test-token'},context);assert.equal(response.status,426);
 response=await worker.fetch(new Request('https://worker.example/tunnel',{headers:{'X-Tunnel-Token':'test-token',Upgrade:'websocket','X-Tunnel-Protocol':'2','X-Tunnel-Target':'198.18.1.1:443'}}),{CLOUD_PROXY_TOKEN:'test-token'},context);assert.equal(response.status,400);assert.equal(calls,0);
});
test('protocol ACK, binary passthrough and half close',async()=>{
 const OldResponse=globalThis.Response,OldPair=globalThis.WebSocketPair;
 const handlers={},messages=[];let server;globalThis.WebSocketPair=class{constructor(){server={accept(){},send(value){messages.push(value)},close(){},addEventListener(name,fn){handlers[name]=fn}};return {0:{},1:server}}};
 globalThis.Response=class{constructor(body,options){this.status=options.status}};
 let upstream,closed=false,writes=[],halfClosed=false,task;
 const socket={opened:Promise.resolve(),readable:new ReadableStream({start(controller){upstream=controller}}),writable:new WritableStream({write(value){writes.push([...value])},close(){halfClosed=true}}),close(){closed=true;try{upstream.close()}catch{}}};
 try{
 const worker=makeWorker(()=>socket);
 const response=await worker.fetch(new Request('https://worker.example/tunnel',{headers:{'X-Tunnel-Token':'test-token',Upgrade:'websocket','X-Tunnel-Protocol':'2','X-Tunnel-Target':'example.com:443'}}),{CLOUD_PROXY_TOKEN:'test-token'},{waitUntil(p){task=p}});
 assert.equal(response.status,101);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(JSON.parse(messages[0]),{ok:true});
 handlers.message({data:new Uint8Array([1,2,3]).buffer});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(writes,[[1,2,3]]);
 upstream.enqueue(new Uint8Array([4,5]));await new Promise(resolve=>setImmediate(resolve));assert.deepEqual([...messages[1]],[4,5]);
 handlers.message({data:'EOF'});await new Promise(resolve=>setImmediate(resolve));assert.equal(halfClosed,true);upstream.close();await task;assert.equal(messages.at(-1),'EOF');assert.equal(closed,true);
 }finally{handlers.close?.();globalThis.Response=OldResponse;globalThis.WebSocketPair=OldPair}
});
