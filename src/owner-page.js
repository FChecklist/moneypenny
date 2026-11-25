// Owner console screen for the payee registry (chunk F9). A thin client of the signed /v1/owner routes (F6, F8 health).
// DARK: the server serves it only when the payee flag is on. The page holds no data and no secret. The owner secret is typed
// into the page, used in the browser to sign calls (Web Crypto) and never sent or stored. The page shows secret NAMES only,
// and refuses a secret-looking value before any call. Payee names on screen come from the payee record.
export function ownerPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payee accounts</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:960px;margin-inline:auto;background:#fafaf7;color:#1c1c1c}
h1{font-size:20px} h2{font-size:17px} input,select,button,textarea{font:inherit;padding:6px 8px} input,select,textarea{border:1px solid #bbb;border-radius:6px}
table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0} #msg{color:#0b6b57;min-height:1.4em} #msg.bad{color:#a11} pre{white-space:pre-wrap;font-size:12px}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee} input,select,textarea{background:#222;color:#eee;border-color:#555}}
</style></head><body>
<h1>Payee accounts</h1>
<p>This screen shows who receives the money. Only names of secrets are used here. Never paste a secret value.</p>
<div class="row"><input id="sec" type="password" placeholder="Owner secret (used here, never sent)" size="36"><button id="load">Load</button></div>
<div id="msg"></div>
<h2>Payees</h2><table id="list"></table>
<h2>Selected payee</h2><div id="detail">Pick a payee from the list.</div>
<h2>Add a payee (starts as a draft)</h2>
<div class="row"><input id="n_legal" placeholder="Legal name" size="28"><input id="n_gw" placeholder="Gateway (razorpay)" size="18"><select id="n_mode"><option>test</option><option>live</option></select><input id="n_cur" placeholder="Currencies (INR,USD)" size="20"></div>
<div class="row"><input id="n_kid" placeholder="Secret NAME for key id" size="28"><input id="n_ksec" placeholder="Secret NAME for key secret" size="28"><input id="n_wh" placeholder="Secret NAME for webhook secret" size="30"></div>
<div class="row"><button id="create">Add payee</button></div>
<h2>Set the payee for a product</h2>
<div class="row"><input id="r_tenant" placeholder="Tenant id" size="16"><input id="r_prod" placeholder="Product (or *)" size="16"><input id="r_pay" placeholder="Payee id" size="22"><input id="r_fb" placeholder="Fallback payee id (optional)" size="26"></div>
<div class="row"><input id="r_from" placeholder="Starts at (time in ms)" size="22"><input id="r_reason" placeholder="Reason" size="36"><select id="r_test"><option value="no">Live and test orders</option><option value="yes">Test orders only</option></select><button id="route">Set route</button></div>
<h2>Recent changes</h2><pre id="audit"></pre>
<script>
const $=id=>document.getElementById(id), enc=new TextEncoder();
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
async function hmac(k,m){const key=await crypto.subtle.importKey('raw',enc.encode(k),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',key,enc.encode(m)))}
async function call(method,path,body){
  const raw=body===undefined?'':JSON.stringify(body), ts=String(Date.now()), nonce=crypto.randomUUID();
  const sig=await hmac($('sec').value,['mnp-owner',ts,nonce,method,path,raw].join('\\n'));
  const h={'x-owner-ts':ts,'x-owner-nonce':nonce,'x-owner-sig':sig}; if(method!=='GET')h['content-type']='application/json';
  const r=await fetch(path,{method,headers:h,body:method==='GET'?undefined:raw});
  const j=await r.json(); if(!j.ok) throw new Error((j.error&&j.error.message)||'Not allowed.'); return j;
}
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const say=(t,bad)=>{$('msg').textContent=t;$('msg').className=bad?'bad':''};
// A value that looks like a secret is refused here, before any call. The server refuses it too.
const SECRETISH=/^(rzp_|sk_|whsec_)|[A-Za-z0-9+\\/_-]{32,}/;
const nameOk=v=>/^[A-Z][A-Z0-9_]{2,63}$/.test(v);
const when=t=>t?new Date(t).toISOString():'never';
let sel=null;
async function load(){
  try{
    const ps=(await call('GET','/v1/owner/payees')).payees;
    $('list').innerHTML='<tr><th>Name</th><th>Gateway</th><th>Mode</th><th>Status</th><th></th></tr>'+ps.map(p=>'<tr><td>'+esc(p.display_name)+'</td><td>'+esc(p.gateway)+'</td><td>'+esc(p.mode)+'</td><td>'+esc(p.status)+'</td><td><button data-open="'+esc(p.payee_id)+'">Open</button></td></tr>').join('');
    document.querySelectorAll('button[data-open]').forEach(b=>b.onclick=()=>open_(b.dataset.open));
    const a=(await call('GET','/v1/owner/payee_audit?limit=20')).entries||[];
    $('audit').textContent=a.map(e=>new Date(e.ts).toISOString()+'  '+e.action+'  '+JSON.stringify(e.detail)).join('\\n');
    say('Loaded.'); if(sel) open_(sel);
  }catch(e){say('Could not load: '+e.message,true)}
}
async function open_(id){
  try{
    sel=id; const p=(await call('GET','/v1/owner/payees/'+id)).payee, h=(await call('GET','/v1/owner/payees/'+id+'/health')).health;
    const sn=Object.entries(h.secrets).map(([k,v])=>esc(k)+': '+esc(v.name)+' ('+(v.present?'present':'missing')+')').join('<br>');
    $('detail').innerHTML='<table><tr><td>Name</td><td>'+esc(p.display_name)+'</td></tr><tr><td>Legal name</td><td>'+esc(p.legal_name)+'</td></tr><tr><td>Id</td><td>'+esc(p.payee_id)+'</td></tr><tr><td>Gateway and mode</td><td>'+esc(p.gateway)+', '+esc(p.mode)+'</td></tr><tr><td>Status</td><td>'+esc(p.status)+'</td></tr><tr><td>Currencies</td><td>'+esc(p.currencies.join(', '))+'</td></tr><tr><td>Secret names</td><td>'+sn+'</td></tr><tr><td>Last gateway event</td><td>'+esc(when(h.last_webhook_at))+'</td></tr><tr><td>Ignored events</td><td>'+esc(h.ignored_events)+'</td></tr><tr><td>Orders waiting for the gateway</td><td>'+esc(h.pending_rail_orders)+'</td></tr></table>'+
      '<div class="row"><button data-step="activate">Activate</button><button data-step="pause">Pause</button><button data-step="retire">Retire</button></div>'+
      '<div class="row"><input id="e_name" placeholder="New display name" size="26"><input id="e_note" placeholder="Note" size="30"><button id="edit">Save change</button></div>';
    document.querySelectorAll('button[data-step]').forEach(b=>b.onclick=()=>step(id,b.dataset.step));
    $('edit').onclick=()=>edit(id);
  }catch(e){say('Could not open: '+e.message,true)}
}
async function step(id,s){
  if(s==='retire'&&!confirm('Retire this payee? It cannot be used again.'))return;
  try{await call('POST','/v1/owner/payees/'+id+'/'+s,{});say('Done.');load()}catch(e){say('Not done: '+e.message,true)}
}
async function edit(id){
  const b={}; if($('e_name').value)b.display_name=$('e_name').value; if($('e_note').value)b.note=$('e_note').value;
  if(!Object.keys(b).length){say('Nothing changed.');return}
  if(Object.values(b).some(v=>SECRETISH.test(v))){say('That looks like a secret value. Never paste a secret value.',true);return}
  try{await call('PUT','/v1/owner/payees/'+id,b);say('Saved.');load()}catch(e){say('Not saved: '+e.message,true)}
}
$('create').onclick=async()=>{
  const names={key_id:$('n_kid').value.trim(),key_secret:$('n_ksec').value.trim(),webhook_secret:$('n_wh').value.trim()};
  if(!Object.values(names).every(nameOk)){say(Object.values(names).some(v=>SECRETISH.test(v))?'That looks like a secret value. Give the NAME of the secret.':'Each secret name needs capital letters, digits and underscores.',true);return}
  const cur=$('n_cur').value.split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);
  try{await call('POST','/v1/owner/payees',{legal_name:$('n_legal').value.trim(),gateway:$('n_gw').value.trim(),mode:$('n_mode').value,secret_names:names,currencies:cur});say('Added as a draft.');load()}catch(e){say('Not added: '+e.message,true)}
};
$('route').onclick=async()=>{
  const b={tenant_id:$('r_tenant').value.trim(),product_id:$('r_prod').value.trim(),payee_id:$('r_pay').value.trim(),effective_from:Number($('r_from').value),reason:$('r_reason').value,test_only:$('r_test').value==='yes'};
  if($('r_fb').value.trim())b.fallback_payee_id=$('r_fb').value.trim();
  try{await call('POST','/v1/owner/routes',b);say('Route set.');load()}catch(e){say('Not set: '+e.message,true)}
};
$('load').onclick=load;
</script></body></html>`;
}
