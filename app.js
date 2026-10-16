(()=>{
'use strict';
const $=s=>document.querySelector(s);
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e;};
const fmtT=s=>{if(!isFinite(s)||s<0)return'--:--';s=Math.floor(s);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
const fmtB=b=>{if(!b)return'0 B';if(b<1024)return b+' B';const u=['KB','MB','GB','TB'];let i=-1;do{b/=1024;i++}while(b>=1024&&i<3);return b.toFixed(b>=100?0:1)+' '+u[i];};
const ICON_PLAY='<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>';
const ICON_PAUSE='<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
const NOTE='<svg class="note" viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';

/* ---------- IndexedDB: meta (incl. cover + lyrics) in "tracks", audio blobs in "blobs" ---------- */
let dbp;
function db(){
  if(dbp)return dbp;
  dbp=new Promise((res,rej)=>{
    const r=indexedDB.open('spey-audio',1);
    r.onupgradeneeded=()=>{const d=r.result;d.createObjectStore('tracks',{keyPath:'id',autoIncrement:true});d.createObjectStore('blobs');};
    r.onsuccess=()=>res(r.result);
    r.onerror=()=>rej(r.error);
  });
  return dbp;
}
const reqP=r=>new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
const txDone=t=>new Promise((res,rej)=>{t.oncomplete=()=>res();t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error||new Error('aborted'));});
async function addTrack(meta,blob){
  const d=await db();
  const t=d.transaction(['tracks','blobs'],'readwrite');
  const done=txDone(t);
  const idReq=t.objectStore('tracks').add(meta);
  idReq.onsuccess=()=>{ if(blob)t.objectStore('blobs').put(blob,idReq.result); };
  await done;
  return idReq.result;
}
async function allTracks(){const d=await db();return reqP(d.transaction('tracks').objectStore('tracks').getAll());}
async function getMeta(id){const d=await db();return reqP(d.transaction('tracks').objectStore('tracks').get(id));}
async function getBlob(id){const d=await db();return reqP(d.transaction('blobs').objectStore('blobs').get(id));}
async function updateTrack(id,patch){
  const d=await db();
  const t=d.transaction('tracks','readwrite');
  const st=t.objectStore('tracks');
  const done=txDone(t);
  const g=st.get(id);
  g.onsuccess=()=>{if(g.result)st.put(Object.assign(g.result,patch));};
  await done;
}
async function removeTrack(id){
  const d=await db();
  const t=d.transaction(['tracks','blobs'],'readwrite');
  t.objectStore('tracks').delete(id);t.objectStore('blobs').delete(id);
  await txDone(t);
}

/* ---------- state ---------- */
let tracks=[],queue=[],cur=null,objUrl=null,shuffle=false,repeat='off',busy=false,busyFind=false;
let boxOpen=false,lyLines=[],lyEls=[],lyActive=-1,userScroll=0,editCover,embedFor=null,ext=null,extTimer=0;
const audio=$('#audio');
const curTrack=()=>tracks.find(x=>x.id===cur)||null;

/* ---------- terminal log + progress ---------- */
const term=$('#term');
function log(msg,kind){
  const l=el('div','ln '+(kind||''),'> '+msg);
  term.appendChild(l);
  while(term.children.length>40)term.firstChild.remove();
  term.scrollTop=term.scrollHeight;
}
function prog(p,label){
  $('#bar').style.width=Math.max(0,Math.min(100,p))+'%';
  $('#pct').textContent=Math.round(p)+'%';
  if(label)$('#plabel').textContent=label;
}

/* ---------- helpers ---------- */
const PLATFORMS=[
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/,'YOUTUBE'],[/(^|\.)spotify\.com$/,'SPOTIFY'],
  [/(^|\.)soundcloud\.com$/,'SOUNDCLOUD'],[/^music\.apple\.com$/,'APPLE MUSIC'],
  [/(^|\.)deezer\.com$/,'DEEZER'],[/(^|\.)tidal\.com$/,'TIDAL'],
  [/(^|\.)bandcamp\.com$/,'BANDCAMP'],[/^music\.amazon\./,'AMAZON MUSIC']
];
const platformOf=u=>{const h=u.hostname.toLowerCase();for(const [re,n] of PLATFORMS)if(re.test(h))return n;return null;};
const MIME={mp3:'audio/mpeg',m4a:'audio/mp4',aac:'audio/aac',ogg:'audio/ogg',oga:'audio/ogg',opus:'audio/ogg',wav:'audio/wav',flac:'audio/flac',weba:'audio/webm',webm:'audio/webm'};
const extOf=p=>((p.match(/\.([a-z0-9]{2,5})$/i)||[])[1]||'').toLowerCase();
function nameFromUrl(u){
  let n=u.pathname.split('/').filter(Boolean).pop()||u.hostname;
  try{n=decodeURIComponent(n);}catch(e){}
  return n.replace(/\.[a-z0-9]{2,5}$/i,'').replace(/[_+]+/g,' ').trim()||u.hostname;
}
function buildRelay(tpl,url){
  const enc=encodeURIComponent(url);
  return tpl.includes('{url}')?tpl.replace('{url}',enc):tpl+enc;
}
function probe(blob){
  return new Promise((res,rej)=>{
    const a=new Audio(),u=URL.createObjectURL(blob);
    const fin=(f,v)=>{clearTimeout(to);a.onloadedmetadata=a.onerror=null;a.removeAttribute('src');URL.revokeObjectURL(u);f(v);};
    const to=setTimeout(()=>fin(rej,new Error('DECODE')),8000);
    a.preload='metadata';
    a.onloadedmetadata=()=>fin(res,a.duration);
    a.onerror=()=>fin(rej,new Error('DECODE'));
    a.src=u;
  });
}
async function streamFetch(url){
  const r=await fetch(url);
  if(!r.ok)throw new Error('HTTP '+r.status);
  const ct=(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  if(ct.includes('text/html'))throw new Error('NOT_AUDIO');
  const total=+r.headers.get('content-length')||0;
  const chunks=[];let got=0;
  if(r.body&&r.body.getReader){
    const rd=r.body.getReader();
    for(;;){
      const {done,value}=await rd.read();
      if(done)break;
      chunks.push(value);got+=value.length;
      prog(total?got/total*100:Math.min(95,got/5e6*50),'DOWNLOADING '+fmtB(got)+(total?' / '+fmtB(total):''));
    }
  }else{
    const b=await r.blob();chunks.push(b);got=b.size;
  }
  return {chunks,ct,size:got};
}

/* ---------- reading tags: ID3 (mp3), MP4 (m4a), FLAC -> title, artist, cover, lyrics ---------- */
const u32=(b,p)=>((b[p]<<24)>>>0)+(b[p+1]<<16)+(b[p+2]<<8)+b[p+3];
const ss32=(b,p)=>((b[p]&127)<<21)|((b[p+1]&127)<<14)|((b[p+2]&127)<<7)|(b[p+3]&127);
const asc=(b,s,e)=>{let r='';for(let i=s;i<e;i++)r+=String.fromCharCode(b[i]);return r;};
function deunsync(b){const o=new Uint8Array(b.length);let n=0;for(let i=0;i<b.length;i++){o[n++]=b[i];if(b[i]===0xFF&&b[i+1]===0)i++;}return o.subarray(0,n);}
function dec(bytes,enc){
  try{
    if(enc===1){
      if(bytes[0]===0xFE&&bytes[1]===0xFF)return new TextDecoder('utf-16be').decode(bytes.subarray(2));
      if(bytes[0]===0xFF&&bytes[1]===0xFE)return new TextDecoder('utf-16le').decode(bytes.subarray(2));
      return new TextDecoder('utf-16le').decode(bytes);
    }
    if(enc===2)return new TextDecoder('utf-16be').decode(bytes);
    if(enc===3)return new TextDecoder('utf-8').decode(bytes);
    try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch(e){return new TextDecoder('windows-1252').decode(bytes);}
  }catch(e){return '';}
}
function termAt(b,i,enc){
  if(enc===1||enc===2){for(;i+1<b.length;i+=2)if(b[i]===0&&b[i+1]===0)return i;return -1;}
  for(;i<b.length;i++)if(b[i]===0)return i;
  return -1;
}
const termLen=enc=>(enc===1||enc===2)?2:1;
function sniffImg(d,mime){
  if(d[0]===0x89&&d[1]===0x50)return'image/png';
  if(d[0]===0xFF&&d[1]===0xD8)return'image/jpeg';
  if(d[0]===0x47&&d[1]===0x49)return'image/gif';
  if(d[0]===0x52&&d[1]===0x49)return'image/webp';
  return /^image\//.test(mime||'')?mime:'image/jpeg';
}
function parseID3(ab){
  const out={};
  let b=new Uint8Array(ab);
  if(b.length<10||asc(b,0,3)!=='ID3')return out;
  const ver=b[3],fl=b[5],tagSize=ss32(b,6);
  if((fl&0x80)&&ver<4)b=deunsync(b);
  let p=10;
  if(fl&0x40)p+=ver===3?4+u32(b,10):ss32(b,10);
  const end=Math.min(b.length,10+tagSize);
  const hl=ver===2?6:10;
  let rank0=-1;
  while(p+hl<=end&&b[p]!==0){
    const id=asc(b,p,p+(ver===2?3:4));
    let size,ff=0;
    if(ver===2)size=(b[p+3]<<16)|(b[p+4]<<8)|b[p+5];
    else{size=ver===4?ss32(b,p+4):u32(b,p+4);ff=b[p+9];}
    p+=hl;
    if(size<=0||p+size>b.length)break;
    let fr=b.subarray(p,p+size);p+=size;
    if(ver===4){
      if(ff&0x0C)continue;
      if(ff&0x40)fr=fr.subarray(1);
      if(ff&0x01)fr=fr.subarray(4);
      if(ff&0x02)fr=deunsync(fr);
    }else if(ver===3){
      if(ff&0xC0)continue;
      if(ff&0x20)fr=fr.subarray(1);
    }
    if(fr.length<2)continue;
    if(id==='TIT2'||id==='TT2'){out.title=dec(fr.subarray(1),fr[0]).split('\0')[0].trim();}
    else if(id==='TPE1'||id==='TP1'){out.artist=dec(fr.subarray(1),fr[0]).split('\0')[0].trim();}
    else if(id==='USLT'||id==='ULT'){
      const enc=fr[0],t=termAt(fr,4,enc);
      if(t>=0){
        const txt=dec(fr.subarray(t+termLen(enc)),enc).replace(/\0+$/,'').trim();
        if(txt&&!out.lyrics)out.lyrics=txt;
      }
    }else if(id==='APIC'||id==='PIC'){
      const enc=fr[0];let i,mime='';
      if(id==='APIC'){const m=termAt(fr,1,0);if(m<0)continue;mime=dec(fr.subarray(1,m),0);i=m+1;}
      else{mime='image/'+asc(fr,1,4).toLowerCase();i=4;}
      const pt=fr[i++];
      const d=termAt(fr,i,enc);if(d<0)continue;
      i=d+termLen(enc);
      const data=fr.subarray(i);
      if(data.length<64)continue;
      const rank=pt===3?2:pt===0?1:0;
      if(rank>rank0){rank0=rank;out.cover=new Blob([data],{type:sniffImg(data,mime)});}
    }
  }
  return out;
}
async function readID3(blob,h){
  const size=ss32(h,6);
  const ab=await blob.slice(0,Math.min(10+size,40e6)).arrayBuffer();
  return parseID3(ab);
}
function mp4Walk(dv,start,end,parent,out){
  let p=start;
  const fcc=o=>String.fromCharCode(dv.getUint8(o),dv.getUint8(o+1),dv.getUint8(o+2),dv.getUint8(o+3));
  while(p+8<=end){
    const size=dv.getUint32(p),type=fcc(p+4);
    if(size<8||p+size>end)break;
    const cs=p+8,ce=p+size;
    if(type==='udta'||type==='ilst')mp4Walk(dv,cs,ce,type,out);
    else if(type==='meta')mp4Walk(dv,cs+4,ce,'meta',out);
    else if(parent==='ilst'){
      let q=cs;
      while(q+16<=ce){
        const s2=dv.getUint32(q);
        if(s2<16||q+s2>ce)break;
        if(fcc(q+4)==='data'){
          const flag=dv.getUint32(q+8)&0xFFFFFF;
          const bytes=new Uint8Array(dv.buffer,dv.byteOffset+q+16,s2-16);
          if(type==='covr'){if(!out.cover)out.cover=new Blob([bytes],{type:flag===14?'image/png':'image/jpeg'});}
          else if(type==='©nam')out.title=new TextDecoder().decode(bytes).trim();
          else if(type==='©ART')out.artist=new TextDecoder().decode(bytes).trim();
          else if(type==='©lyr')out.lyrics=new TextDecoder().decode(bytes).trim();
        }
        q+=s2;
      }
    }
    p+=size;
  }
}
async function readMp4(blob){
  const out={};let off=0;const len=blob.size;
  while(off+8<=len){
    const h=new DataView(await blob.slice(off,off+16).arrayBuffer());
    let size=h.getUint32(0);const type=String.fromCharCode(h.getUint8(4),h.getUint8(5),h.getUint8(6),h.getUint8(7));
    let hdr=8;
    if(size===1){if(h.byteLength<16)break;size=h.getUint32(8)*4294967296+h.getUint32(12);hdr=16;}
    else if(size===0)size=len-off;
    if(size<hdr)break;
    if(type==='moov'){
      if(size>60e6)break;
      const buf=await blob.slice(off+hdr,off+size).arrayBuffer();
      mp4Walk(new DataView(buf),0,buf.byteLength,'moov',out);
      break;
    }
    off+=size;
  }
  return out;
}
function flacVorbis(b,out){
  const dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
  let p=4+dv.getUint32(0,true);
  if(p+4>b.length)return;
  const n=dv.getUint32(p,true);p+=4;
  const td=new TextDecoder();
  for(let i=0;i<n&&p+4<=b.length;i++){
    const l=dv.getUint32(p,true);p+=4;
    if(p+l>b.length)break;
    const s=td.decode(b.subarray(p,p+l));p+=l;
    const k=s.indexOf('=');if(k<1)continue;
    const key=s.slice(0,k).toUpperCase(),v=s.slice(k+1).trim();
    if(key==='TITLE')out.title=v;
    else if(key==='ARTIST')out.artist=v;
    else if(key==='LYRICS'||key==='UNSYNCEDLYRICS'||key==='SYNCEDLYRICS'){if(v&&(!out.lyrics||key==='SYNCEDLYRICS'))out.lyrics=v;}
  }
}
function flacPic(b,out){
  const dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
  let p=4;const ml=dv.getUint32(p);p+=4;const mime=asc(b,p,p+ml);p+=ml;
  const dl=dv.getUint32(p);p+=4+dl+16;
  const l=dv.getUint32(p);p+=4;
  if(p+l>b.length)return;
  const d=b.subarray(p,p+l);
  if(!out.cover)out.cover=new Blob([d],{type:sniffImg(d,mime)});
}
async function readFlac(blob){
  const out={};let off=4;
  for(let n=0;n<64&&off+4<=blob.size;n++){
    const h=new Uint8Array(await blob.slice(off,off+4).arrayBuffer());
    const last=h[0]&0x80,type=h[0]&0x7f,len=(h[1]<<16)|(h[2]<<8)|h[3];
    off+=4;
    if(len>30e6)break;
    if(type===4||type===6){
      const b=new Uint8Array(await blob.slice(off,off+len).arrayBuffer());
      try{if(type===4)flacVorbis(b,out);else flacPic(b,out);}catch(e){}
    }
    off+=len;
    if(last)break;
  }
  return out;
}
async function readTags(blob){
  try{
    const h=new Uint8Array(await blob.slice(0,12).arrayBuffer());
    if(asc(h,0,3)==='ID3')return await readID3(blob,h);
    if(asc(h,0,4)==='fLaC')return await readFlac(blob);
    if(asc(h,4,8)==='ftyp')return await readMp4(blob);
  }catch(e){}
  return {};
}
/* shrink a cover to <=600px JPEG so the vault stays light; null if it isn't a real image */
async function thumb(blob){
  let url;
  try{
    url=URL.createObjectURL(blob);
    const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=()=>rej(new Error('img'));i.src=url;});
    const W=img.naturalWidth,H=img.naturalHeight;
    if(!W||!H)return null;
    const k=Math.min(1,600/Math.max(W,H));
    const c=document.createElement('canvas');c.width=Math.max(1,Math.round(W*k));c.height=Math.max(1,Math.round(H*k));
    const g=c.getContext('2d');g.fillStyle='#000';g.fillRect(0,0,c.width,c.height);g.drawImage(img,0,0,c.width,c.height);
    return await new Promise(res=>c.toBlob(b=>res(b||null),'image/jpeg',.86));
  }catch(e){return null;}
  finally{if(url)URL.revokeObjectURL(url);}
}
async function metaFrom(blob,base){
  const tags=await readTags(blob);
  const cover=tags.cover?await thumb(tags.cover):null;
  const lyrics=(tags.lyrics||'').trim();
  return {
    type:'audio',
    title:base.title||tags.title||base.fallback||'untitled',
    artist:base.artist||tags.artist||'',
    url:base.url||'',size:blob.size,duration:base.duration,mime:base.mime,added:Date.now(),
    cover,coverV:cover?Date.now():0,
    lyrics,synced:!!lyrics&&isSynced(lyrics),lyricsSrc:lyrics?'file':''
  };
}

