export async function request(path, method = 'GET', body, headers = {}) {
 const options = {method, headers:{'X-Boss-Local':'1', ...headers}};
 if (body !== undefined) {
  options.body = body instanceof Blob ? body : JSON.stringify(body);
  if (!(body instanceof Blob)) options.headers['Content-Type']='application/json';
 }
 const response = await fetch(path, options);
 const data = await response.json();
 if (!response.ok) throw new Error(data.error?.message || `请求失败（${response.status}）`);
 return data;
}
export async function events(notify) {
 const response = await fetch('/api/events',{headers:{'X-Boss-Local':'1'}});
 if (!response.ok || !response.body) throw new Error(`事件连接失败（${response.status}）`);
 let buffer='';
 for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
  buffer += chunk.replaceAll('\r','');
  let end;
  while ((end=buffer.indexOf('\n\n')) !== -1) {
   const lines=buffer.slice(0,end).split('\n'); buffer=buffer.slice(end+2);
   const name=lines.find(x=>x.startsWith('event:'))?.slice(6).trim();
   const data=lines.filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');
   if(name) notify(name,data ? JSON.parse(data) : null);
  }
 }
}
