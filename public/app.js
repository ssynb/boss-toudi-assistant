import {request, events} from './client.js';
import {$, text, el} from './dom.js';
import {batchPanel} from './batch.js';
import {researchPanel} from './research.js';
import {chatPanel} from './chat.js';

let state, pending=false, sequence=0, pendingAction=null, showingRunMode=false;
const dirty=new Set();
const inputs=$('inputs');
const fail=error=>{text('error',error.message); $('error').hidden=false; $('error').tabIndex=-1; $('error').focus();};
const markDirty=id=>{dirty.add(id);controls();};
function markInputsDirty(){dirty.add('inputs'); inputs.querySelector('output').textContent='有未保存修改'; controls();}
inputs.addEventListener('input',markInputsDirty);

async function mutate(path, method='POST', body, form){
 if(pending) return false;
 pending=true; pendingAction=path; controls(); $('error').hidden=true;
 try {
  const next=await request(`/api/${path}`,method,typeof body==='function'?await body():body);
  if(form){dirty.delete(form.id);if(form===inputs){form.querySelector('output').textContent='已保存';form.elements.file.value='';}}
  sequence++; render(next);
  return true;
 }catch(error){fail(error);return false;}finally{pending=false;pendingAction=null;controls();}
}
function appendRequirements(line){
 const field=inputs.elements.requirements;
 field.value=field.value.trim()?`${field.value.trimEnd()}\n${line}`:line;
 markInputsDirty();
}
const renderBatch=batchPanel({mutate,markDirty,dirty});
const research=researchPanel({mutate,appendRequirements,updateControls:()=>controls()});
const chat=chatPanel({mutate,updateControls:()=>controls()});

