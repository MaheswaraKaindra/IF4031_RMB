// Self-contained analytics dashboard (no CDN, no build step). Data comes from
// /internal/analytics/summary; the cross-check button recounts via the Audit API and compares.
export function analyticsPageHtml(): string {
    return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BNPB Analitik Bencana</title>
<style>
 body{font:14px system-ui,sans-serif;margin:16px;max-width:1100px;color:#111}
 h1{font-size:20px} .row{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:8px 0}
 .banner{padding:10px 12px;border-radius:6px;margin:10px 0;display:none}
 .partial{background:#fff3cd;border:1px solid #e0a800}.ok{background:#e6f4ea;border:1px solid #34a853}
 table{border-collapse:collapse;min-width:260px;margin:6px 24px 6px 0}td,th{border:1px solid #ccc;padding:3px 8px;text-align:left}
 canvas{border:1px solid #ccc;width:100%;max-width:1000px;height:300px}.legend span{margin-right:12px}
 .grid{display:flex;flex-wrap:wrap}
</style></head><body>
<h1>Analitik HazardEvent lintas lokasi penyimpanan</h1>
<div class="row">
 <label>Token audit <input id="tok" type="password" size="28"></label>
 <label>Rentang <select id="range"><option value="3600000">1 jam</option><option value="86400000" selected>24 jam</option>
  <option value="604800000">7 hari</option><option value="2592000000">30 hari</option><option value="0">Semua</option></select></label>
 <label>Interval <select id="bucket"><option>hour</option><option selected>day</option><option>week</option></select></label>
 <button id="go">Muat</button><button id="chk">Cocokkan dengan Audit API</button>
</div>
<div id="banner" class="banner"></div><div id="msg"></div>
<h3>Kejadian per jenis bahaya terhadap waktu</h3><canvas id="c" width="1000" height="300"></canvas><div id="legend" class="legend"></div>
<div class="grid"><div><h3>Per severity</h3><table id="sev"></table></div>
<div><h3>Per jenis bahaya</h3><table id="typ"></table></div>
<div><h3>Per wilayah (area_name)</h3><table id="area"></table></div></div>
<script>
const $=id=>document.getElementById(id);const COL={SEISMIC:'#d62728',VOLCANIC:'#ff7f0e',WILDFIRE:'#2ca02c',COASTAL:'#1f77b4',TSUNAMI:'#9467bd'};
try{$('tok').value=sessionStorage.getItem('tok')||''}catch(e){}
async function api(p){const r=await fetch(p,{headers:{authorization:'Bearer '+$('tok').value}});
 if(!r.ok)throw new Error(p+' -> '+r.status);return r.json()}
function banner(partial,un){const b=$('banner');b.style.display='block';
 b.className='banner '+(partial?'partial':'ok');
 b.textContent=partial?'DATA BELUM LENGKAP: unit tidak terjangkau ('+un.join(', ')+'). Angka di bawah adalah batas bawah.':'Data lengkap dari seluruh unit penyimpanan.'}
function table(el,obj){el.innerHTML='<tr><th>Nilai</th><th>Jumlah</th></tr>'+Object.entries(obj).sort((a,b)=>b[1]-a[1])
 .map(([k,v])=>'<tr><td>'+k.replace(/</g,'&lt;')+'</td><td>'+v+'</td></tr>').join('')}
function draw(series){const c=$('c'),g=c.getContext('2d');g.clearRect(0,0,c.width,c.height);
 const pts=[];for(const t in series)for(const b in series[t])pts.push([t,Date.parse(b),series[t][b]]);
 if(!pts.length){g.fillText('Tidak ada data',20,20);$('legend').innerHTML='';return}
 const xs=pts.map(p=>p[1]),x0=Math.min(...xs),x1=Math.max(...xs)||x0+1,ym=Math.max(...pts.map(p=>p[2]));
 const X=t=>40+(c.width-60)*((t-x0)/((x1-x0)||1)),Y=v=>c.height-30-(c.height-50)*(v/ym);
 g.strokeStyle='#999';g.beginPath();g.moveTo(40,10);g.lineTo(40,c.height-30);g.lineTo(c.width-10,c.height-30);g.stroke();
 g.fillStyle='#333';g.fillText(String(ym),4,16);g.fillText(new Date(x0).toISOString().slice(0,16),40,c.height-12);
 g.fillText(new Date(x1).toISOString().slice(0,16),c.width-120,c.height-12);
 for(const t in series){g.strokeStyle=COL[t]||'#555';g.beginPath();
  Object.entries(series[t]).map(([b,v])=>[Date.parse(b),v]).sort((a,b)=>a[0]-b[0]).forEach(([x,v],i)=>{i?g.lineTo(X(x),Y(v)):g.moveTo(X(x),Y(v))});g.stroke()}
 $('legend').innerHTML=Object.keys(series).map(t=>'<span style="color:'+(COL[t]||'#555')+'">&#9632; '+t+'</span>').join('')}
async function load(){try{sessionStorage.setItem('tok',$('tok').value)}catch(e){}
 $('msg').textContent='Memuat...';const r=+$('range').value;
 const q=new URLSearchParams({bucket:$('bucket').value});if(r)q.set('from',new Date(Date.now()-r).toISOString());
 try{const d=await api('/internal/analytics/summary?'+q);banner(d.partial,d.unavailable_units);
  draw(d.series);table($('sev'),d.by_severity);table($('typ'),{...d.by_hazard_type,'TSUNAMI (turunan SEISMIC)':d.tsunami_flagged});table($('area'),d.by_area);
  $('msg').textContent='Total '+d.total+' kejadian (tsunami berpotensi: '+d.tsunami_flagged+'), per '+d.as_of}
 catch(e){$('msg').textContent='Gagal: '+e.message}}
async function check(){$('msg').textContent='Menghitung ulang lewat Audit API...';try{
 const r=+$('range').value,from=r?Date.now()-r:0;let cur=null,tot=0,part=false,tsu=0;const by={};
 do{const d=await api('/internal/audit/events?limit=1000'+(cur?'&cursor='+cur:''));part=part||d.partial;
  for(const e of d.items){if(from&&Date.parse(e.occurred_at)<from)continue;tot++;by[e.hazard_type]=(by[e.hazard_type]||0)+1;if(e.hazard_type==='SEISMIC'&&(e.attributes&&(e.attributes.potential_tsunami===true||e.attributes.tsunami_warning!=null)))tsu++}cur=d.next_cursor}while(cur);
 const s=await api('/internal/analytics/summary'+(r?'?from='+encodeURIComponent(new Date(from).toISOString()):''));
 const same=s.total===tot&&s.tsunami_flagged===tsu&&Object.keys(by).every(k=>s.by_hazard_type[k]===by[k]);
 $('msg').textContent='Audit API: '+tot+' vs dashboard: '+s.total+' -> '+(same?'COCOK':'BEDA (data berubah saat dihitung atau tidak lengkap)')+(part?' [Audit API partial]':'')}
 catch(e){$('msg').textContent='Gagal: '+e.message}}
$('go').onclick=load;$('chk').onclick=check;if($('tok').value)load();
</script></body></html>`;
}
