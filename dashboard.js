
'use strict';
const $=id=>document.getElementById(id);let data=[],paused=false,settingsOpen=false,busy=false,serverNow=Date.now(),selected=null;
const categories={local_policy:'本地拒绝',authentication:'认证未完成',client_disconnect:'客户端断开',budget:'预算保护',local_limit:'退避 / 限制',target_connect:'目标不可达',provider_target:'当前平台不可达',target_network:'目标网络不可达',upstream:'节点 / 传输错误',connection_limit:'连接保护',shutdown:'服务更新'};const localCategories=['local_policy','budget','local_limit','connection_limit','shutdown'];const clientCategories=['client_disconnect','authentication'];const isFailure=r=>r.state==='failed'&&!localCategories.includes(r.error_category)&&!clientCategories.includes(r.error_category);const rowLabel=r=>r.error_category?categories[r.error_category]||'连接错误':labels[r.state];
const labels={negotiating:'握手 / 认证',queued:'等待连接',connecting:'正在连接',connected:'已连接',closed:'已结束',failed:'失败'};
function responseSummary(r){
  if(r.error)return {text:r.error,tone:'error'};
  if(r.state==='failed')return {text:'连接失败 · 未记录原始错误'+(r.http_status?' · HTTP '+r.http_status:''),tone:'error'};
  const retried=(r.attempts||[]).some(a=>a.error);
  const retryNote=retried?' · 曾重试，详情含原始错误':'';
  if(r.http_status){
    const code=r.http_status;
    const label=code>=500?'服务器错误':code>=400?'客户端错误':code>=300?'重定向':code>=200?'成功响应':'信息响应';
    return {text:'HTTP '+code+' · '+label+retryNote,tone:code>=400?'error':code>=200&&code<300?'success':''};
  }
  if(r.connected||r.state==='connected')return {text:(r.ended||r.state==='closed'?'TCP 连接成功 · 已正常结束':'TCP 连接成功 · 传输中')+retryNote,tone:'success'};
  if(r.ended||r.state==='closed')return {text:'已结束 · 未建立目标连接',tone:''};
  const pending={negotiating:'等待握手 / 认证',queued:'等待连接槽位',connecting:'正在连接目标'};
  return {text:(pending[r.state]||'等待连接结果')+retryNote,tone:''};
}
const bytes=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(2)+' MB';
const duration=r=>{let n=Math.max(0,Math.floor(((r.ended?Date.parse(r.ended):serverNow)-Date.parse(r.started))/1000));return Math.floor(n/60)+':'+String(n%60).padStart(2,'0')};
const time=s=>s?new Date(s).toLocaleString():'—';
function cell(row,text,cls){const c=document.createElement('td');c.textContent=text;if(cls)c.className=cls;row.append(c);return c}
function details(r){selected=r.id;let parts=['编号：'+r.id,'来源：'+r.source,'目标：'+(r.target||'尚未提供'),'协议：'+r.protocol,'状态：'+rowLabel(r),'错误 / 响应：'+responseSummary(r).text,'开始：'+time(r.started),'TCP 建连：'+time(r.connected),'结束：'+time(r.ended),'上传 / 下载：'+bytes(r.uploaded)+' / '+bytes(r.downloaded),'区域：'+(r.region||'尚未选择'),'HTTP 响应码：'+(r.http_status||'不适用'),'辅助诊断：'+(r.diagnosis||'无额外诊断'),'','区域尝试（失败后可能换区重试）：'];for(const a of r.attempts||[])parts.push(time(a.started)+' · '+a.region+' · '+(a.error||'未记录失败'));$('detailText').textContent=parts.join('\n')}
function render(){const term=$('search').value.toLowerCase(),state=$('state').value,proto=$('protocol').value;const filtered=data.filter(r=>(state==='all'||(state==='active'?!r.ended:state==='failed'?isFailure(r):state==='rejected'?localCategories.includes(r.error_category):state==='client'?clientCategories.includes(r.error_category):r.state===state))&&(proto==='all'||r.protocol===proto)&&[r.source,r.target,r.error,r.diagnosis,r.region,...(r.attempts||[]).map(a=>a.error)].join(' ').toLowerCase().includes(term));const fragment=document.createDocumentFragment();for(const r of filtered.slice(0,200)){const tr=document.createElement('tr');tr.tabIndex=0;tr.setAttribute('aria-label','连接 '+r.id+' 详情');const first=cell(tr,'');const b=document.createElement('span');b.className='badge '+r.state;b.textContent=rowLabel(r)+' #'+r.id;first.append(b);cell(tr,r.source,'mono');cell(tr,r.target||'尚未提供','mono');cell(tr,r.protocol+' / '+(r.region||'—'));cell(tr,duration(r),'mono');cell(tr,bytes(r.uploaded)+' / '+bytes(r.downloaded),'mono');const response=responseSummary(r);const reason=cell(tr,response.text,'reason '+response.tone);reason.title=reason.textContent;const open=()=>{details(r);$('detail').showModal()};tr.onclick=open;tr.onkeydown=e=>{if(e.key==='Enter')open()};fragment.append(tr)}$('rows').replaceChildren(fragment);$('empty').hidden=filtered.length>0;$('empty').textContent=data.length?'没有符合筛选条件的连接':'暂无连接。让客户端通过代理发起一次访问后，记录会显示在这里。';$('count').textContent='匹配 '+filtered.length+' 条 · 展示前 200 条 · 活跃优先';if($('detail').open){const r=data.find(x=>x.id===selected);if(r)details(r)}}
function renderPool(s){
 const statuses={Healthy:'已验证可连接',Unverified:'尚未验证',Degraded:'近期失败 · 可重试',Cooling:'故障冷却',Disabled:'已停用',PaidBlocked:'付费节点被禁用',Quota:'今日限额已到',Budget:'本地预算不足'};
 const n=s.eligible_nodes??0;
 $('poolHealth').textContent=n?'入口运行中 · '+n+' 个节点可尝试':'入口运行中 · 暂无可选上游';
 $('poolHealthDetail').textContent=n?'已启用 '+s.enabled_nodes+' 个节点，其中零单价 '+s.free_nodes+' 个、有费用 '+s.paid_nodes+' 个。目标可达性以连接明细为准。':'请检查节点启停、冷却、额度和费用设置。重启入口不能解决所有上游限制。';
 $('poolHealth').closest('section').className='health-panel '+(s.readiness||'');
 const seconds=s.uptime_seconds||0; $('uptime').textContent='本次连续运行 '+Math.floor(seconds/86400)+' 天 '+Math.floor(seconds%86400/3600)+' 小时 '+Math.floor(seconds%3600/60)+' 分钟';
 $('buildVersion').textContent='版本 '+(s.version||'未知');
 $('nodes').replaceChildren(...s.nodes.map(n=>{
  const e=document.createElement('article');e.className='node'+(['Cooling','Degraded','Quota','Budget','PaidBlocked'].includes(n.status)?' bad':'')+(n.disabled?' disabled':'');
  const title=document.createElement('strong');title.textContent=n.region;
  const status=document.createElement('span');status.className='node-status';status.textContent=statuses[n.status]||n.status;
  const meta=document.createElement('span');meta.className='node-meta';meta.textContent=(n.provider==='cloudflare'?'Cloudflare':n.provider==='custom'?'通用 WSS/TCP':'腾讯云 SCF')+' · '+(n.free?'零单价模型':'有费用')+' · 建连 '+n.connections;
  const last=document.createElement('span');last.className='node-meta';last.textContent=n.last_success_at?'最近成功 '+time(n.last_success_at):'尚无本次运行的成功记录';
  e.append(title,status,meta,last);
  if(n.retry_at){const retry=document.createElement('span');retry.className='node-meta';retry.textContent='冷却至 '+time(n.retry_at);e.append(retry)}
  if(n.last_error){const error=document.createElement('span');error.className='node-error';error.textContent=n.last_error;e.append(error)}
  return e;
 }));
}
async function json(url){const r=await fetch(new URL(url,location.origin),{cache:'no-store',credentials:'same-origin'});if(!r.ok)throw Error(r.status===401?'登录已失效，请重新打开页面登录':'监控接口返回 HTTP '+r.status);return r.json()}
async function update(){if(paused||settingsOpen||busy)return;busy=true;try{const [s,c]=await Promise.all([json('/api/stats'),json('/api/connections')]);data=c.connections;serverNow=Date.parse(c.server_time);$('active').textContent=c.active;$('capacity').textContent='占用隧道槽位 '+s.opening_or_active+' / '+s.max_connections;$('success').textContent=s.success;$('failed').textContent=data.filter(isFailure).length;const ended=data.filter(r=>r.ended);$('diagnosticSummary').textContent='近期已结束 '+ended.length+' 条：已建连 '+ended.filter(r=>r.connected).length+' · 目标/节点错误 '+ended.filter(isFailure).length+' · 本地拒绝/保护 '+ended.filter(r=>localCategories.includes(r.error_category)).length+' · 客户端断开/认证 '+ended.filter(r=>clientCategories.includes(r.error_category)).length+'。这些类别不应合并为代理故障率。';const logs=s.logging;if(logs){$('logStatus').textContent='本地连接日志：'+(logs.enabled?'已开启':'已关闭')+' · 每类 '+logs.max_file_mb+' MB × '+(logs.backups+1)+' 个文件 · 队列丢弃 '+(logs.events_dropped||0)+' · 写入错误 '+((logs.event_write_errors||0)+(logs.operation_write_errors||0));$('logStatus').style.color=(logs.events_dropped||logs.event_write_errors||logs.operation_write_errors)?'#ffb0ad':'';}const cost=s.cost_estimate;const estimated=typeof cost==='number'?cost:cost.estimated_yuan;$('cost').textContent=typeof estimated==='number'?'¥ '+estimated.toFixed(3):'见详情';$('budget').textContent='保护上限 ¥ '+s.monthly_limit_yuan+' / 月 · 本地估算';const breakdown=s.cost_breakdown;const bill=s.cloud_bill;let detail=breakdown?'本地运行估算 ¥ '+breakdown.usage_estimated_yuan.toFixed(3)+' · 待用预留 ¥ '+breakdown.pending_reserve_yuan.toFixed(3):'本地估算含预留';detail+=' ｜ 腾讯云本月 SCF 已出账合计：'+(bill&&bill.available?'¥ '+bill.scf_total_yuan.toFixed(2)+'（账号全部 SCF，账单可能延迟；更新 '+time(bill.updated_at)+(bill.stale?'，缓存已过期':'')+'）':'未接入或当月数据不可用');$('costDetails').textContent=detail;$('costAudit').hidden=!(cost.legacy_fixed_allowance_removed_yuan>0);if(!$('costAudit').hidden)$('costAudit').textContent='估算校正记录：原 ¥ '+cost.legacy_estimated_yuan.toFixed(3)+'，移除旧算法固定 3 秒余量 ¥ '+cost.legacy_fixed_allowance_removed_yuan.toFixed(3)+'；保留连接次数和流量，这不是云账单退款。失败目标冷却中：'+s.cooling_targets+' 个；本地抑制重复尝试：'+s.cached_target_failures+' 次。';const dailyUsed=Object.values(s.provider_daily_usage||{}).reduce((sum,q)=>sum+q.used,0);$('routingStatus').textContent='调度：'+(s.routing_strategy==='round_robin'?'轮换':'免费优先')+' · '+(s.paid_fallback_disabled?'禁止付费节点':'允许付费节点 · 当前启用 '+s.paid_nodes+' 个')+' · 本入口今日 Cloudflare 尝试 '+dailyUsed+' 次（UTC；每个配额组上限 '+(s.cloudflare_daily_limit??90000)+' 次，不代表账号剩余额度）';renderPool(s);$('live').textContent='● 实时监控中';$('live').className='status';$('alert').hidden=!c.omitted;$('alert').textContent='监控容量保护：已有 '+c.omitted+' 条握手未记录。请检查是否存在异常连接量。';$('updated').textContent='更新于 '+new Date().toLocaleTimeString()+' · 点击行查看详情';render()}catch(e){$('live').textContent='监控连接中断';$('live').className='status bad';$('alert').hidden=false;$('alert').textContent=e.message+'。下方保留上一次数据，不代表当前状态。'}finally{busy=false}}
for(const id of ['search','state','protocol'])$(id).addEventListener('input',render);$('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'恢复刷新':'暂停刷新';if(paused){$('live').textContent='已暂停 · 数据不再更新';$('live').className='status'}else update()};$('close').onclick=()=>$('detail').close();update();setInterval(update,2000);