/* ---------- lyrics: timed (LRC) parsing + online lookup ---------- */
const isSynced=t=>/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(t);
function parseLrc(text){
  const lines=[];
  for(const raw of text.split(/\r?\n/)){
    const re=/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    const stamps=[];let m,last=0;
    while((m=re.exec(raw))){stamps.push(+m[1]*60+ +m[2]+(m[3]?+('0.'+m[3]):0));last=re.lastIndex;}
    if(!stamps.length)continue;
    const x=raw.slice(last).trim();
    stamps.forEach(s=>lines.push({t:s,x}));
  }
  lines.sort((a,b)=>a.t-b.t);
  return lines;
}
const norm=s=>(s||'').normalize('NFKD').toLowerCase().replace(/[\(\[].*?[\)\]]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function guess(t){
  let ti=(t.title||'').replace(/^\s*\d{1,3}[\s._-]+(?=\D)/,'').trim(),ar=(t.artist||'').trim();
  if(!ar||t.type==='link'){const m=ti.match(/^(.+?)\s+[-–—]\s+(.+)$/);if(m){ar=m[1].trim();ti=m[2].trim();}}
  ti=ti.replace(/\s*[\(\[](official|lyrics?|audio|video|hd|hq|mv|remaster).*?[\)\]]/ig,'').trim();
  return {ti,ar};
}
async function jfetch(url,ms){
  const c=new AbortController(),to=setTimeout(()=>c.abort(),ms);
  try{return await fetch(url,{signal:c.signal});}finally{clearTimeout(to);}
}
async function fetchLyrics(t){
  const {ti,ar}=guess(t);
  if(!ti)return null;
  const run=async p=>{
    const r=await jfetch('https://lrclib.net/api/search?'+new URLSearchParams(p),10000);
    if(!r.ok)throw new Error('HTTP '+r.status);
    const j=await r.json();return Array.isArray(j)?j:[];
  };
  let arr=await run(ar?{track_name:ti,artist_name:ar}:{track_name:ti});
  if(!arr.length&&ar)arr=await run({q:ar+' '+ti});
  const nt=norm(ti),na=norm(ar),dur=t.duration;
  let best=null,bs=-1e9;
  for(const c of arr){
    if(c.instrumental)continue;
    const text=c.syncedLyrics||c.plainLyrics;if(!text)continue;
    const a=norm(c.trackName),b=norm(c.artistName);
    if(!(a&&nt&&(a.includes(nt)||nt.includes(a))))continue;
    if(na&&!(b.includes(na)||na.includes(b)))continue;
    const dd=(Number.isFinite(dur)&&c.duration)?Math.abs(c.duration-dur):0;
    if(dd>8)continue;
    const s=(c.syncedLyrics?100:0)-dd;
    if(s>bs){bs=s;best=c;}
  }
  if(!best)return null;
  return {lyrics:(best.syncedLyrics||best.plainLyrics).trim(),synced:!!best.syncedLyrics};
}
async function fetchCover(t){
  const {ti,ar}=guess(t);
  if(!ti)return null;
  const r=await jfetch('https://itunes.apple.com/search?'+new URLSearchParams({term:(ar+' '+ti).trim(),entity:'song',limit:'8'}),10000);
  if(!r.ok)throw new Error('HTTP '+r.status);
  const j=await r.json();
  const nt=norm(ti),na=norm(ar);
  const hit=(j.results||[]).find(x=>{
    const a=norm(x.trackName),b=norm(x.artistName);
    return a&&nt&&(a.includes(nt)||nt.includes(a))&&(!na||b.includes(na)||na.includes(b));
  });
  if(!hit||!hit.artworkUrl100)return null;
  const img=await jfetch(hit.artworkUrl100.replace(/\d+x\d+bb\./,'600x600bb.'),12000);
  if(!img.ok)return null;
  return await img.blob();
}
const autoOn=()=>{try{return localStorage.getItem('spey-auto')!=='0';}catch(e){return true;}};
async function enrich(id,manual){
  const t=await getMeta(id);
  const res={found:[],netFail:false};
  if(!t||(t.type!=='audio'&&!embedOf(t)))return res;
  const patch={};
  if(!t.lyrics||manual){
    try{
      const r=await fetchLyrics(t);
      if(r){
        const keepMine=manual&&t.lyrics&&t.lyricsSrc==='manual'&&!confirm('Replace your own lyrics with the online version?');
        if(!keepMine){patch.lyrics=r.lyrics;patch.synced=r.synced;patch.lyricsSrc='online';res.found.push(r.synced?'timed lyrics':'lyrics');}
      }
    }catch(e){res.netFail=true;}
  }
  if(!t.cover){
    try{
      const c=await fetchCover(t);
      if(c){const th=await thumb(c);if(th){patch.cover=th;patch.coverV=Date.now();res.found.push('cover');}}
    }catch(e){res.netFail=true;}
  }
  if(Object.keys(patch).length){
    await updateTrack(id,patch);
    tracks=await allTracks();render();
    if(cur===id){const ct=curTrack();setNow(ct);if(ct)mediaSession(ct);if(boxOpen)fillBox();}
  }
  return res;
}
async function autoEnrich(id){
  if(!autoOn()||!navigator.onLine)return;
  try{
    const r=await enrich(id,false);
    if(r.found.length)log('online: found '+r.found.join(' + '),'inf');
  }catch(e){}
}

/* ---------- cover art rendering (real cover or generated neon art) ---------- */
const coverUrls=new Map();
function coverUrl(t){
  if(!t||!t.cover)return null;
  let u=coverUrls.get(t.id);
  if(!u||u.v!==t.coverV){
    if(u)URL.revokeObjectURL(u.url);
    u={v:t.coverV,url:URL.createObjectURL(t.cover)};
    coverUrls.set(t.id,u);
  }
  return u.url;
}
function dropCover(id){const u=coverUrls.get(id);if(u){URL.revokeObjectURL(u.url);coverUrls.delete(id);}}
const PAL=[['#00f0ff','#ff2bd6'],['#ff2bd6','#fcee0a'],['#00f0ff','#39ff88'],['#fcee0a','#ff003c'],['#7a5cff','#00f0ff']];
function hash(s){let h=0;for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))|0;return Math.abs(h);}
function paintArt(node,t){
  const u=coverUrl(t);
  if(u){node.classList.add('has');node.style.background='#000 url("'+u+'") center/cover no-repeat';return;}
  node.classList.remove('has');
  if(!t){node.style.background='#0b0d16';return;}
  const p=PAL[hash((t.title||'')+(t.artist||''))%PAL.length];
  const g='linear-gradient(135deg,'+p[0]+','+p[1]+')';
  if(t.coverRemote){node.classList.add('has');node.style.background='url("'+t.coverRemote+'") center/cover no-repeat, '+g;return;}
  node.style.background=g;
}
function makeArt(cls,t){const d=el('div','art '+cls);d.innerHTML=NOTE;paintArt(d,t);return d;}

