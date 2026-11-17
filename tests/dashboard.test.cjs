const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
class Element {
 constructor(){this.children=[];this.textContent='';this.value='';this.style={};this.open=false;this.attributes={};this.dataset={};}
 append(...e){for(const child of e){child.parentElement=this;this.children.push(child)}}
 querySelectorAll(selector){return this.children.flatMap(child=>[...(selector==='input'?child.tag==='input':selector==='[data-name="token"]'?child.dataset.name==='token':false)?[child]:[],...child.querySelectorAll(selector)])}
 querySelector(selector){if(selector.includes(':invalid'))return this.invalidField||null;const name=selector.match(/data-name="([^"]+)"/)[1];const walk=e=>e.dataset.name===name?e:e.children.map(walk).find(Boolean);return walk(this)}
 replaceChildren(...e){this.children=e.flatMap(x=>x.fragment?x.children:[x])}
 setAttribute(k,v){this.attributes[k]=v}
 addEventListener(){}
 closest(){return this.parentElement??=new Element()}
 showModal(){this.open=true}
 set innerHTML(v){throw new Error('Unsafe HTML rendering')}
}
function page(){
 const ids=new Set([...fs.readFileSync('dashboard.html','utf8').matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
 const els={};const get=id=>{assert.ok(ids.has(id),'DOM id exists: '+id);return els[id]??=new Element()};get('state').value='all';get('protocol').value='all';
 const ctx=vm.createContext({document:{getElementById:get,createElement:tag=>Object.assign(new Element(),{tag}),createTextNode:text=>Object.assign(new Element(),{textContent:text}),querySelectorAll:selector=>Object.values(els).flatMap(e=>e.querySelectorAll(selector)),createDocumentFragment:()=>Object.assign(new Element(),{fragment:true})},setInterval(){},URL,location:{origin:'http://localhost'},fetch:()=>new Promise(()=>{})});
 vm.runInContext(fs.readFileSync('dashboard.js','utf8'),ctx);return {ctx,get};
}
test('raw errors stay text; HTTP errors and unconnected closure never show success',()=>{
 const {ctx,get}=page();const stamp=new Date().toISOString();const raw='network unreachable <script>bad()</script>';
 ctx.rows=[{state:'connected',connected:stamp},{state:'closed',ended:stamp},{state:'closed',http_status:503},{state:'failed',http_status:200,error:raw},{state:'connected',attempts:[{error:'timeout',region:'first',started:stamp}]}].map((r,i)=>({id:i+1,source:'client',target:'example.org:443',protocol:'SOCKS5',started:stamp,uploaded:0,downloaded:0,...r}));
 vm.runInContext('data=rows; render()',ctx);
 const rows=get('rows').children;assert.equal(rows[0].children[6].className,'reason success');assert.equal(rows[1].children[6].className,'reason ');assert.equal(rows[2].children[6].className,'reason error');assert.equal(rows[3].children[6].textContent,raw);rows[4].onclick();assert.match(get('detailText').textContent,/timeout/);
});
test('pool distinguishes local uptime, selectable nodes and successful upstream evidence',()=>{
 const {ctx,get}=page();ctx.stats={readiness:'blocked',eligible_nodes:0,enabled_nodes:1,free_nodes:1,paid_nodes:0,uptime_seconds:90061,version:'test',nodes:[{region:'vendor-a',provider:'custom',free:true,status:'Unverified',connections:0}]};
 vm.runInContext('renderPool(stats)',ctx);assert.match(get('poolHealth').textContent,/暂无可选/);assert.match(get('uptime').textContent,/1 天 1 小时 1 分钟/);assert.match(get('nodes').children[0].children[1].textContent,/尚未验证/);
 ctx.stats.eligible_nodes=1;ctx.stats.readiness='ready';ctx.stats.nodes[0].status='Healthy';ctx.stats.nodes[0].last_success_at=new Date().toISOString();vm.runInContext('renderPool(stats)',ctx);assert.match(get('poolHealth').textContent,/1 个节点可尝试/);assert.match(get('nodes').children[0].children[3].textContent,/最近成功/);
});
test('settings script initializes and navigation opens the editable page',()=>{
 const {ctx,get}=page();ctx.window={addEventListener(){},confirm(){return false}};
 vm.runInContext(fs.readFileSync('settings.js','utf8'),ctx);
 get('showSettings').onclick();assert.equal(get('monitorView').hidden,true);assert.equal(get('settingsView').hidden,false);assert.equal(get('showSettings').attributes['aria-pressed'],'true');assert.equal(get('saveSettings').disabled,true);
 get('showMonitor').onclick();assert.equal(get('monitorView').hidden,false);assert.equal(get('settingsView').hidden,true);
});

test('configuration loads, keeps edits across views and sends explicit custom rates',async()=>{
 const {ctx,get}=page();ctx.window={addEventListener(){},confirm(){return false}};
 ctx.fixture={csrf_token:'test-csrf',settings:{user:'test-user',monthly_limit_yuan:8,routing_strategy:'free_first',cloudflare_daily_limit:90000,nodes:[{provider:'custom',region:'vendor',url:'wss://example.org/tunnel',rates:{compute_yuan_per_second:0,traffic_yuan_per_gb:0,request_yuan:0}}]}};
 vm.runInContext('json=async()=>fixture',ctx);vm.runInContext(fs.readFileSync('settings.js','utf8'),ctx);
 get('showSettings').onclick();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(get('saveSettings').disabled,false);assert.equal(get('nodeEditors').children.length,1);assert.equal(get('configUser').value,'test-user');
 get('configBudget').value='6';get('showMonitor').onclick();get('showSettings').onclick();assert.equal(get('configBudget').value,'6');
 let payload;ctx.fetch=async(url,options)=>{payload=JSON.parse(options.body);return {ok:true,json:async()=>({saved:true})}};
 await get('settingsForm').onsubmit({preventDefault(){}});
 assert.equal(payload.monthly_limit_yuan,6);assert.equal(payload.nodes[0].rates.compute_yuan_per_second,0);assert.equal(get('settingsFields').disabled,false);assert.match(get('saveStatus').textContent,/已保存/);
});

test('four workspaces and settings shortcuts preserve pause state and active section',()=>{
 const {ctx,get}=page();ctx.window={addEventListener(){},confirm(){return false}};
 vm.runInContext(fs.readFileSync('settings.js','utf8'),ctx);
 for(const [button,view,title]of [['showConnections','connectionsView','连接记录'],['showNodes','nodesView','上游节点'],['showMonitor','monitorView','运行概览']]){
  get(button).onclick();assert.equal(get(view).hidden,false);assert.equal(get('pageTitle').textContent,title);
  for(const other of ['monitorView','connectionsView','nodesView','settingsView'].filter(x=>x!==view))assert.equal(get(other).hidden,true);
 }
 get('manageNodes').onclick();assert.equal(get('settingsView').hidden,false);assert.equal(get('settingsNodes').hidden,false);assert.equal(get('settingsAccount').hidden,true);
 get('tabLogs').onclick();assert.equal(get('settingsLogs').hidden,false);assert.equal(get('settingsNodes').hidden,true);
 vm.runInContext('paused=true',ctx);get('showConnections').onclick();assert.match(get('live').textContent,/已暂停/);assert.equal(get('pause').hidden,false);
});
test('save reveals the first invalid field in a hidden settings group without posting',async()=>{
 const {ctx,get}=page();ctx.window={addEventListener(){},confirm(){return false}};
 ctx.fixture={csrf_token:'test',settings:{user:'demo',nodes:[]}};
 vm.runInContext('json=async()=>fixture',ctx);vm.runInContext(fs.readFileSync('settings.js','utf8'),ctx);
 get('showSettings').onclick();await new Promise(resolve=>setImmediate(resolve));
 let reported=false,posted=false;const invalid={closest:()=>({id:'settingsNodes'}),reportValidity:()=>{reported=true}};
 get('settingsForm').invalidField=invalid;ctx.fetch=async()=>{posted=true};
 await get('settingsForm').onsubmit({preventDefault(){}});
 assert.equal(reported,true);assert.equal(posted,false);assert.equal(get('settingsNodes').hidden,false);assert.equal(get('settingsAccount').hidden,true);assert.equal(get('saveSettings').disabled,false);
});
test('recent activity is bounded, ordered and opens literal error details',()=>{
 const {ctx,get}=page();ctx.fixture=Array.from({length:10},(_,i)=>({id:i+1,started:new Date(2026,0,1,0,0,i).toISOString(),source:'client',target:'example.org:443',state:'failed',protocol:'SOCKS5',uploaded:0,downloaded:0,error:'raw <script>bad()</script>'}));
 vm.runInContext('data=fixture;renderRecent()',ctx);assert.equal(get('recentActivity').children.length,6);
 get('recentActivity').children[0].onclick();assert.equal(get('detailTitle').textContent,'连接 #10');assert.equal(get('detailResult').textContent,'raw <script>bad()</script>');assert.equal(get('detail').open,true);
 vm.runInContext('data=[];renderRecent()',ctx);assert.match(get('recentActivity').children[0].textContent,/暂无活动/);
});
