import {request, events} from './client.js';
const $ = id => document.getElementById(id);
let state, pending=false, sequence=0, pendingAction=null;
const dirty=new Set();
const text=(id,value)=>{$(id).textContent=value ?? '';};
const fail=error=>{text('error',error.message); $('error').hidden=false; $('error').tabIndex=-1; $('error').focus();};
const forms=[...document.forms];
for(const form of forms) form.addEventListener('input',()=>{dirty.add(form.id); form.querySelector('output').textContent='有未保存修改';});
function fill(id, values){
 if(dirty.has(id)) return;
 for(const [key,value] of Object.entries(values)) {
  const input=$(id).elements.namedItem(key); if(!input) continue;
  if(input.type==='checkbox') input.checked=value; else input.value=value ?? '';
 }
}
function busy(){return pending || state?.discovery.status!=='idle' || state?.batch?.status==='running';}
function controls(){
 text('notice',!state?'正在读取…':state.batch?.status==='running'?'执行中，暂停后可编辑':'');
 for(const field of document.querySelectorAll('fieldset')) field.disabled=busy();
 for(const button of document.querySelectorAll('[data-action]')) {
  const action=button.dataset.action;
  button.disabled=pending || !state || (action==='batch/start' && (dirty.size>0||!['approved','paused'].includes(state.batch?.status))) || (action==='batch/pause' && state.batch?.status!=='running');
 }
 $('approve').disabled=busy()||dirty.size>0||state?.batch?.status!=='draft';
 const status=state?.discovery.status;
 text('discover',pendingAction==='discovery/start'?'正在开始…':pendingAction==='discovery/stop'||status==='stopping'?'正在停止…':status==='running'?'停止发现':'开始发现');
 $('discover').disabled=pending||!state||status==='stopping'||(status==='idle'&&(busy()||dirty.size>0||!state.codex.signedIn||!state.requirements.trim()||!state.resume.text.trim()));
 text('save',pendingAction==='inputs'?'正在保存…':'保存');
}
function elapsed(){
 const discovery=state?.discovery;
 if(!discovery?.startedAt){text('elapsed','');return;}
 const seconds=Math.max(0,Math.floor(((discovery.finishedAt?Date.parse(discovery.finishedAt):Date.now())-Date.parse(discovery.startedAt))/1000));
 text('elapsed',`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`);
}
async function mutate(path, method='POST', body, form, headers){
 if(pending) return;
 pending=true; pendingAction=path; controls(); $('error').hidden=true;
 try {
  const next=await request(`/api/${path}`,method,typeof body==='function'?await body():body,headers);
  if(form){dirty.delete(form.id);if(form.id==='inputs'){form.querySelector('output').textContent='已保存';form.elements.file.value='';}}
  sequence++; render(next);
 }catch(error){fail(error);}finally{pending=false;pendingAction=null;controls();}
}
async function refresh(){
 const ticket=++sequence;
 try{const next=await request('/api/state'); if(ticket===sequence&&!pending) render(next);}catch(error){fail(error);}
}
function render(next){
 state=next;
 fill('inputs',{requirements:state.requirements});
 if(!dirty.has('inputs')){
  $('inputs').elements.resumeText.value=state.resume.text;
  $('resume-body').hidden=!(state.resume.file&&['.pdf','.docx'].includes(state.resume.file.extension));
  text('file',state.resume.file?.fileName ?? '');
 }
 text('codex',state.codex.signedIn?`Codex · ${state.codex.email ?? '已登录'}`:'Codex 登录');
 $('codex').hidden=Boolean(state.codex.pendingLoginUrl);
 if(state.codex.error)fail(new Error(state.codex.error));
 const url=state.codex.pendingLoginUrl;
 $('login').hidden=!url; if(url){const parsed=new URL(url); if(parsed.protocol==='https:') $('login').href=url; else $('login').removeAttribute('href');}
 text('browser',({closed:'BOSS 登录',unknown:'BOSS · 状态未知',loggedOut:'BOSS 登录',verify:'BOSS · 请完成验证',ready:'BOSS · 已登录'}[state.browser.page]));
 elapsed();
 text('discovery',state.discovery.message || ({idle:'',running:'正在发现…',stopping:'等待当前读取结束'}[state.discovery.status]));
 $('clarification').hidden=state.discovery.questions.length===0;
 $('questions').replaceChildren(...state.discovery.questions.map(question=>{const li=document.createElement('li');li.textContent=question;return li;}));
 renderBatch(); controls();
}
const stepNames={todo:'未开始',inflight:'进行中',done:'已完成',skipped:'已跳过',failed:'未发生',unknown:'结果未确认 · 请到 BOSS 核查，不自动重试'};
function cell(row,className){const td=document.createElement('td');td.className=className;row.append(td);return td;}
function targetRow(target){
 const row=document.createElement('tr');row.id=`target-${target.id}`;row.dataset.id=target.id;
 const job=cell(row,'job');job.append(document.createElement('strong'),document.createElement('span'));
 cell(row,'salary');cell(row,'reason');
 const input=document.createElement('textarea');input.name='greeting';input.rows=3;input.maxLength=200;input.setAttribute('aria-label','招呼原文');cell(row,'greeting').append(input);
 const remove=document.createElement('button');remove.type='button';remove.textContent='移除';
 const progress=document.createElement('span');cell(row,'action').append(remove,progress);
 const path=`batch/targets/${encodeURIComponent(target.id)}`;
 input.addEventListener('input',()=>{dirty.add(row.id);controls();});
 input.addEventListener('change',()=>mutate(path,'PATCH',{greeting:input.value},row));
 remove.onclick=()=>mutate(path,'PATCH',{removed:true},row);
 return row;
}
function renderBatch(){
 const batch=state.batch, kept=batch?.targets.filter(t=>!t.removed) ?? [];
 $('batch').hidden=!kept.length; if(!kept.length)return;
 text('batch-state',`${{draft:'待审阅批准',approved:'已批准，尚未执行',running:'正在执行',paused:'已暂停',done:'处理结束'}[batch.status]} · ${kept.length} 个岗位${batch.stopReason?' · '+batch.stopReason:''}`);
 const ids=new Set(kept.map(t=>t.id));
 for(const row of [...$('targets').rows]) if(!ids.has(row.dataset.id)){dirty.delete(row.id);row.remove();}
 for(const target of kept){
  const row=$(`target-${target.id}`) ?? $('targets').appendChild(targetRow(target));
  row.querySelector('strong').textContent=target.title;
  row.querySelector('.job span').textContent=target.company;
  row.querySelector('.salary').textContent=target.salary;
  row.querySelector('.reason').textContent=target.reason;
  if(!dirty.has(row.id))row.querySelector('textarea').value=target.greeting;
  const started=target.steps.contact!=='todo';
  row.querySelector('textarea').readOnly=started;
  row.querySelector('button').hidden=started;
  row.querySelector('.action span').textContent=started?`联系：${stepNames[target.steps.contact]} / 招呼：${stepNames[target.steps.greeting]}${target.evidence?' · '+target.evidence:''}`:'';
 }
}
$('inputs').elements.file.addEventListener('change',()=>{
 const file=$('inputs').elements.file.files[0];
 dirty.add('inputs');
 $('inputs').elements.resumeText.value='';
 $('resume-body').hidden=!file||!(/\.(pdf|docx)$/i.test(file.name));
 text('file',file?`${file.name} · 未保存`:state.resume.file?.fileName ?? '');
 controls();
});
async function inputsBody(){
 const form=$('inputs').elements;
 const file=form.file.files[0];
 const resume={text:null};
 if(file){
  if(file.size>10*1024*1024)throw new Error('简历文件不能超过 10 MB');
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('读取文件失败，请重新选择'));reader.readAsDataURL(file);});
  resume.file={fileName:file.name,base64:data.slice(data.indexOf(',')+1)};
 }
 if(!$('resume-body').hidden)resume.text=form.resumeText.value;
 return {requirements:form.requirements.value,resume};
}
$('inputs').addEventListener('submit',event=>{event.preventDefault();mutate('inputs','PUT',inputsBody,$('inputs'));});
$('discover').onclick=()=>mutate(state.discovery.status==='running'?'discovery/stop':'discovery/start');
$('approve').onclick=()=>{if(confirm('确认批准联系列表中的岗位并发送对应招呼原文？'))mutate('batch/approve','POST',{version:state.batch.version});};
for(const button of document.querySelectorAll('[data-action]')) button.onclick=()=>mutate(button.dataset.action);
for(const form of forms) form.addEventListener('input',controls);
window.addEventListener('focus',()=>{if(!pending)void refresh();});
window.addEventListener('beforeunload',event=>{if(dirty.size){event.preventDefault();event.returnValue='';}});
controls();
await refresh();
setInterval(elapsed,1000);
events((name,data)=>{if(name==='changed')refresh();if(name==='log'){const li=document.createElement('li');li.textContent=`${data.at} ${data.text}`;$('logs').append(li);if($('logs').children.length>100)$('logs').firstChild.remove();}}).then(()=>fail(new Error('实时连接已断开。请重新加载页面恢复实时进度。'))).catch(fail);