/* ---------- YouTube / Spotify: official players, driven by the app's own player bar ---------- */
function parseEmbed(u){
  const h=u.hostname.toLowerCase().replace(/^www\./,'');
  if(h==='youtu.be'){
    const id=u.pathname.slice(1).split('/')[0];
    if(/^[\w-]{11}$/.test(id))return {kind:'youtube',id};
  }
  if(/(^|\.)youtube\.com$/.test(h)){
    let id=u.searchParams.get('v')||'';
    const m=u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
    if(!id&&m)id=m[1];
    if(/^[\w-]{11}$/.test(id))return {kind:'youtube',id};
    const list=u.searchParams.get('list');
    if(list&&/^[\w-]+$/.test(list))return {kind:'youtube',list};
  }
  if(h==='open.spotify.com'){
    const m=u.pathname.match(/^\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/);
    if(m)return {kind:'spotify',type:m[1],id:m[2]};
  }
  return null;
}
const embedOf=t=>{
  if(!t||t.type!=='link')return null;
  if(t.embed)return t.embed;
  try{return parseEmbed(new URL(t.url));}catch(e){return null;}
};
const isEmbed=t=>!!embedOf(t);
function embedSrc(e){
  if(e.kind==='youtube'){
    const q='autoplay=1&rel=0&playsinline=1';
    const base='https://www.youtube-nocookie.com/embed/';
    return e.id?base+e.id+'?'+q:base+'videoseries?list='+e.list+'&'+q;
  }
  return 'https://open.spotify.com/embed/'+e.type+'/'+e.id+'?utm_source=generator&theme=0';
}
async function fetchEmbedMeta(emb){
  const canon=emb.kind==='youtube'
    ?(emb.id?'https://www.youtube.com/watch?v='+emb.id:'https://www.youtube.com/playlist?list='+emb.list)
    :'https://open.spotify.com/'+emb.type+'/'+emb.id;
  const ep=emb.kind==='youtube'?'https://www.youtube.com/oembed?format=json&url=':'https://open.spotify.com/oembed?url=';
  try{
    const r=await jfetch(ep+encodeURIComponent(canon),8000);
    if(!r.ok)return null;
    const j=await r.json();
    return {title:String(j.title||'').trim(),artist:String(j.author_name||'').trim(),thumb:String(j.thumbnail_url||'')};
  }catch(e){return null;}
}

