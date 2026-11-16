(()=>{
 let csrf='',loaded=false;
 const field=id=>document.getElementById(id);
 function view(settings){settingsOpen=settings;if(settings){field('live').textContent='配置管理 · 保存即时生效';field('live').className='status'};field('monitorView').hidden=settings;field('settingsView').hidden=!settings;if(settings)load();else update()}
 field('showSettings').onclick=()=>view(true);field('showMonitor').onclick=()=>view(false);
 function labelled(parent,label,type,value,name){const wrap=document.createElement('label');wrap.className='setting-field';const text=document.createElement('span');text.textContent=label;const input=document.createElement('input');input.type=type;input.value=value??'';input.dataset.name=name;input.autocomplete='off';if(type==='number'){input.min='0';input.step='any'}wrap.append(text,input);parent.append(wrap);return input}
 function nodeEditor(node={provider:'cloudflare',region:'Cloudflare Global',url:''}){
  const box=document.createElement('article');box.className='node-editor';
  const top=document.createElement('div');top.className='node-editor-head';
  const provider=document.createElement('select');provider.setAttribute('aria-label','节点平台');provider.dataset.name='provider';
  for(const [value,label]of [['tencent','腾讯云 SCF（付费估算）'],['cloudflare','Cloudflare Workers Free'],['custom','其他平台 · 通用 WSS 节点']]){const option=document.createElement('option');option.value=value;option.textContent=label;provider.append(option)}provider.value=node.provider||'tencent';
  const enabled=document.createElement('label');const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=!node.disabled;checkbox.dataset.name='enabled';enabled.append(checkbox,document.createTextNode('启用'));
  const remove=document.createElement('button');remove.type='button';remove.textContent='移除节点';remove.onclick=()=>box.remove();top.append(provider,enabled,remove);box.append(top);
  const grid=document.createElement('div');grid.className='setting-grid';box.append(grid);
  labelled(grid,'节点名称 / 区域','text',node.region,'region');labelled(grid,'节点地址（wss://…/tunnel）','url',node.url,'url');
  const token=labelled(grid,'节点令牌（留空保留现有值；新节点留空使用项目默认令牌）','password','','token');token.placeholder='不会显示已保存令牌';
  labelled(grid,'Cloudflare 配额组（同账号的节点请使用同一组名）','text',node.quota_group||'','quota_group');
  const rates=document.createElement('div');rates.className='setting-grid';box.append(rates);const defaults={compute_yuan_per_second:.000013885,traffic_yuan_per_gb:.8,request_yuan:.00000133};const values=node.rates||defaults;
  labelled(rates,'计算费 · 元/连接秒','number',values.compute_yuan_per_second,'compute');labelled(rates,'流量费 · 元/GB','number',values.traffic_yuan_per_gb,'traffic');labelled(rates,'调用费 · 元/次','number',values.request_yuan,'request');
  const toggle=()=>{rates.hidden=provider.value==='cloudflare'};provider.onchange=toggle;toggle();field('nodeEditors').append(box);
 }
 async function load(){loaded=false;field('saveStatus').textContent='正在读取配置…';try{const result=await json('/api/settings');csrf=result.csrf_token;const s=result.settings;field('configUser').value=s.user;field('configPassword').value='';field('configBudget').value=s.monthly_limit_yuan;field('configStrategy').value=s.routing_strategy;field('configPaid').checked=!s.paid_fallback_disabled;field('configCFDaily').value=s.cloudflare_daily_limit;const logging=s.logging||{enabled:true,max_file_mb:5,backups:2};field('configLogEnabled').checked=logging.enabled;field('configLogMB').value=logging.max_file_mb;field('configLogBackups').value=logging.backups;field('configNodeNetwork').value=s.node_network||'auto';field('configAllow').value=(s.target_allow||[]).join('\n');field('configDeny').value=(s.target_deny||[]).join('\n');field('configPorts').value=(s.target_ports||[]).join(', ');field('nodeEditors').replaceChildren();for(const n of s.nodes)nodeEditor(n);field('saveStatus').textContent='配置已加载。密码和节点令牌不会回显；留空表示保留。';loaded=true}catch(e){field('saveStatus').textContent='读取失败：'+e.message}}
 field('addNode').onclick=()=>nodeEditor();field('reloadSettings').onclick=load;
 function lines(value){return value.split(/\n/).map(s=>s.trim()).filter(Boolean)}
 field('settingsForm').onsubmit=async event=>{
  event.preventDefault();if(!loaded)return;const button=field('saveSettings');button.disabled=true;field('saveStatus').textContent='正在保存…';
  try{
   const nodes=[...field('nodeEditors').children].map(box=>{const get=name=>box.querySelector('[data-name="'+name+'"]');const n={provider:get('provider').value,region:get('region').value.trim(),url:get('url').value.trim(),token:get('token').value,disabled:!get('enabled').checked,quota_group:get('quota_group').value.trim()};if(n.provider!=='cloudflare')n.rates={compute_yuan_per_second:Number(get('compute').value),traffic_yuan_per_gb:Number(get('traffic').value),request_yuan:Number(get('request').value)};return n});
   const ports=field('configPorts').value.trim();const payload={user:field('configUser').value.trim(),password:field('configPassword').value,monthly_limit_yuan:Number(field('configBudget').value),logging:{enabled:field('configLogEnabled').checked,max_file_mb:Number(field('configLogMB').value),backups:Number(field('configLogBackups').value)},node_network:field('configNodeNetwork').value,routing_strategy:field('configStrategy').value,paid_fallback_disabled:!field('configPaid').checked,cloudflare_daily_limit:Number(field('configCFDaily').value),target_allow:lines(field('configAllow').value),target_deny:lines(field('configDeny').value),target_ports:ports?ports.split(/[,，\s]+/).map(Number):[],nodes};
   const response=await fetch(new URL('/api/settings',location.origin),{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},credentials:'same-origin',body:JSON.stringify(payload)});
   if(!response.ok)throw Error(await response.text());const result=await response.json();field('configPassword').value='';for(const token of document.querySelectorAll('[data-name="token"]'))token.value='';
   field('saveStatus').textContent=result.reauthenticate?'已保存。账号已变化，请刷新页面，用新账号密码重新登录。':'已保存并即时生效。已有连接保持原状态，新连接使用新配置。';if(result.reauthenticate){paused=true;loaded=false}
  }catch(e){field('saveStatus').textContent='保存失败：'+e.message}finally{button.disabled=false}
 };
})();
