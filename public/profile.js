import {$, text} from './dom.js';

/** 个人信息：简历文件、正文、固定招呼语与可选求职偏好，一次 PUT /api/inputs 保存；未保存的草稿不被刷新覆盖。 */
export function profilePanel({mutate, dirty, updateControls}) {
 const form = $('inputs');
 let current = null;
 const count = () => text('greeting-count', `${form.elements.greeting.value.length}/${form.elements.greeting.maxLength}`);
 const markDirty = () => { dirty.add('inputs'); form.querySelector('output').textContent = '有未保存修改'; updateControls(); };
 form.addEventListener('input', markDirty);
 form.elements.greeting.addEventListener('input', count);
 form.elements.file.addEventListener('change', () => {
  const file = form.elements.file.files[0];
  form.elements.resumeText.value = '';
  $('resume-body').hidden = !file || !/\.(pdf|docx)$/i.test(file.name);
  text('file', file ? `${file.name} · 未保存` : current?.resume.file?.fileName ?? '');
  markDirty();
 });
 async function body() {
  const file = form.elements.file.files[0];
  const resume = {text:null};
  if (file) {
   if (file.size > 10 * 1024 * 1024) throw new Error('简历文件不能超过 10 MB');
   const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('读取文件失败，请重新选择')); reader.readAsDataURL(file); });
   resume.file = {fileName:file.name, base64:data.slice(data.indexOf(',') + 1)};
  }
  if (!$('resume-body').hidden) resume.text = form.elements.resumeText.value;
  return {requirements:form.elements.requirements.value, greeting:form.elements.greeting.value, resume};
 }
 form.addEventListener('submit', async event => {
  event.preventDefault();
  if (await mutate('inputs', 'PUT', body)) {
   dirty.delete('inputs'); form.querySelector('output').textContent = '已保存'; form.elements.file.value = '';
   render(current);
  }
 });
 function render(state) {
  current = state;
  if (dirty.has('inputs')) return;
  form.elements.requirements.value = state.requirements;
  form.elements.greeting.value = state.greeting;
  count();
  form.elements.resumeText.value = state.resume.text;
  $('resume-body').hidden = !(state.resume.file && ['.pdf', '.docx'].includes(state.resume.file.extension));
  text('file', state.resume.file?.fileName ?? '尚未上传');
 }
 function controls(state, {pendingAction, locked}) {
  form.querySelector('fieldset').disabled = locked;
  text('save', pendingAction === 'inputs' ? '正在保存…' : '保存');
 }
 return {render, controls};
}