/* one clock for the whole app: the player's, or the local audio element's */
function curTime(){return ext?ext.time():audio.currentTime;}
function seekTo(s){if(ext)ext.seek(s);else audio.currentTime=s;}
function uiPlaying(p){
  $('#bPlay').innerHTML=p?ICON_PAUSE:ICON_PLAY;
  document.body.classList.toggle('playing',p);
}
function extTick(){
  if(!ext)return;
  const ct=ext.time(),d=ext.dur();
  $('#tCur').textContent=fmtT(ct);
  if(d>0){
    $('#tDur').textContent=fmtT(d);
    if(!dragging){const p=Math.min(1000,ct/d*1000);seek.value=p;seek.style.setProperty('--p',(p/10)+'%');}
  }
  hiLine(false);
}
function onExtEnded(){
  if(repeat==='one'&&ext){ext.seek(0);ext.play();return;}
  step(1,true);
}
let ytP=null,spP=null;
function ytReady(){
  if(window.YT&&window.YT.Player)return Promise.resolve(window.YT);
  if(ytP)return ytP;
  ytP=new Promise((res,rej)=>{
    const prev=window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady=()=>{try{if(prev)prev();}catch(e){}res(window.YT);};
    const s=document.createElement('script');s.src='https://www.youtube.com/iframe_api';
    s.onerror=()=>rej(new Error('yt api'));document.head.append(s);
    setTimeout(()=>rej(new Error('yt api timeout')),10000);
  }).catch(e=>{ytP=null;throw e;});
  return ytP;
}
function spReady(){
  if(spP)return spP;
  spP=new Promise((res,rej)=>{
    window.onSpotifyIframeApiReady=api=>res(api);
    const s=document.createElement('script');s.src='https://open.spotify.com/embed/iframe-api/v1';s.async=true;
    s.onerror=()=>rej(new Error('spotify api'));document.head.append(s);
    setTimeout(()=>rej(new Error('spotify api timeout')),10000);
  }).catch(e=>{spP=null;throw e;});
  return spP;
}
function stopExt(){
  clearInterval(extTimer);extTimer=0;
  if(ext){try{ext.destroy();}catch(e){}ext=null;}
}
function unmountEmbed(){stopExt();const h=$('#embedHost');if(h)h.textContent='';embedFor=null;}
/* plain iframe: used only if the player API can't be loaded (then the player's own buttons are used) */
function fallbackIframe(slot,em,title,myId){
  if(embedFor!==myId)return;
  const f=document.createElement('iframe');
  f.src=embedSrc(em);
  f.allow='autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
  f.referrerPolicy='strict-origin-when-cross-origin';
  f.title=title||'player';
  if(em.kind==='youtube')f.allowFullscreen=true;
  else f.style.height=(em.type==='track'||em.type==='episode')?'152px':'352px';
  slot.replaceWith(f);
}
function mountEmbed(t,em){
  const host=$('#embedHost'),myId=t.id;
  $('#embedOpen').href=t.url||'#';
  $('#embedNote').textContent=em.kind==='spotify'
    ?'Plays from Spotify and needs internet. Spotify may only play a 30-second preview unless you are logged in to Spotify in this browser.'
    :'Plays from YouTube and needs internet.';
  if(embedFor===myId&&host.firstChild)return;
  unmountEmbed();
  embedFor=myId;
  host.className=em.kind==='youtube'?'yt':'sp';
  const slot=document.createElement('div');host.append(slot);
  if(em.kind==='youtube'){
    ytReady().then(YT=>{
      if(embedFor!==myId)return;
      const vars={autoplay:1,rel:0,playsinline:1};
      if(/^https?:/.test(location.origin))vars.origin=location.origin;
      const opt={host:'https://www.youtube-nocookie.com',width:'100%',height:'100%',playerVars:vars,events:{}};
      if(em.id)opt.videoId=em.id;else{vars.listType='playlist';vars.list=em.list;}
      const x={kind:'youtube',paused:true};
      opt.events.onReady=()=>{try{p.setVolume(Math.round(audio.volume*100));}catch(e){}};
      opt.events.onStateChange=e=>{
        const s=e.data;
        if(s===1){x.paused=false;uiPlaying(true);}
        else if(s===2){x.paused=true;uiPlaying(false);}
        else if(s===0){x.paused=true;uiPlaying(false);onExtEnded();}
      };
      opt.events.onError=e=>{lstat('YouTube would not play this video here (code '+e.data+'). Try "Open the original".');};
      const p=new YT.Player(slot,opt);
      x.play=()=>{try{p.playVideo();}catch(e){}};
      x.pause=()=>{try{p.pauseVideo();}catch(e){}};
      x.seek=s=>{try{p.seekTo(s,true);}catch(e){}};
      x.setVol=v=>{try{p.setVolume(Math.round(v*100));}catch(e){}};
      x.time=()=>{try{return p.getCurrentTime()||0;}catch(e){return 0;}};
      x.dur=()=>{try{return p.getDuration()||0;}catch(e){return 0;}};
      x.destroy=()=>{try{p.destroy();}catch(e){}};
      ext=x;extTimer=setInterval(extTick,250);
      if(boxOpen&&cur===myId)renderLyrics(curTrack());
    }).catch(()=>fallbackIframe(slot,em,t.title,myId));
  }else{
    spReady().then(api=>{
      if(embedFor!==myId)return;
      const h=(em.type==='track'||em.type==='episode')?152:352;
      api.createController(slot,{width:'100%',height:h,uri:'spotify:'+em.type+':'+em.id},ctrl=>{
        if(embedFor!==myId){try{ctrl.destroy();}catch(e){}return;}
        const x={kind:'spotify',paused:true,pos:0,d:0,t0:Date.now(),endedFlag:false};
        x.play=()=>{if(x.paused){try{ctrl.togglePlay();}catch(e){}}};
        x.pause=()=>{if(!x.paused){try{ctrl.togglePlay();}catch(e){}}};
        x.seek=s=>{try{ctrl.seek(s);}catch(e){}x.pos=s;x.t0=Date.now();};
        x.setVol=()=>{};
        x.time=()=>{const run=x.paused?0:(Date.now()-x.t0)/1000;return Math.min(x.d||1e9,x.pos+run);};
        x.dur=()=>x.d;
        x.destroy=()=>{try{ctrl.destroy();}catch(e){}};
        ctrl.addListener('ready',()=>{try{ctrl.play();}catch(e){}});
        ctrl.addListener('playback_update',ev=>{
          const d=ev&&ev.data;if(!d)return;
          x.pos=(d.position||0)/1000;x.d=(d.duration||0)/1000;x.t0=Date.now();
          const was=x.paused;x.paused=!!d.isPaused;
          if(was!==x.paused)uiPlaying(!x.paused);
          const single=em.type==='track'||em.type==='episode';
          if(single&&x.d>0&&x.pos>=x.d-.6&&x.paused&&!x.endedFlag){x.endedFlag=true;onExtEnded();}
          else if(x.pos<x.d-2)x.endedFlag=false;
        });
        ext=x;extTimer=setInterval(extTick,250);
        if(boxOpen&&cur===myId)renderLyrics(curTrack());
      });
    }).catch(()=>fallbackIframe(slot,em,t.title,myId));
  }
}
function playEmbed(t){
  audio.pause();
  const em=embedOf(t);
  cur=t.id;
  seek.value=0;seek.style.setProperty('--p','0%');$('#tCur').textContent='0:00';
  setNow(t);markCurrent();
  mountEmbed(t,em);
  if(boxOpen)fillBox();
}

