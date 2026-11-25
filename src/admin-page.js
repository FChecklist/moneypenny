// Tiny local admin page. It signs calls in the browser with Web Crypto; the secret is never sent or stored.
export function adminPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moneypenny admin</title>
<style>
.mark139{position:absolute;top:0;left:0;right:0;margin:0;padding:1px 0 0;text-align:center;line-height:1;pointer-events:none;user-select:none;z-index:2147483647;font-family:"Noto Sans Devanagari","Mukta","Nirmala UI","Mangal","Kohinoor Devanagari","Devanagari Sangam MN",sans-serif;font-size:6px;font-weight:700;color:#0B2A6B}
.mark139 span{display:inline-block;border-bottom:.5px solid #7A1010;padding-bottom:.5px}
body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:880px;margin-inline:auto;background:#fafaf7;color:#1c1c1c}
h1{font-size:20px} input,button{font:inherit;padding:6px 8px} input{border:1px solid #bbb;border-radius:6px}
table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0} #msg{color:#0b6b57;min-height:1.4em} pre{white-space:pre-wrap;font-size:12px}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee} input{background:#222;color:#eee;border-color:#555}}
</style></head><body>
<div class="mark139" lang="hi" aria-hidden="true"><span>१३९</span></div>
<h1>Moneypenny admin (local)</h1>
<div class="row"><input id="kid" placeholder="admin key id" size="26"><input id="sec" type="password" placeholder="admin key secret" size="26"><button id="load">Load</button></div>
<div id="msg"></div>
<h2>Settings</h2><table id="settings"></table><div class="row"><button id="save">Save changes</button></div>
<h2>Earning rules</h2><table id="rules"></table>
<h2>Recent changes</h2><pre id="audit"></pre>
<script>
const $=id=>document.getElementById(id), enc=new TextEncoder();
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const sha=async s=>hex(await crypto.subtle.digest('SHA-256',enc.encode(s)));
async function hmac(k,m){const key=await crypto.subtle.importKey('raw',enc.encode(k),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',key,enc.encode(m)))}
async function call(method,path,body){
  const raw=body?JSON.stringify(body):'', ts=String(Date.now()), nonce=crypto.randomUUID(), idem=method==='GET'?'':crypto.randomUUID();
  const sig=await hmac($('sec').value,[ts,nonce,method,path,await sha(raw),idem].join('\\n'));
  const h={'x-mnp-key':$('kid').value,'x-mnp-timestamp':ts,'x-mnp-nonce':nonce,'x-mnp-signature':sig};
  if(method!=='GET'){h['content-type']='application/json';h['idempotency-key']=idem;}
  const r=await fetch(path,{method,headers:h,body:method==='GET'?undefined:raw});
  const j=await r.json(); if(!j.ok) throw new Error(j.error.message); return j;
}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let current={};
async function load(){
  try{
    const s=(await call('GET','/v1/admin/settings')).settings; current=s;
    $('settings').innerHTML=Object.entries(s).map(([k,v])=>'<tr><td>'+esc(k)+'</td><td><input data-k="'+esc(k)+'" value="'+esc(JSON.stringify(v))+'" size="40"></td></tr>').join('');
    const r=(await call('GET','/v1/admin/rules')).rules;
    $('rules').innerHTML='<tr><th>event</th><th>bucket</th><th>amount</th><th>mode</th><th>caps</th><th>on</th></tr>'+r.map(x=>'<tr><td>'+esc(x.event_type)+'</td><td>'+esc(x.bucket)+'</td><td>'+esc(x.amount)+' '+esc(x.amount_type)+'</td><td>'+esc(x.mode)+'</td><td>'+esc(x.max_count??'-')+' / '+esc(x.lifetime_cap??'-')+'</td><td>'+(x.enabled?'yes':'no')+'</td></tr>').join('');
    const a=(await call('GET','/v1/admin/audit?limit=20')).entries;
    $('audit').textContent=a.map(e=>new Date(e.ts).toISOString()+'  '+e.action+'  '+e.detail).join('\\n');
    $('msg').textContent='Loaded.';
  }catch(e){$('msg').textContent='Could not load: '+e.message}
}
$('load').onclick=load;
$('save').onclick=async()=>{
  const patch={};
  document.querySelectorAll('input[data-k]').forEach(i=>{try{const v=JSON.parse(i.value);if(JSON.stringify(v)!==JSON.stringify(current[i.dataset.k]))patch[i.dataset.k]=v}catch{patch[i.dataset.k]=i.value}});
  if(!Object.keys(patch).length){$('msg').textContent='Nothing changed.';return}
  try{await call('PUT','/v1/admin/settings',patch);$('msg').textContent='Saved.';load()}catch(e){$('msg').textContent='Not saved: '+e.message}
};
</script></body></html>`;
}