/** 发现、调研、对话、批次执行互斥；任一进行中时锁定资料、改稿、清空对话与其他任务的开始。 */
function busy(){return pending || !state || state.discovery.status!=='idle' || state.batch?.status==='running' || state.research.status!=='idle' || state.chat.pending;}
function controls(){
 text('notice',!state?'正在读取…':state.batch?.status==='running'?'执行中，暂停后可编辑':'');
 for(const field of document.querySelectorAll('fieldset')) field.disabled=busy();
 for(const button of document.querySelectorAll('[data-action]')) button.disabled=pending || !state;
 research.controls(state,{pending,pendingAction,locked:busy()});
 chat.controls(state,{locked:busy()});
 if(!state){$('discover').disabled=true;$('send').hidden=true;return;}
 const batch=state.batch;
 const actionable=batch?.targets.some(t=>!t.removed&&t.steps.contact!=='unknown'&&t.steps.greeting!=='unknown'&&(t.steps.contact==='todo'||t.steps.greeting==='todo'));
 $('send').hidden=!batch||!['draft','approved','paused'].includes(batch.status)||!actionable||state.discovery.autoSend||$('auto-send').checked||state.discovery.status!=='idle';
 $('send').disabled=busy()||dirty.size>0;
 text('send',batch?.status==='paused'?'继续投递':'确认投递');
 const status=state.discovery.status;
 text('discover',pendingAction==='discovery/start'?'正在开始…':pendingAction==='discovery/stop'||status==='stopping'?'正在停止…':status==='running'?'停止发现':batch?.status==='running'?'暂停执行':'开始发现');
 $('discover').disabled=pending||status==='stopping'||(status==='idle'&&batch?.status!=='running'&&(busy()||dirty.size>0||!state.codex.signedIn||!state.requirements.trim()||!state.resume.text.trim()));
 text('save',pendingAction==='inputs'?'正在保存…':'保存');
 for(const radio of document.getElementsByName('mode')) radio.disabled=busy();
 // 运行中显示本轮实际方式；结束后回到「只找岗位」，自动投递不延续到下一轮。
 if(status!=='idle'||batch?.status==='running'){$(state.discovery.autoSend?'auto-send':'draft-only').checked=true;showingRunMode=true;}
 else if(showingRunMode){$('draft-only').checked=true;showingRunMode=false;}
 $('discovery-activity').hidden=status==='idle'&&batch?.status!=='running';
}
function elapsed(){
 const discovery=state?.discovery;
 if(!discovery?.startedAt){text('elapsed','');return;}
 const seconds=Math.max(0,Math.floor(((discovery.finishedAt?Date.parse(discovery.finishedAt):Date.now())-Date.parse(discovery.startedAt))/1000));
 text('elapsed',`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`);
}
async function refresh(){
 const ticket=++sequence;
 try{const next=await request('/api/state'); if(ticket===sequence&&!pending) render(next);}catch(error){fail(error);}
}
const pageNames={closed:'BOSS 登录',unknown:'BOSS · 状态未知',loggedOut:'BOSS 登录',verify:'BOSS · 请完成验证',ready:'BOSS · 已登录'};
function render(next){
 state=next;
 if(!dirty.has('inputs')){
  inputs.elements.requirements.value=state.requirements;
  inputs.elements.resumeText.value=state.resume.text;
  $('resume-body').hidden=!(state.resume.file&&['.pdf','.docx'].includes(state.resume.file.extension));
  text('file',state.resume.file?.fileName ?? '');
 }
 text('codex',state.codex.signedIn?`Codex · ${state.codex.email ?? '已登录'}`:'Codex 登录');
 $('codex').dataset.ok=String(state.codex.signedIn);
 $('codex').hidden=Boolean(state.codex.pendingLoginUrl);
 if(state.codex.error)fail(new Error(state.codex.error));
 const url=state.codex.pendingLoginUrl;
 $('login').hidden=!url; if(url){const parsed=new URL(url); if(parsed.protocol==='https:') $('login').href=url; else $('login').removeAttribute('href');}
 text('browser',pageNames[state.browser.page]);
 $('browser').dataset.ok=String(state.browser.page==='ready');
 elapsed();
 text('discovery',state.discovery.message || ({idle:'',running:'正在发现…',stopping:'等待当前读取结束'}[state.discovery.status]));
 $('clarification').hidden=state.discovery.questions.length===0;
 $('questions').replaceChildren(...state.discovery.questions.map(question=>el('li',{textContent:question})));
 renderBatch(state); research.render(state); chat.render(state); controls();
}
inputs.elements.file.addEventListener('change',()=>{
 const file=inputs.elements.file.files[0];
 inputs.elements.resumeText.value='';
 $('resume-body').hidden=!file||!(/\.(pdf|docx)$/i.test(file.name));
 text('file',file?`${file.name} · 未保存`:state.resume.file?.fileName ?? '');
 markInputsDirty();
});
async function inputsBody(){
 const form=inputs.elements;
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
inputs.addEventListener('submit',event=>{event.preventDefault();mutate('inputs','PUT',inputsBody,inputs);});
for(const radio of document.getElementsByName('mode')) radio.addEventListener('change',controls);
$('discover').onclick=()=>{
 if(state.discovery.status==='running')return mutate('discovery/stop');
 if(state.batch?.status==='running')return mutate('batch/pause');
 mutate('discovery/start','POST',{autoSend:$('auto-send').checked});
};
$('send').onclick=()=>{if(confirm('确认联系列表中尚未处理的岗位并发送对应招呼原文？结果未确认的动作不会重试。'))mutate('batch/start','POST',{version:state.batch.version});};
for(const button of document.querySelectorAll('[data-action]')) button.onclick=()=>mutate(button.dataset.action);
window.addEventListener('focus',()=>{if(!pending)void refresh();});
window.addEventListener('beforeunload',event=>{if(dirty.size){event.preventDefault();event.returnValue='';}});
controls();
await refresh();
setInterval(elapsed,1000);
events((name,data)=>{if(name==='changed')refresh();if(name==='log'){$('logs').append(el('li',{textContent:`${data.at} ${data.text}`}));if($('logs').children.length>100)$('logs').firstChild.remove();}}).then(()=>fail(new Error('实时连接已断开。请重新加载页面恢复实时进度。'))).catch(fail);