/* ---------- saving ---------- */
async function saveFromUrl(raw,title,artist){
  let u;
  try{u=new URL(raw.trim());}catch(e){log('that is not a valid URL','err');return false;}
  if(!/^https?:$/.test(u.protocol)){log('only http(s) links are supported','err');return false;}

  const plat=platformOf(u);
  if(plat){
    const emb=parseEmbed(u);
    let info=null,cover=null,remote='';
    if(emb){
      prog(10,'READING LINK');
      info=await fetchEmbedMeta(emb);
      const th=(emb.kind==='youtube'&&emb.id)?'https://i.ytimg.com/vi/'+emb.id+'/mqdefault.jpg':((info&&info.thumb)||'');
      if(th&&/^https:\/\/[^"')\s]+$/.test(th)){
        remote=th;
        try{const r=await jfetch(th,8000);if(r.ok){const b=await thumb(await r.blob());if(b)cover=b;}}catch(e){}
      }
    }
    const fb=emb?(emb.kind==='youtube'?'YouTube video':'Spotify '+emb.type):plat+' // '+nameFromUrl(u);
    const id=await addTrack({type:'link',title:title||(info&&info.title)||fb,artist:artist||(info&&info.artist)||'',url:u.href,size:0,duration:null,added:Date.now(),
      cover,coverV:cover?Date.now():0,coverRemote:cover?'':remote,lyrics:'',synced:false,lyricsSrc:'',embed:emb||null},null);
    if(emb)log(plat+' added like a normal song and tagged ONLINE: it plays from '+plat+' and needs internet (the audio itself can\'t be saved offline).'+((info&&info.title)?'':' (Title not found, use EDIT in the music box to rename it.)'),'warn');
    else log(plat+' does not allow direct downloads. Saved as an ONLINE-ONLY link (needs internet to open).','warn');
    return id;
  }

  log('connecting: '+u.hostname,'inf');prog(2,'CONNECTING');
  let res;
  try{
    res=await streamFetch(u.href);
  }catch(e){
    if(e.message==='NOT_AUDIO')throw e;
    if(/^HTTP/.test(e.message)&&!localStorage.getItem('spey-proxy'))throw e;
    const proxy=localStorage.getItem('spey-proxy')||'';
    if(!proxy)throw new Error('CORS');
    log('direct download blocked, trying your relay...','warn');
    res=await streamFetch(buildRelay(proxy,u.href));
  }
  prog(97,'VERIFYING');
  const ext=extOf(u.pathname);
  let type=res.ct;
  if(!type||type==='application/octet-stream'||type==='binary/octet-stream')type=MIME[ext]||'audio/mpeg';
  const blob=new Blob(res.chunks,{type});
  const dur=await probe(blob);
  prog(98,'READING TAGS');
  const meta=await metaFrom(blob,{title,artist,fallback:nameFromUrl(u),url:u.href,duration:dur,mime:type});
  const id=await addTrack(meta,blob);
  log('saved '+meta.title+' ('+fmtB(blob.size)+')'+(meta.cover?' + cover':'')+(meta.lyrics?' + lyrics':''),'ok');
  return id;
}
async function saveFile(f){
  const dur=await probe(f);
  const fallback=f.name.replace(/\.[a-z0-9]{2,5}$/i,'').replace(/[_]+/g,' ').trim()||'untitled';
  const meta=await metaFrom(f,{title:'',artist:'',fallback,url:'',duration:dur,mime:f.type||MIME[extOf(f.name)]||'audio/mpeg'});
  const id=await addTrack(meta,f);
  log('saved '+meta.title+' ('+fmtB(f.size)+')'+(meta.cover?' + cover':'')+(meta.lyrics?' + lyrics':''),'ok');
  return id;
}
function explain(e){
  const m=e&&e.message||String(e);
  if(m==='NOT_AUDIO')return'that link is a web page, not an audio file. Use a direct link to the audio file.';
  if(m==='DECODE')return'the file downloaded but this browser cannot play it (unsupported or broken audio).';
  if(m==='CORS'||e instanceof TypeError)return'download blocked: the server does not allow other sites to fetch it (CORS) or you are offline. Set a relay in SETTINGS, or download the file yourself and use LOAD FILES.';
  if(e&&(e.name==='QuotaExceededError'||/quota/i.test(m)))return'storage is full. Delete some tracks and try again.';
  if(/^HTTP/.test(m))return'server answered '+m+'.';
  return m;
}
async function afterSave(){
  tracks=await allTracks();render();updateStorage();
  if(navigator.storage&&navigator.storage.persist){
    navigator.storage.persisted().then(p=>{if(!p)navigator.storage.persist();}).catch(()=>{});
  }
}
async function guard(fn){
  if(busy){log('busy, wait for the current job','warn');return;}
  busy=true;$('#saveBtn').disabled=true;
  try{await fn();}catch(e){log(explain(e),'err');}
  finally{busy=false;$('#saveBtn').disabled=false;prog(0,'IDLE');}
}

/* ---------- render vault ---------- */
function render(){
  const q=$('#search').value.trim().toLowerCase();
  const list=$('#list');list.textContent='';
  const vis=tracks.filter(t=>!q||((t.title||'')+' '+(t.artist||'')).toLowerCase().includes(q));
  queue=vis.filter(t=>t.type==='audio'||embedOf(t)).map(t=>t.id);
  $('#count').textContent=tracks.length+(tracks.length===1?' TRACK':' TRACKS');
  $('#vaultCount').textContent=tracks.length;
  if(!vis.length){
    const e=el('div','empty');
    e.append(el('b',null,tracks.length?'NO MATCH':'VAULT EMPTY'),document.createElement('br'),
      document.createTextNode(tracks.length?'nothing matches your search':'inject a track with a direct audio URL or load files from your device'));
    list.appendChild(e);return;
  }
  vis.forEach(t=>{
    const row=el('div','row');row.tabIndex=0;row.dataset.id=t.id;row.setAttribute('role','button');
    const th=el('div','thumb');
    th.append(makeArt('sm',t));
    const eq=el('div','eq');eq.append(el('span'),el('span'),el('span'));th.append(eq);
    const info=el('div','info');
    info.append(el('div','t',t.title||'untitled'));
    const m=el('div','m');
    const meta=[t.artist||'unknown artist'];
    if(t.type==='audio'){meta.push(fmtT(t.duration));meta.push(fmtB(t.size));}else{const e0=embedOf(t);meta.push(e0?(e0.kind==='youtube'?'YouTube':'Spotify'):(t.url?new URL(t.url).hostname:'link'));}
    m.append(document.createTextNode(meta.join('  •  ')));
    if(t.lyrics){m.append(document.createTextNode('  •  '));m.append(el('i',null,'LYRICS'));}
    info.append(m);
    const tag=el('span','tag'+(t.type==='link'?' link':''),t.type==='link'?(embedOf(t)?'ONLINE':'ONLINE LINK'):'OFFLINE');
    const del=el('button','del','✕');del.title='Delete';del.setAttribute('aria-label','Delete '+(t.title||'track'));
    del.addEventListener('click',async ev=>{
      ev.stopPropagation();
      if(!confirm('Delete "'+(t.title||'track')+'" from the vault?'))return;
      if(cur===t.id){audio.pause();audio.removeAttribute('src');cur=null;unmountEmbed();setNow(null);if(boxOpen)closeBox();}
      await removeTrack(t.id);dropCover(t.id);tracks=await allTracks();render();updateStorage();log('deleted '+(t.title||'track'));
    });
    row.append(th,info,tag,del);
    const open=async()=>{
      if(t.type==='link'){
        if(embedOf(t)){if(cur!==t.id)playEmbed(t);openBox();return;}
        window.open(t.url,'_blank','noopener');log('opening link (online only): '+(t.title||t.url),'warn');return;
      }
      if(cur===t.id){openBox();if(audio.paused)audio.play().catch(()=>{});return;}
      await play(t.id);openBox();
    };
    row.addEventListener('click',open);
    row.addEventListener('keydown',ev=>{if(ev.key==='Enter'){ev.preventDefault();open();}});
    list.appendChild(row);
  });
  markCurrent();
}
function markCurrent(){document.querySelectorAll('.row').forEach(r=>r.classList.toggle('cur',+r.dataset.id===cur));}
async function updateStorage(){
  const used=tracks.reduce((a,t)=>a+(t.size||0),0);
  let txt='VAULT: '+fmtB(used),pct=0;
  try{
    if(navigator.storage&&navigator.storage.estimate){
      const {usage,quota}=await navigator.storage.estimate();
      if(quota){txt+='  /  DEVICE QUOTA: '+fmtB(quota);pct=Math.max(used/quota*100,usage/quota*100);}
    }
  }catch(e){}
  $('#store').textContent=txt;$('#meter').style.width=Math.min(100,Math.max(pct,used?1:0))+'%';
}

/* ---------- audio graph + visualizer ---------- */
let ctx=null,an=null;
function ensureCtx(){
  if(ctx){if(ctx.state==='suspended')ctx.resume();return;}
  try{
    const AC=window.AudioContext||window.webkitAudioContext;
    ctx=new AC();
    const src=ctx.createMediaElementSource(audio);
    an=ctx.createAnalyser();an.fftSize=128;an.smoothingTimeConstant=.8;
    src.connect(an);an.connect(ctx.destination);
  }catch(e){ctx=null;an=null;}
}
const cv=$('#viz'),cx=cv.getContext('2d');let grad=null,fdata=null;
function sizeCv(){
  const r=cv.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);
  cv.width=Math.max(1,r.width*dpr);cv.height=Math.max(1,r.height*dpr);
  grad=cx.createLinearGradient(0,cv.height,0,0);grad.addColorStop(0,'#00f0ff');grad.addColorStop(1,'#ff2bd6');
}
function draw(){
  requestAnimationFrame(draw);
  const w=cv.width,h=cv.height;if(!grad)return;
  cx.clearRect(0,0,w,h);cx.fillStyle=grad;
  const n=56,bw=w/n;let live=false;
  if(an&&!audio.paused){if(!fdata||fdata.length!==an.frequencyBinCount)fdata=new Uint8Array(an.frequencyBinCount);an.getByteFrequencyData(fdata);live=true;}
  const now=Date.now(),xp=!!(ext&&!ext.paused);
  for(let i=0;i<n;i++){
    const v=live?fdata[Math.floor(i*fdata.length*.78/n)]/255:(xp?.14+.3*Math.abs(Math.sin(now/230+i*.62)):.05+.03*Math.sin(now/500+i*.5));
    const bh=Math.max(2,v*h);
    cx.fillRect(i*bw+1,h-bh,Math.max(1,bw-2),bh);
  }
}

