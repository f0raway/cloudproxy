export function destination(value) {
  const match = /^\[([^\]]+)\]:(\d+)$/.exec(value || '') || /^([^:]+):(\d+)$/.exec(value || '');
  if (!match || /[\s/@?#%]/.test(match[1])) throw Error('invalid target host:port');
  const hostname = match[1].toLowerCase(), port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid target port');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw Error('private/local target');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    const a = hostname.split('.').map(Number);
    if (a.some(n=>n>255) || a[0]===0 || a[0]===10 || a[0]===127 || a[0]>=224 ||
        a[0]===100&&a[1]>=64&&a[1]<=127 || a[0]===169&&a[1]===254 ||
        a[0]===172&&a[1]>=16&&a[1]<=31 || a[0]===192&&(a[1]===168||a[1]===0||a[1]===88&&a[2]===99) ||
        a[0]===198&&(a[1]===18||a[1]===19||a[1]===51&&a[2]===100) || a[0]===203&&a[1]===0&&a[2]===113) throw Error('private/reserved target');
  }
  if (hostname.includes(':')) {
    if (/^::ffff:/i.test(hostname) || /^(fc|fd|fe[89ab]|ff)/i.test(hostname) ||
        /^(::|::1|100::|2001:db8:|2001:2:)/i.test(hostname)) throw Error('private/reserved IPv6 target');
  }
  return { hostname, port };
}
async function sameToken(a,b) {
  if (!a || !b || a.length>512) return false;
  const digest = text=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  const [x,y]=await Promise.all([digest(a),digest(b)]);
  const u=new Uint8Array(x),v=new Uint8Array(y);let diff=0;for(let i=0;i<u.length;i++)diff|=u[i]^v[i];return diff===0;
}
export function makeWorker(connect) {
 return { async fetch(request,env,ctx) {
  if(new URL(request.url).pathname!=='/tunnel')return new Response('Not found',{status:404});
  if(!await sameToken(request.headers.get('X-Tunnel-Token'),env.CLOUD_PROXY_TOKEN))return new Response('Forbidden',{status:403});
  if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket required',{status:426});
  if(request.headers.get('X-Tunnel-Protocol')!=='2')return new Response('Protocol 2 required',{status:400});
  let target;try{target=destination(request.headers.get('X-Tunnel-Target'))}catch{return new Response('Public TCP target required',{status:400})}
  const pair=new WebSocketPair(),client=pair[0],server=pair[1];server.accept();
  const lifetime=Number(env.MAX_SECONDS)||7200,idle=Number(env.IDLE_SECONDS)||120,maxBytes=Number(env.MAX_BYTES)||128*1024*1024;
  let socket,writer,reader,ended=false,clientEOF=false,targetEOF=false,total=0,pending=0,chain=Promise.resolve(),last=Date.now();
  const close=(code=1000)=>{if(ended)return;ended=true;clearInterval(idleTimer);clearTimeout(lifeTimer);try{server.close(code,'tunnel closed')}catch{};try{Promise.resolve(socket?.close()).catch(()=>{})}catch{}};
  const account=n=>{total+=n;last=Date.now();if(total>maxBytes)throw Error('connection traffic limit reached')};
  const idleTimer=setInterval(()=>{if(Date.now()-last>idle*1000)close(1011)},Math.min(5000,idle*1000));
  const lifeTimer=setTimeout(()=>close(1011),lifetime*1000);
  server.addEventListener('close',()=>close());server.addEventListener('error',()=>close(1011));
  let ready;
  const bridge=(async()=>{
   try {
    socket=connect(target,{allowHalfOpen:true,secureTransport:'off'});socket.closed?.catch(()=>{});
    let timeout;try{await Promise.race([socket.opened,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('target connection timeout')),10000)})])}finally{clearTimeout(timeout)}
    writer=socket.writable.getWriter();reader=socket.readable.getReader();
    server.send(JSON.stringify({ok:true}));
   } catch(error) {
    const detail=String(error?.message||'target connection failed').slice(0,256);
    const unsupported=/proxy request failed|disallowed|cloudflare ip|TCP Loop|port 25/i.test(detail);
    try{server.send(JSON.stringify({ok:false,error:unsupported?'unsupported':'target',detail}))}catch{};close(1011);return;
   }
   ready=true;
   try {
    while(!ended){const {done,value}=await reader.read();if(done){targetEOF=true;server.send('EOF');if(clientEOF)close();break}
     account(value.byteLength);for(let i=0;i<value.byteLength;i+=16384)server.send(value.slice(i,i+16384));
    }
   } catch {close(1011)}
  })();
  server.addEventListener('message',event=>{
   if(ended)return;const data=event.data;
   if(typeof data==='string'&&data!=='EOF'){close(1003);return}
   const size=typeof data==='string'?0:data.byteLength;
   if(size===undefined||size>256*1024||pending+size>1024*1024){close(1009);return}
   pending+=size;
   chain=chain.then(async()=>{
    if(!ready||ended)throw Error('tunnel not ready');
    if(data==='EOF'){clientEOF=true;await writer.close();if(targetEOF)close();return}
    if(clientEOF)throw Error('data after EOF');account(size);await writer.write(new Uint8Array(data));
   }).catch(()=>close(1011)).finally(()=>{pending-=size});
  });
  // A WebSocket keeps its request alive; no Durable Object, KV or paid service is used.
  ctx.waitUntil(bridge);
  return new Response(null,{status:101,webSocket:client});
 }};
}
