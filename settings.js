(()=>{
 const field=id=>document.getElementById(id);
 let csrf='',loaded=false,dirty=false,saving=false,loading=false;
 function setDirty(value){dirty=value;field('dirtyStatus').textContent=value?'有未保存的修改':''}
 window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=''}});
 field('settingsForm').addEventListener('input',()=>setDirty(true));
 field('settingsForm').addEventListener('change',()=>setDirty(true));
 const pages={
  overview:{button:'showMonitor',view:'monitorView',title:'运行概览',description:'查看入口状态、连接活动与费用保护。'},
  connections:{button:'showConnections',view:'connectionsView',title:'连接记录',description:'追踪来源与目标，查看连接结果和原始错误。'},
  nodes:{button:'showNodes',view:'nodesView',title:'上游节点',description:'查看各平台节点的可用状态与实际连接表现。'},
  settings:{button:'showSettings',view:'settingsView',title:'设置',description:'管理认证、调度、上游与访问规则。'}
 };
 function view(page){
  const current=pages[page];settingsOpen=page==='settings';
  for(const [key,item]of Object.entries(pages)){field(item.button).setAttribute('aria-pressed',String(key===page));field(item.view).hidden=key!==page}
  field('pageTitle').textContent=current.title;field('pageCrumb').textContent=current.title;field('pageDescription').textContent=current.description;
  document.title='cloudproxy · '+current.title;
  field('pause').hidden=settingsOpen;
  if(settingsOpen){field('live').textContent='配置管理';field('live').className='status paused';if(!loaded&&!loading)load()}
  else if(paused){field('live').textContent='已暂停 · 保留当前数据';field('live').className='status paused'}
  else update();
 }
 const sections={Account:'账户与调度',Nodes:'上游配置',Targets:'目标范围',Logs:'日志与网络'};
 function section(name){for(const key of Object.keys(sections)){field('settings'+key).hidden=key!==name;field('tab'+key).setAttribute('aria-pressed',String(key===name))}}
 for(const key of Object.keys(sections))field('tab'+key).onclick=()=>section(key);
 // Validate one field at a time, revealing its group before browser focus.
 field('settingsForm').noValidate=true;
 for(const [key,item]of Object.entries(pages))field(item.button).onclick=()=>view(key);
 field('openConnections').onclick=()=>view('connections');
 for(const [id,name]of [['manageNodes','Nodes'],['openAccount','Account'],['openLogs','Logs']])field(id).onclick=()=>{section(name);view('settings')};
 function labelled(parent,label,type,value,name){const wrap=document.createElement('label');wrap.className='setting-field';const text=document.createElement('span');text.textContent=label;const input=document.createElement('input');input.type=type;input.value=value??'';input.dataset.name=name;input.autocomplete='off';if(type==='number'){input.min='0';input.step='any';input.required=true}wrap.append(text,input);parent.append(wrap);return input}
 function nodeEditor(node={provider:'custom',region:'',url:''}){
  const box=document.createElement('article');box.className='node-editor';
  const top=document.createElement('div');top.className='node-editor-head';
  const provider=document.createElement('select');provider.setAttribute('aria-label','节点平台');provider.dataset.name='provider';
  for(const [value,label]of [['cloudflare','Cloudflare Workers Free'],['edgeone','腾讯 EdgeOne · 兼容节点'],['esa','阿里云 ESA · 兼容节点'],['tencent','腾讯云 SCF（付费估算）'],['custom','通用 WSS/TCP · 其他厂商或自建']]){const option=document.createElement('option');option.value=value;option.textContent=label;provider.append(option)}provider.value=node.provider||'tencent';
  const enabled=document.createElement('label');const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=!node.disabled;checkbox.dataset.name='enabled';enabled.append(checkbox,document.createTextNode('启用'));
  const remove=document.createElement('button');remove.type='button';remove.textContent='移除节点';remove.onclick=()=>{box.remove();setDirty(true)};top.append(provider,enabled,remove);box.append(top);
  const grid=document.createElement('div');grid.className='setting-grid';box.append(grid);
  labelled(grid,'节点名称 / 区域','text',node.region,'region').required=true;labelled(grid,'节点地址（wss://…/tunnel）','url',node.url,'url').required=true;
  const token=labelled(grid,'节点令牌（留空保留现有值；新节点留空使用项目默认令牌）','password','','token');token.placeholder='不会显示已保存令牌';
  const quota=labelled(grid,'Cloudflare 配额组（同账号的节点请使用同一组名）','text',node.quota_group||'','quota_group');
  const rates=document.createElement('div');rates.className='setting-grid';box.append(rates);const defaults={compute_yuan_per_second:.000013885,traffic_yuan_per_gb:.8,request_yuan:.00000133};const values=node.rates||(node.provider==='tencent'||!node.provider?defaults:{});
  labelled(rates,'计算费 · 元/连接秒','number',values.compute_yuan_per_second,'compute');labelled(rates,'流量费 · 元/GB','number',values.traffic_yuan_per_gb,'traffic');labelled(rates,'调用费 · 元/次','number',values.request_yuan,'request');
  const note=document.createElement('p');note.className='settings-note';box.append(note);const notes={cloudflare:'免费额度：账号每天 100,000 请求；本地默认限制 90,000。已有原生 TCP Worker。',edgeone:'Makers 免费版：Cloud Functions 每月 100 万次、50 万 GB-s，单次最长 120 秒。当前实测 WebSocket/TCP 未通过，请勿启用未经验证的部署。',esa:'ESA 免费版每月 100 Credits，CPU 100 ms、墙钟 120 秒。仅登记已实现协议 2 的兼容端点，不自动部署。',custom:'通用节点必须已实现协议 2，并明确填写真实费率。',tencent:'腾讯云 SCF 与 EdgeOne Makers 是不同产品，按参考费率估算。'};
  const toggle=()=>{rates.hidden=provider.value==='cloudflare';for(const input of rates.querySelectorAll('input'))input.disabled=rates.hidden;quota.parentElement.hidden=provider.value!=='cloudflare';note.textContent=notes[provider.value]};provider.onchange=()=>{for(const input of rates.querySelectorAll('input'))input.value='';toggle();setDirty(true)};toggle();field('nodeEditors').append(box);
 }
 async function load(){if(loading||saving)return;loading=true;loaded=false;field('saveSettings').disabled=true;field('settingsFields').disabled=true;field('saveStatus').textContent='正在读取配置…';try{const result=await json('/api/settings');csrf=result.csrf_token;const s=result.settings;field('configUser').value=s.user;field('configPassword').value='';field('configBudget').value=s.monthly_limit_yuan;field('configStrategy').value=s.routing_strategy;field('configPaid').checked=!s.paid_fallback_disabled;field('configCFDaily').value=s.cloudflare_daily_limit;const logging=s.logging||{enabled:true,max_file_mb:5,backups:2};field('configLogEnabled').checked=logging.enabled;field('configLogMB').value=logging.max_file_mb;field('configLogBackups').value=logging.backups;field('configNodeNetwork').value=s.node_network||'auto';field('configAllow').value=(s.target_allow||[]).join('\n');field('configDeny').value=(s.target_deny||[]).join('\n');field('configPorts').value=(s.target_ports||[]).join(', ');field('nodeEditors').replaceChildren();for(const n of s.nodes)nodeEditor(n);field('saveStatus').textContent='配置已加载。密码和节点令牌不会回显；留空表示保留。';loaded=true;setDirty(false)}catch(e){field('saveStatus').textContent='读取失败：'+e.message}finally{loading=false;field('saveSettings').disabled=!loaded;field('settingsFields').disabled=!loaded}}
 field('addNode').onclick=()=>{if(!loaded||saving)return;nodeEditor();setDirty(true)};field('reloadSettings').onclick=()=>{if(!dirty||window.confirm('重新读取会丢弃尚未保存的修改，是否继续？'))load()};
 function lines(value){return value.split(/\n/).map(s=>s.trim()).filter(Boolean)}
 field('settingsForm').onsubmit=async event=>{
  event.preventDefault();if(!loaded||saving)return;
  const invalid=field('settingsForm').querySelector('input:invalid, select:invalid, textarea:invalid');
  if(invalid){const group=invalid.closest('.settings-section');if(group)section(group.id.replace('settings',''));invalid.reportValidity();return}
  saving=true;const button=field('saveSettings');button.disabled=true;field('settingsFields').disabled=true;field('saveStatus').textContent='正在保存…';
  try{
   const nodes=[...field('nodeEditors').children].map(box=>{const get=name=>box.querySelector('[data-name="'+name+'"]');const n={provider:get('provider').value,region:get('region').value.trim(),url:get('url').value.trim(),token:get('token').value,disabled:!get('enabled').checked,quota_group:get('quota_group').value.trim()};if(n.provider!=='cloudflare')n.rates={compute_yuan_per_second:Number(get('compute').value),traffic_yuan_per_gb:Number(get('traffic').value),request_yuan:Number(get('request').value)};return n});
   const ports=field('configPorts').value.trim();const payload={user:field('configUser').value.trim(),password:field('configPassword').value,monthly_limit_yuan:Number(field('configBudget').value),logging:{enabled:field('configLogEnabled').checked,max_file_mb:Number(field('configLogMB').value),backups:Number(field('configLogBackups').value)},node_network:field('configNodeNetwork').value,routing_strategy:field('configStrategy').value,paid_fallback_disabled:!field('configPaid').checked,cloudflare_daily_limit:Number(field('configCFDaily').value),target_allow:lines(field('configAllow').value),target_deny:lines(field('configDeny').value),target_ports:ports?ports.split(/[,，\s]+/).map(Number):[],nodes};
   const response=await fetch(new URL('/api/settings',location.origin),{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},credentials:'same-origin',body:JSON.stringify(payload)});
   if(!response.ok)throw Error(await response.text());const result=await response.json();field('configPassword').value='';for(const token of document.querySelectorAll('[data-name="token"]'))token.value='';
   setDirty(false);field('saveStatus').textContent=result.reauthenticate?'已保存。账号已变化，请刷新页面，用新账号密码重新登录。':'已保存并即时生效。已有连接保持原状态，新连接使用新配置。';if(result.reauthenticate){paused=true;loaded=false}
  }catch(e){field('saveStatus').textContent='保存失败：'+e.message}finally{saving=false;button.disabled=!loaded;field('settingsFields').disabled=!loaded}
 };
})();