/* ---------- music box: cover + lyrics ---------- */
const SRC={file:'FROM FILE',online:'ONLINE · LRCLIB',manual:'YOUR TEXT'};
function lstat(msg){$('#lstat').textContent=msg||'';}
function renderLyrics(t){
  const box=$('#lyr');box.textContent='';
  lyLines=[];lyEls=[];lyActive=-1;
  box.classList.add('flat');box.scrollTop=0;
  if(!t||!t.lyrics){
    $('#lsrc').textContent='NONE';
    const n=el('div','nolyr');
    n.append(el('b',null,'NO LYRICS YET'),document.createElement('br'),
      document.createTextNode('Press FIND LYRICS to search online (needs internet), or EDIT to paste your own. Timed lyrics (LRC) scroll along with the song.'));
    box.append(n);return;
  }
  $('#lsrc').textContent=(t.synced?'TIMED':'PLAIN')+' · '+(SRC[t.lyricsSrc]||'SAVED');
  if(t.synced&&(!isEmbed(t)||ext)){
    lyLines=parseLrc(t.lyrics);
  }
  if(lyLines.length){
    box.classList.remove('flat');
    lyLines.forEach(l=>{
      const d=el('div','ly',l.x||'♪');
      d.addEventListener('click',()=>{if(cur!=null){seekTo(l.t);}});
      box.append(d);lyEls.push(d);
    });
  }else{
    lyLines=[];
    box.append(el('div','plain',t.lyrics.replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g,'')));
  }
}
function hiLine(force){
  if(!boxOpen||!lyLines.length)return;
  const ct=curTime()+.2;
  let i=-1;
  for(let k=0;k<lyLines.length;k++){if(lyLines[k].t<=ct)i=k;else break;}
  if(i===lyActive&&!force)return;
  if(lyActive>=0&&lyEls[lyActive])lyEls[lyActive].classList.remove('on');
  lyActive=i;
  if(i>=0){
    const e=lyEls[i];e.classList.add('on');
    if(force||Date.now()>userScroll){
      const c=$('#lyr');
      c.scrollTo({top:e.offsetTop-c.clientHeight/2+e.offsetHeight/2,behavior:force?'auto':'smooth'});
    }
  }else if(force&&lyEls[0]){
    const c=$('#lyr');c.scrollTop=Math.max(0,lyEls[0].offsetTop-c.clientHeight*.3);
  }
}
function fillBox(){
  const t=curTrack(),em=embedOf(t);
  paintArt($('#boxArt'),t);
  $('#boxTitle').textContent=t?(t.title||'untitled'):'';
  $('#boxArtist').textContent=t?(t.artist||'unknown artist'):'';
  lstat('');
  closeEdit();
  $('.side').classList.toggle('embed',!!em);
  if(em)mountEmbed(t,em);
  renderLyrics(t);
  hiLine(true);
}
function openBox(){
  if(cur==null||!curTrack())return;
  if(!boxOpen){
    boxOpen=true;
    try{history.pushState({box:1},'');}catch(e){}
    $('#box').hidden=false;
  }
  fillBox();
}
function hideBox(){boxOpen=false;$('#box').hidden=true;}
function closeBox(){
  if(!boxOpen)return;
  if(history.state&&history.state.box){history.back();return;}
  hideBox();
}
window.addEventListener('popstate',()=>{if(boxOpen)hideBox();});
function toggleBox(){if(boxOpen)closeBox();else openBox();}
$('#boxClose').addEventListener('click',closeBox);
$('#npWrap').addEventListener('click',toggleBox);
$('#npWrap').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggleBox();}});
const lyrEl=$('#lyr');
['wheel','touchmove'].forEach(ev=>lyrEl.addEventListener(ev,()=>{userScroll=Date.now()+3500;},{passive:true}));

