import {request, events} from './client.js';
const $ = id => document.getElementById(id);
let state, pending=false, sequence=0;
const dirty=new Set();
const text=(id,value)=>{$(id).textContent=value ?? '';};
const fail=error=>{text('error',error.message); $('error').hidden=false; $('error').tabIndex=-1; $('error').focus();};
const split=value=>value.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean);
const forms=[...document.forms];
for(const form of forms) form.addEventListener('input',()=>{dirty.add(form.id); form.querySelector('output').textContent='有未保存修改';});
function fill(id, values){
 if(dirty.has(id)) return;
 for(const [key,value] of Object.entries(values)) {
  const input=$(id).elements.namedItem(key); if(!input) continue;
  if(input.type==='checkbox') input.checked=value; else input.value=Array.isArray(value)?value.join('，'):value ?? '';
 }
}
function busy(){return pending || state?.discovery.status!=='idle' || state?.batch?.status==='running';}
function controls(){
 text('notice',!state?'正在读取本机状态…':state.discovery.status!=='idle'||state.batch?.status==='running'?'发现或执行期间编辑已锁定；暂停会在当前步骤收尾后停止。':'');
 for(const field of document.querySelectorAll('fieldset')) field.disabled=busy();
 for(const button of document.querySelectorAll('[data-action]')) {
  const action=button.dataset.action;
  button.disabled=pending || (action==='discovery/start' && (busy()||dirty.size>0||!state?.codex.signedIn||!state?.resume.textConfirmed||state?.browser.page!=='ready')) || (action==='discovery/stop' && state?.discovery.status!=='running') || (action==='batch/start' && (dirty.size>0||!['approved','paused'].includes(state?.batch?.status))) || (action==='batch/pause' && state?.batch?.status!=='running');
 }
 $('approve').disabled=busy()||dirty.size>0||state?.batch?.status!=='draft';
 $('delete').disabled=busy();
}
async function mutate(path, method='POST', body, form, headers){
 if(pending) return;
 pending=true; controls(); $('error').hidden=true;
 try {
  const next=await request(`/api/${path}`,method,body,headers);
  if(form){dirty.delete(form.id);form.querySelector('output').textContent='已保存';}
  sequence++; render(next);
 }catch(error){fail(error);}finally{pending=false;controls();}
}
async function refresh(){
 const ticket=++sequence;
 try{const next=await request('/api/state'); if(ticket===sequence&&!pending) render(next);}catch(error){fail(error);}
}
function render(next){
 state=next;
 fill('profile',state.profile);fill('criteria',state.criteria);fill('resume',{text:state.resume.text,confirmed:state.resume.textConfirmed});
 text('codex',state.codex.signedIn?`Codex 已登录 · ${state.codex.email ?? ''}`:'Codex 未登录');
 if(state.codex.error) text('codex',state.codex.error);
 const url=state.codex.pendingLoginUrl;
 $('login').hidden=!url; if(url){const parsed=new URL(url); if(parsed.protocol==='https:') $('login').href=url; else $('login').removeAttribute('href');}
 text('browser',`BOSS · ${{closed:'尚未打开',unknown:'页面状态未知',loggedOut:'请在独立窗口登录',verify:'请本人完成安全验证',ready:'已就绪'}[state.browser.page]}`);
 $('doctor').replaceChildren(...state.doctor.map(check=>{const li=document.createElement('li');li.textContent=`${check.ok?'通过':'未通过'} · ${check.detail}`;return li;}));
 text('count',`去重账本已记录 ${state.contactedCount} 个已联系或结果未确认的岗位`);
 text('file',state.resume.file?`${state.resume.file.fileName} · ${Math.ceil(state.resume.file.sizeBytes/1024)} KB`:'尚未上传文件');
 text('discovery',state.discovery.message || ({idle:'准备就绪后可开始发现',running:'正在发现岗位…',stopping:'正在停止，请等待当前读取结束'}[state.discovery.status]));
 renderBatch(); controls();
}
const stepNames={todo:'未开始',inflight:'进行中',done:'已核实完成',skipped:'已跳过',failed:'已核实未发生',unknown:'结果未确认 · 请到 BOSS 核查，不自动重试'};
function renderBatch(){
 const batch=state.batch; $('batch').hidden=!batch; if(!batch)return;
 text('batch-state',`${{draft:'待审阅批准',approved:'已批准，尚未执行',running:'正在执行',paused:'已暂停',done:'处理结束（请逐步查看结果）'}[batch.status]} · 版本 ${batch.version} · ${batch.targets.filter(t=>!t.removed).length} 个保留目标${batch.stopReason?' · '+batch.stopReason:''}`);
 fill('delivery',batch.resumeDelivery);
 const ids=new Set(batch.targets.map(t=>t.id));
 for(const child of [...$('targets').children]) if(!ids.has(child.dataset.id)){dirty.delete(child.id);child.remove();}
 for(const target of batch.targets){
  let form=[...$('targets').children].find(el=>el.dataset.id===target.id);
  if(!form){
   form=document.createElement('form');form.id=`target-${target.id}`;form.dataset.id=target.id;
   const field=document.createElement('fieldset');
   const title=document.createElement('h3');title.className='target-title';field.append(title);
   const link=document.createElement('a');link.textContent='查看岗位';link.target='_blank';link.rel='noopener';field.append(link);
   const reason=document.createElement('p');reason.className='reason';field.append(reason);
   const label=document.createElement('label');label.textContent='定制招呼原文（最多 200 字）';const input=document.createElement('textarea');input.name='greeting';input.rows=3;input.maxLength=200;label.append(input);field.append(label);
   const remove=document.createElement('label');remove.className='check';const checkbox=document.createElement('input');checkbox.name='removed';checkbox.type='checkbox';remove.append(checkbox,'从本批移除');field.append(remove);
   const save=document.createElement('button');save.textContent='保存此目标';field.append(save,document.createElement('output'));form.append(field);
   const progress=document.createElement('p');progress.className='steps';const evidence=document.createElement('p');evidence.className='evidence';form.append(progress,evidence);
   form.addEventListener('input',()=>{dirty.add(form.id);form.querySelector('output').textContent='有未保存修改';controls();});
   form.addEventListener('submit',event=>{event.preventDefault();mutate(`batch/targets/${encodeURIComponent(target.id)}`,'PATCH',{greeting:input.value,removed:checkbox.checked},form);});
   $('targets').append(form);
  }
  form.querySelector('h3').textContent=`${target.company} · ${target.title} · ${target.salary}`;
  const link=form.querySelector('a');try{const url=new URL(target.url); if(['https:','http:'].includes(url.protocol))link.href=url.href;else link.removeAttribute('href');}catch{link.removeAttribute('href');}
  form.querySelector('.reason').textContent=target.reason;
  fill(form.id,{greeting:target.greeting,removed:target.removed});
  form.querySelector('.steps').textContent=`联系：${stepNames[target.steps.contact]}　 /　 招呼：${stepNames[target.steps.greeting]}　 /　 附件：${stepNames[target.steps.resume]}`;
  form.querySelector('.evidence').textContent=target.evidence;
 }
}
for(const city of ['全国','北京','上海','广州','深圳','杭州','南京','苏州','成都','武汉','西安','重庆','天津','长沙','郑州','厦门']) $('criteria').elements.city.add(new Option(city,city));
function submit(id,path,method,read){$(id).addEventListener('submit',event=>{event.preventDefault();mutate(path,method,read($(id).elements),$(id));});}
submit('profile','profile','PUT',e=>({name:e.name.value,notes:e.notes.value}));
submit('criteria','criteria','PUT',e=>({keywords:split(e.keywords.value),city:e.city.value,salaryMinK:e.salaryMinK.value===''?null:Number(e.salaryMinK.value),maxTargets:Number(e.maxTargets.value),excludeCompanies:split(e.excludeCompanies.value)}));
submit('resume','resume/text','PUT',e=>({text:e.text.value,confirmed:e.confirmed.checked}));
submit('delivery','batch','PATCH',e=>({resumeDelivery:{enabled:e.enabled.checked,bossAttachmentName:e.bossAttachmentName.value,bossAttachmentConfirmed:e.bossAttachmentConfirmed.checked}}));
$('delivery').elements.bossAttachmentName.addEventListener('input',()=>{$('delivery').elements.bossAttachmentConfirmed.checked=false;});
$('resume').elements.text.addEventListener('input',()=>{$('resume').elements.confirmed.checked=false;});
$('upload').addEventListener('submit',event=>{event.preventDefault();if(dirty.has('resume')&&!confirm('上传会替换已保存正文。先保存当前正文，或取消后继续编辑。仍要上传？'))return;const file=$('upload').elements.file.files[0];mutate('resume/file','POST',file,$('upload'),{'X-File-Name':encodeURIComponent(file.name)});});
$('delete').onclick=()=>{if(confirm('删除本机保存的简历文件与正文？'))mutate('resume','DELETE');};
$('approve').onclick=()=>{if(confirm('确认批准本批保留目标的联系、招呼原文及附件设置？'))mutate('batch/approve','POST',{version:state.batch.version});};
for(const button of document.querySelectorAll('[data-action]')) button.onclick=()=>mutate(button.dataset.action);
for(const form of forms) form.addEventListener('input',controls);
$('refresh').onclick=refresh;
window.addEventListener('beforeunload',event=>{if(dirty.size){event.preventDefault();event.returnValue='';}});
controls();
await refresh();
events((name,data)=>{if(name==='changed')refresh();if(name==='log'){const li=document.createElement('li');li.textContent=`${data.at} ${data.text}`;$('logs').append(li);if($('logs').children.length>100)$('logs').firstChild.remove();}}).then(()=>fail(new Error('实时连接已断开。请重新加载页面恢复实时进度。'))).catch(fail);