$('#bFind').addEventListener('click',async()=>{
  const t=curTrack();if(!t||busyFind)return;
  if(!navigator.onLine){lstat('OFFLINE: connect to the internet to search');return;}
  busyFind=true;$('#bFind').disabled=true;lstat('SEARCHING...');
  try{
    const r=await enrich(t.id,true);
    lstat(r.found.length?'FOUND: '+r.found.join(' + ').toUpperCase()
      :(r.netFail?'LOOKUP FAILED (blocked or no connection)':'NO CONFIDENT MATCH. Press EDIT to fix the title/artist and try again'));
    if(r.found.length)log('online: found '+r.found.join(' + '),'inf');
  }catch(e){lstat('LOOKUP FAILED');}
  busyFind=false;$('#bFind').disabled=false;
});

/* edit form */
function closeEdit(){const em=isEmbed(curTrack());$('#editForm').hidden=true;$('#lyr').hidden=false;$('#embed').hidden=!em;editCover=undefined;}
function openEdit(){
  const t=curTrack();if(!t)return;
  $('#eTitle').value=t.title||'';$('#eArtist').value=t.artist||'';$('#eLyrics').value=t.lyrics||'';
  editCover=undefined;$('#eCoverName').textContent=t.cover?'Current cover kept':'No cover yet';
  $('#eCover').value='';
  $('#lyr').hidden=true;$('#editForm').hidden=false;lstat('');
}
$('#bEdit').addEventListener('click',openEdit);
$('#eCancel').addEventListener('click',closeEdit);
$('#eCover').addEventListener('change',async e=>{
  const f=e.target.files&&e.target.files[0];if(!f)return;
  const th=await thumb(f);
  if(!th){$('#eCoverName').textContent='That file is not a usable image';return;}
  editCover=th;$('#eCoverName').textContent='New cover: '+f.name;
});
$('#eCoverRm').addEventListener('click',()=>{editCover=null;$('#eCoverName').textContent='Cover will be removed';});
$('#editForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const t=curTrack();if(!t)return;
  const ly=$('#eLyrics').value.replace(/\r/g,'').trim();
  const patch={
    title:$('#eTitle').value.trim()||t.title,
    artist:$('#eArtist').value.trim(),
    lyrics:ly,synced:!!ly&&isSynced(ly),
    lyricsSrc:ly?(ly===t.lyrics?t.lyricsSrc:'manual'):''
  };
  if(editCover!==undefined){patch.cover=editCover;patch.coverV=editCover?Date.now():0;}
  try{
    await updateTrack(t.id,patch);
    tracks=await allTracks();render();
    const ct=curTrack();setNow(ct);if(ct)mediaSession(ct);fillBox();
    log('updated '+(ct?ct.title:'track'),'ok');
  }catch(err){lstat('SAVE FAILED: '+explain(err));}
});

/* ---------- playback ---------- */
function setNow(t){
  $('#npTitle').textContent=t?(t.title||'untitled'):'NO SIGNAL';
  $('#npSub').textContent=t?((t.artist||'unknown artist')+'  \u2022  tap for lyrics'):'select a track from the vault';
  $('#tDur').textContent=t?fmtT(t.duration):'0:00';
  paintArt($('#npArt'),t);
  if(!t){$('#seek').value=0;$('#seek').style.setProperty('--p','0%');$('#tCur').textContent='0:00';}
}
function mediaSession(t){
  if(!('mediaSession' in navigator)||typeof MediaMetadata==='undefined')return;
  try{
    const cu=coverUrl(t);
    navigator.mediaSession.metadata=new MediaMetadata({
      title:t.title||'untitled',artist:t.artist||'',album:'SPEY//AUDIO',
      artwork:cu?[{src:cu,sizes:'512x512',type:'image/jpeg'}]:[]
    });
    const set=(a,f)=>{try{navigator.mediaSession.setActionHandler(a,f);}catch(e){}};
    set('play',()=>audio.play());set('pause',()=>audio.pause());
    set('previoustrack',()=>prev());set('nexttrack',()=>step(1,false));
    set('seekto',d=>{if(d.seekTime!=null)audio.currentTime=d.seekTime;});
  }catch(e){}
}
async function play(id){
  const t=tracks.find(x=>x.id===id);if(!t)return;
  if(t.type==='link'){
    if(embedOf(t)){playEmbed(t);return;}
    window.open(t.url,'_blank','noopener');log('opening link (online only): '+(t.title||t.url),'warn');return;
  }
  const blob=await getBlob(id);
  if(!blob){log('audio data missing for this track','err');return;}
  unmountEmbed();
  if(objUrl)URL.revokeObjectURL(objUrl);
  objUrl=URL.createObjectURL(blob);
  audio.src=objUrl;cur=id;
  ensureCtx();
  setNow(t);markCurrent();mediaSession(t);
  if(boxOpen)fillBox();
  try{await audio.play();}catch(e){log('playback failed: '+e.message,'err');}
}
function toggle(){
  if(cur==null){if(queue.length)play(queue[0]);return;}
  if(isEmbed(curTrack())){
    if(ext){ext.paused?ext.play():ext.pause();}else toggleBox();
    return;
  }
  audio.paused?audio.play():audio.pause();
}
function step(dir,auto){
  if(!queue.length)return;
  const i=queue.indexOf(cur);
  if(shuffle&&queue.length>1){let j;do{j=Math.floor(Math.random()*queue.length);}while(j===i);return play(queue[j]);}
  if(i<0)return play(queue[0]);
  let j=i+dir;
  if(j>=queue.length){
    if(repeat==='all'||!auto)j=0;
    else{if(ext)ext.pause();else{audio.pause();audio.currentTime=0;}return;}
  }
  if(j<0)j=queue.length-1;
  play(queue[j]);
}
function prev(){if(curTime()>3){seekTo(0);}else step(-1,false);}

let dragging=false;
const seek=$('#seek'),vol=$('#vol');
audio.addEventListener('play',()=>{$('#bPlay').innerHTML=ICON_PAUSE;document.body.classList.add('playing');});
audio.addEventListener('pause',()=>{$('#bPlay').innerHTML=ICON_PLAY;document.body.classList.remove('playing');});
audio.addEventListener('ended',()=>{if(repeat==='one'){audio.currentTime=0;audio.play();}else step(1,true);});
audio.addEventListener('error',()=>{if(audio.getAttribute('src'))log('this track could not be decoded','err');});
audio.addEventListener('loadedmetadata',()=>{$('#tDur').textContent=fmtT(audio.duration);});
audio.addEventListener('seeked',()=>hiLine(false));
audio.addEventListener('timeupdate',()=>{
  $('#tCur').textContent=fmtT(audio.currentTime);
  if(!dragging&&isFinite(audio.duration)&&audio.duration>0){
    const p=audio.currentTime/audio.duration*1000;seek.value=p;seek.style.setProperty('--p',(p/10)+'%');
  }
  hiLine(false);
});
seek.addEventListener('pointerdown',()=>dragging=true);
seek.addEventListener('pointerup',()=>dragging=false);
seek.addEventListener('input',()=>{
  seek.style.setProperty('--p',(seek.value/10)+'%');
  const dd=ext?ext.dur():audio.duration;
  if(isFinite(dd)&&dd>0)seekTo(seek.value/1000*dd);
});
function setVol(v){audio.volume=v;if(ext)ext.setVol(v);vol.style.setProperty('--p',(v*100)+'%');try{localStorage.setItem('spey-vol',v);}catch(e){}}
vol.addEventListener('input',()=>setVol(+vol.value));
$('#bPlay').addEventListener('click',toggle);
$('#bNext').addEventListener('click',()=>step(1,false));
$('#bPrev').addEventListener('click',prev);
$('#bShuf').addEventListener('click',e=>{shuffle=!shuffle;e.currentTarget.classList.toggle('on',shuffle);});
$('#bRep').addEventListener('click',e=>{
  repeat=repeat==='off'?'all':repeat==='all'?'one':'off';
  e.currentTarget.textContent='REP:'+repeat.toUpperCase();e.currentTarget.classList.toggle('on',repeat!=='off');
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&boxOpen){closeBox();return;}
  if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
  if(e.code==='Space'){e.preventDefault();toggle();}
  else if(e.code==='ArrowRight'&&cur!=null)seekTo(curTime()+5);
  else if(e.code==='ArrowLeft'&&cur!=null)seekTo(Math.max(0,curTime()-5));
});

/* ---------- inputs ---------- */
$('#addForm').addEventListener('submit',e=>{
  e.preventDefault();
  const url=$('#url').value;if(!url.trim()){log('paste an audio URL first','warn');return;}
  let savedId=null;
  guard(async()=>{
    const id=await saveFromUrl(url,$('#title').value.trim(),$('#artist').value.trim());
    if(id){$('#url').value='';$('#title').value='';$('#artist').value='';await afterSave();savedId=id;}
  }).then(()=>{if(savedId)autoEnrich(savedId);});
});
async function handleFiles(list){
  const files=[...list].filter(f=>/^audio\//.test(f.type)||MIME[extOf(f.name)]);
  if(!files.length){log('no audio files found in that selection','warn');return;}
  const ids=[];
  await guard(async()=>{
    let n=0;
    for(const f of files){
      prog(n/files.length*100,'IMPORTING '+(n+1)+'/'+files.length);
      try{ids.push(await saveFile(f));}catch(e){log(f.name+': '+explain(e),'err');}
      n++;
    }
    await afterSave();
  });
  for(const id of ids)await autoEnrich(id);
}
$('#files').addEventListener('change',e=>{handleFiles(e.target.files);e.target.value='';});
const dz=$('#dropZone');
['dragenter','dragover'].forEach(ev=>window.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('drop');}));
['dragleave','drop'].forEach(ev=>window.addEventListener(ev,e=>{e.preventDefault();if(ev==='drop'||e.target===document.documentElement)dz.classList.remove('drop');}));
window.addEventListener('drop',e=>{if(e.dataTransfer&&e.dataTransfer.files.length)handleFiles(e.dataTransfer.files);});
$('#search').addEventListener('input',render);

$('#saveProxy').addEventListener('click',()=>{
  const v=$('#proxy').value.trim();
  try{
    if(v)localStorage.setItem('spey-proxy',v);else localStorage.removeItem('spey-proxy');
    localStorage.setItem('spey-auto',$('#autoFind').checked?'1':'0');
  }catch(e){}
  log('settings saved','ok');
});

/* ---------- net + install + sw ---------- */
function net(){
  const on=navigator.onLine,p=$('#netPill');
  p.classList.toggle('on',on);p.classList.toggle('off',!on);
  p.querySelector('b').textContent=on?'ONLINE':'OFFLINE';
}
window.addEventListener('online',net);window.addEventListener('offline',net);
let deferred=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferred=e;$('#install').hidden=false;});
$('#install').addEventListener('click',async()=>{if(!deferred)return;deferred.prompt();await deferred.userChoice;deferred=null;$('#install').hidden=true;});
window.addEventListener('appinstalled',()=>{$('#install').hidden=true;log('app installed','ok');});
if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));}

/* keep the music box exactly above the player bar */
function measure(){document.documentElement.style.setProperty('--ph',$('.player').offsetHeight+'px');}

/* ---------- boot ---------- */
(async()=>{
  $('#bPlay').innerHTML=ICON_PLAY;
  let v=.9;
  try{
    const s=parseFloat(localStorage.getItem('spey-vol'));if(!isNaN(s))v=s;
    $('#proxy').value=localStorage.getItem('spey-proxy')||'';
  }catch(e){}
  $('#autoFind').checked=autoOn();
  vol.value=v;setVol(v);
  setNow(null);
  net();sizeCv();measure();
  window.addEventListener('resize',()=>{sizeCv();measure();if(boxOpen)hiLine(true);});
  if('ResizeObserver' in window)new ResizeObserver(measure).observe($('.player'));
  draw();
  log('SPEY//AUDIO online','ok');
  try{tracks=await allTracks();}catch(e){log('storage unavailable: '+explain(e),'err');}
  render();updateStorage();
  log('vault: '+tracks.length+' track'+(tracks.length===1?'':'s')+' ready','inf');
})();
})();
