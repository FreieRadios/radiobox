import * as http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { MeterSnapshot } from '../dsp/graph';
import { FileEntry } from '../audio/file-dirs';
import { ScheduleEntry } from '../schedule';
import { Log } from '../util/log';

/** Headless metering: serves a tiny self-contained page and pushes meter
 *  snapshots over WebSocket at the configured frame rate. In playout mode the
 *  snapshot carries no channels and the page hides the metering section,
 *  showing only the file list (with auto-play schedule marks) and transport.
 *
 *  Control protocol (client -> server, JSON over WebSocket):
 *   - { type: 'micsMuted', value: boolean }  toggle "music only" mode
 *   - { type: 'channelMuted', value: { label, muted } } mute/unmute one channel
 *   - { type: 'recording', value: boolean }  start/stop the local FLAC recording
 *   - { type: 'streaming', value: boolean }  start/stop shipping to the harbor
 *   - { type: 'monitor', value: boolean }    start/stop local hardware playout
 *   - { type: 'playFile', value: { folder, name } } play a file from a folder
 *   - { type: 'stopFile' }                    stop local file playback
 *  The configured folders are served over HTTP at `/folders`, the listing of
 *  one folder (or a subdirectory inside it) at `/files?folder=N&path=REL`
 *  (subdirectory rows carry `dir:true`; file rows the parsed auto-play
 *  timestamp; plus the server clock for skew-free comparison), and every
 *  future-scheduled file across all folders at `/scheduled`. */
export interface MeterCommand {
  type: string;
  value?: unknown;
}

export class MeterServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private onCmd: ((cmd: MeterCommand) => void) | null = null;
  private onList: ((folder: number, sub: string) => FileEntry[]) | null = null;
  private onFolders: (() => string[]) | null = null;
  private onScheduled: (() => ScheduleEntry[]) | null = null;

  constructor(
    private port: number,
    private log: Log
  ) {
    this.server = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0];
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE.replace('__SERVER_TZ__', SERVER_TZ));
      } else if (url === '/folders') {
        const folders = this.onFolders ? this.onFolders() : [];
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ folders }));
      } else if (url === '/files') {
        const q = new URL(req.url ?? '/', 'http://localhost');
        const folder = Number(q.searchParams.get('folder') ?? '0') || 0;
        const sub = q.searchParams.get('path') ?? '';
        const files = this.onList ? this.onList(folder, sub) : [];
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ files, now: Date.now() }));
      } else if (url === '/scheduled') {
        const scheduled = this.onScheduled ? this.onScheduled() : [];
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ scheduled, now: Date.now() }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        try {
          this.onCmd?.(JSON.parse(raw.toString()) as MeterCommand);
        } catch {
          /* ignore malformed control messages */
        }
      });
    });
  }

  /** Register a handler for control messages sent from the meters page. */
  onCommand(fn: (cmd: MeterCommand) => void): void {
    this.onCmd = fn;
  }

  /** Register the provider for the `/files` directory listing. */
  onListFiles(fn: (folder: number, sub: string) => FileEntry[]): void {
    this.onList = fn;
  }

  /** Register the provider for the `/folders` dropdown listing. */
  onListFolders(fn: () => string[]): void {
    this.onFolders = fn;
  }

  /** Register the provider for the `/scheduled` upcoming-files listing. */
  onListScheduled(fn: () => ScheduleEntry[]): void {
    this.onScheduled = fn;
  }

  start(): void {
    this.server.listen(this.port, () => this.log.info(`meters on http://localhost:${this.port}`));
  }

  broadcast(snapshot: MeterSnapshot): void {
    const msg = JSON.stringify(snapshot);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }

  stop(): void {
    this.wss.close();
    this.server.close();
  }
}

/** The server's IANA timezone. Filename timestamps are parsed in this zone
 *  (schedule.ts builds local Dates), so the page renders all schedule times
 *  and the footer clock with it — a browser in another zone must not disagree
 *  with the clock that actually fires auto-play. */
const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>studiobox meters</title>
<style>
 body{background:#111;color:#ddd;font:13px monospace;margin:0;height:100vh;height:100dvh;overflow:hidden;display:flex;flex-direction:column}
 h1{font-size:16px;color:#8df;font-weight:bold;letter-spacing:.3px}
 .content{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;padding:14px 18px;overflow:hidden}
 .metering{flex:0 0 auto;min-height:0;display:flex;flex-direction:column;max-width:760px}
 table{border-collapse:collapse;width:100%;max-width:760px;table-layout:fixed;flex:0 0 auto}
 td,th{padding:8px 8px;text-align:right;border-bottom:1px solid #222;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 th:first-child,td:first-child{text-align:left}
 col.c-ch{width:20%}col.c-role{width:11%}col.c-out{width:22%}col.c-gate{width:10%}col.c-comp{width:15%}col.c-mix{width:10%}col.c-mute{width:12%}
 td.mute{text-align:center;overflow:visible}
 .mtbtn{margin:0;padding:3px 0;width:58px;font:12px monospace;background:#2a2a2a;color:#9c9;border:1px solid #4a4a4a;border-radius:4px}
 .mtbtn:hover{border-color:#7cf}
 .mtbtn.on{background:#3a2f1c;color:#e6c878;border-color:#8a6d2f}
 .bar{display:inline-block;height:10px;background:#3a7;vertical-align:middle}
 .gr{background:#c64}.duck{background:#c4a}
 .master{margin:12px 0;font-size:14px;flex:0 0 auto}
 .master .lbl{color:#7cf;margin:0 5px 0 14px}
 .master .lbl:first-child{margin-left:0}
 .master .v{display:inline-block;width:6.5ch;text-align:right;color:#ddd}
 button{margin:0;padding:8px 12px;font:13px monospace;background:#223;color:#cde;border:1px solid #456;border-radius:5px;cursor:pointer;transition:background .12s,border-color .12s}
 button:hover{border-color:#7cf}
 button.mic-live{background:#c33;color:#fff;border-color:#e66;font-weight:bold}
 button.muted{background:#333;color:#9ab;border-color:#555}
 button.rec{background:#622;color:#fdd;border-color:#a44}
 button.rec.on{background:#c33;color:#fff;border-color:#c33}
 button.ship{background:#264;color:#dfd;border-color:#4a6}
 button.ship.on{background:#2a7;color:#fff;border-color:#2a7}
 button.mon{background:#234;color:#cdf;border-color:#46a}
 button.mon.on{background:#37a;color:#fff;border-color:#37a}
 .files{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden;margin-top:10px;max-width:760px}
 #flist{list-style:none;margin:0;padding:0;flex:1 1 auto;overflow-y:auto;border-top:1px solid #222}
 .files li{padding:9px 8px;border-bottom:1px solid #222;cursor:pointer;display:flex;justify-content:space-between;gap:10px}
 .files li:hover{background:#1a1a1a}
 .files li.playing{background:#2a1830;color:#fbe}
 .files .none{color:#666}
 .files li .fname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .files li .when{color:#667;white-space:nowrap}
 .files li.dir{color:#8df}
 .files li.dir .when{color:#556}
 #crumbs{flex:0 0 auto;padding:7px 8px;color:#8df;white-space:nowrap;overflow-x:auto}
 #crumbs .seg{cursor:pointer}
 #crumbs .seg:hover{text-decoration:underline}
 #crumbs .seg.cur{color:#ddd;cursor:default;text-decoration:none}
 #crumbs .sep{color:#555;margin:0 5px}
 .files li.sched .when{color:#ffd24a}
 .files li.sched{background:#201c0e}
 .files li.sched.playing{background:#2a1830}
 .files li.next .when{font-weight:bold}
 .files li.next{border-left:3px solid #ffd24a;padding-left:5px}
 #next{color:#ffd24a;overflow-wrap:anywhere}
 #next .dim{color:#997}
 #folder{padding:6px 10px;font:14px monospace;min-width:180px;background:#223;color:#cde;border:1px solid #456;border-radius:5px}
 .nowplaying{color:#fbe;font-size:15px}
 .nowplaying b{color:#7cf}
 .bar-panel{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:9px 18px;
  background:linear-gradient(#1f1f1f,#171717);box-shadow:0 0 10px rgba(0,0,0,.55)}
 .topbar{border-bottom:1px solid #333;flex-wrap:wrap}
 .footer{border-top:1px solid #333;flex-direction:column;align-items:stretch;gap:8px}
 .footer .ctl{display:flex;align-items:center;gap:10px}
 .topbar h1{margin:0}
 .topbar .dot{color:#3c8;margin-right:6px}
 .topbar .spacer{flex:1}
 .topbar .fld{display:flex;align-items:center;gap:6px}
 .bar-panel button{width:172px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 /* Top-right ⋮ menu: transport toggles that don't need to sit in the bar. */
 .menuwrap{position:relative}
 #menuBtn{width:44px;padding:8px 0;font-size:17px;font-weight:bold}
 .menu{position:absolute;right:0;top:calc(100% + 6px);z-index:20;width:230px;display:flex;flex-direction:column;gap:6px;
  background:#1c1c1c;border:1px solid #444;border-radius:6px;padding:8px;box-shadow:0 5px 18px rgba(0,0,0,.65)}
 .menu button{width:100%;flex:none;text-align:left}
 .menu .fld{display:flex}
 .menu #folder{width:100%;min-width:0}
 /* Scheduled-files modal (opened from the ⋮ menu). */
 .modal{position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px}
 .mbox{background:#191919;border:1px solid #444;border-radius:8px;max-width:640px;width:100%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 6px 24px rgba(0,0,0,.7)}
 .mhead{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #333;color:#ffd24a}
 .mhead button{width:auto;padding:4px 10px}
 #mlist{list-style:none;margin:0;padding:0;overflow-y:auto}
 #mlist li{padding:9px 14px;border-bottom:1px solid #222;display:flex;justify-content:space-between;gap:12px}
 #mlist li:last-child{border-bottom:none}
 #mlist .fname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 #mlist .fname .fld{color:#667}
 #mlist .when{color:#ffd24a;white-space:nowrap}
 #mlist .none{color:#666}
 #clock{color:#8df;white-space:nowrap}
 #clock .tz{color:#667;margin-left:7px}
 #ftime{margin-right:auto;text-align:left}
 #ftime .rem{font-size:22px;font-weight:bold;color:#ffd24a;vertical-align:middle}
 /* Landscape (e.g. iPad rotated): two columns — metering left, files right. */
 @media (orientation:landscape) and (min-width:700px){
  .content{flex-direction:row;gap:22px}
  .metering{flex:1 1 0;min-width:0;max-width:none}
  .files{flex:1 1 0;min-width:0;max-width:none;margin-top:0}
 }
 /* Small portrait (phones): tighter chrome, full-width controls, and let the
    meter table scroll sideways instead of crushing its columns. */
 @media (max-width:520px){
  .content{padding:8px 10px}
  .bar-panel{padding:8px 10px;gap:8px}
  .topbar .spacer{display:none}
  .bar-panel button{flex:1 1 auto;width:auto;min-width:0}
  #menuBtn{flex:0 0 auto;width:44px}
  .menu button{flex:none;width:100%}
  .metering{overflow-x:auto}
  table{min-width:540px}
  td,th{padding:6px 5px}
  .master .lbl{margin:0 4px 0 8px}
  .footer .ctl{flex-wrap:wrap}
  #ftime{flex:1 1 100%}
 }
</style></head><body>
<div class="topbar bar-panel">
 <h1><span class="dot">●</span>studiobox</h1>
 <span class="spacer"></span>
 <button id="rec" class="rec" style="display:none">● Start recording</button>
 <button id="ship" class="ship" style="display:none">● Start streaming</button>
 <div class="menuwrap">
  <button id="menuBtn" title="more">⋮</button>
  <div id="menu" class="menu" style="display:none">
   <span class="fld" id="fldwrap"><select id="folder"></select></span>
   <button id="mon" class="mon" style="display:none">● Start local playout</button>
   <button id="schedBtn">⏰ Scheduled files</button>
  </div>
 </div>
</div>
<div class="content">
<div class="metering" id="metering">
<table id="t"><colgroup><col class="c-ch"><col class="c-role"><col class="c-out"><col class="c-gate"><col class="c-comp"><col class="c-mix"><col class="c-mute"></colgroup><thead><tr>
 <th>channel</th><th>role</th><th>out dB</th><th>gate</th><th>comp GR</th><th>automix</th><th>mute</th>
</tr></thead><tbody></tbody></table>
<div class="master">
 <span class="lbl">M</span><span class="v" id="mom">–</span>
 <span class="lbl">S</span><span class="v" id="st">–</span>
 <span class="lbl">Pk</span><span class="v" id="pk">–</span>
 <span class="lbl">Lim</span><span class="v" id="lgr">–</span>
 <span class="lbl">Duck</span><span class="v" id="duck">–</span>
</div>
</div>
<div class="files" id="files" style="display:none">
 <div id="crumbs"></div>
 <ul id="flist"></ul>
</div>
</div>
<div class="footer bar-panel">
 <div class="nowplaying" id="nowplaying" style="display:none"></div>
 <div class="nowplaying" id="next" style="display:none"></div>
 <div class="ctl">
  <span id="clock"></span>
  <span id="ftime"></span>
  <button id="stop">■ Stop file</button>
  <button id="mute">Mute mics</button>
 </div>
</div>
<div id="modal" class="modal" style="display:none">
 <div class="mbox">
  <div class="mhead"><b>⏰ Scheduled files</b><button id="mclose">✕</button></div>
  <ul id="mlist"></ul>
 </div>
</div>
<script>
 const fmt=(v,d=1)=>(v===null||v===undefined||!isFinite(v))?'–':v.toFixed(d);
 const mmss=v=>{if(v===null||v===undefined||!isFinite(v))return '–';const s=Math.max(0,Math.round(v));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
 const bar=(v,max,cls)=>{const w=Math.max(0,Math.min(1,v/max))*60;return '<span class="bar '+(cls||'')+'" style="width:'+w+'px"></span>'};
 const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
 // Build the meter rows once (rebuilding only when the channel set changes) and
 // update cell contents in place each frame. Rebuilding the whole tbody every
 // frame would destroy the per-row mute buttons mid-click, breaking the toggle.
 let rowEls=null;
 function ensureRows(channels){
  const tb=document.querySelector('#t tbody');
  if(rowEls&&rowEls.length===channels.length&&rowEls.every((r,i)=>r.label===channels[i].label))return;
  tb.innerHTML='';
  rowEls=channels.map(c=>{const tr=document.createElement('tr');
   tr.innerHTML='<td>'+esc(c.label)+'</td><td>'+esc(c.role)+'</td>'+
    '<td class="cout"></td><td class="cgate"></td><td class="ccomp"></td><td class="cmix"></td>'+
    '<td class="mute"><button class="mtbtn" data-label="'+esc(c.label)+'">mute</button></td>';
   tb.appendChild(tr);
   return {label:c.label,out:tr.querySelector('.cout'),gate:tr.querySelector('.cgate'),
    comp:tr.querySelector('.ccomp'),mix:tr.querySelector('.cmix'),mbtn:tr.querySelector('.mtbtn')};});
 }
 function updateRows(channels){
  ensureRows(channels);
  channels.forEach((c,i)=>{const r=rowEls[i];const mic=c.role==='mic';
   r.out.innerHTML=fmt(c.outDb)+' '+bar(c.outDb+60,60);
   // gate / comp GR / automix are mic-only concepts — blank them for music rows.
   r.gate.innerHTML=mic?bar(c.gateOpen,1):'';
   r.comp.innerHTML=mic?fmt(c.compGrDb)+' '+bar(c.compGrDb,20,'gr'):'';
   r.mix.textContent=mic?fmt(c.automixGainDb):'';
   r.mbtn.className='mtbtn'+(c.muted?' on':'');
   r.mbtn.textContent=c.muted?'unmute':'mute';});
 }
 let ws, muted=false, playing=null, recording=null, streaming=null, monitor=null;
 const mbtn=document.getElementById('mute');
 function setBtn(){
  if(muted){mbtn.textContent='▶ Music only';mbtn.className='muted';mbtn.title='Mics muted — click to open mics';}
  else{mbtn.textContent='● Mics open';mbtn.className='mic-live';mbtn.title='Mics are live — click for music only';}
 }
 mbtn.onclick=()=>{muted=!muted;setBtn();if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'micsMuted',value:muted}));};
 function send(cmd){if(ws&&ws.readyState===1)ws.send(JSON.stringify(cmd));}
 const rbtn=document.getElementById('rec');
 function setRec(){if(recording===null){rbtn.style.display='none';return;}rbtn.style.display='';rbtn.textContent=recording?'■ Stop recording':'● Start recording';rbtn.className='rec'+(recording?' on':'');}
 rbtn.onclick=()=>{if(recording===null)return;recording=!recording;setRec();send({type:'recording',value:recording});};
 const sbtn=document.getElementById('ship');
 function setShip(){if(streaming===null){sbtn.style.display='none';return;}sbtn.style.display='';sbtn.textContent=streaming?'■ Stop streaming':'● Start streaming';sbtn.className='ship'+(streaming?' on':'');}
 sbtn.onclick=()=>{if(streaming===null)return;streaming=!streaming;setShip();send({type:'streaming',value:streaming});};
 const mbtn2=document.getElementById('mon');
 function setMon(){if(monitor===null){mbtn2.style.display='none';return;}mbtn2.style.display='';mbtn2.textContent=monitor?'■ Stop local playout':'● Start local playout';mbtn2.className='mon'+(monitor?' on':'');}
 mbtn2.onclick=()=>{if(monitor===null)return;monitor=!monitor;setMon();send({type:'monitor',value:monitor});};
 const filesBox=document.getElementById('files'),flist=document.getElementById('flist'),folderSel=document.getElementById('folder');
 const crumbs=document.getElementById('crumbs');
 let folder=0,subPath='',folderLabels=[];
 const stopBtn=document.getElementById('stop');
 // The Stop-file button only makes sense while a file is playing.
 function setStop(){stopBtn.style.display=playing?'':'none';}
 stopBtn.onclick=()=>send({type:'stopFile'});
 // Per-row mute toggles: the tbody is rebuilt every frame, so delegate the
 // click to the persistent tbody and read the channel label from the button.
 document.querySelector('#t tbody').addEventListener('click',e=>{
  const b=e.target.closest('.mtbtn');if(!b)return;
  send({type:'channelMuted',value:{label:b.dataset.label,muted:!b.classList.contains('on')}});
 });
 folderSel.onchange=()=>{folder=Number(folderSel.value)||0;subPath='';menu.style.display='none';loadFiles();};
 const npbox=document.getElementById('nowplaying');
 function markPlaying(){[...flist.children].forEach(li=>{if(li.classList.contains('dir'))return;li.className=(li.dataset.name===playing)?'playing':'';});
  if(playing){npbox.style.display='';npbox.innerHTML='♪ now playing: <b>'+playing.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</b>';}
  else{npbox.style.display='none';}
  setStop();}
 function updateFileTime(pos,dur){const el=document.getElementById('ftime');if(!el)return;
  if(dur!==null&&dur!==undefined&&isFinite(dur)){el.innerHTML='<span class="rem">'+mmss(dur-(pos||0))+' left</span>';}
  else if(pos!==null&&pos!==undefined&&isFinite(pos)){el.innerHTML='<span class="rem">'+mmss(pos)+'</span>';}
  else el.innerHTML='';}
 function loadFolders(){fetch('folders').then(r=>r.json()).then(d=>{
  const fl=d.folders||[];
  folderLabels=fl;
  document.getElementById('fldwrap').style.display=fl.length>1?'':'none';
  folderSel.innerHTML='';
  fl.forEach((label,i)=>{const o=document.createElement('option');o.value=i;
   o.textContent=label;folderSel.appendChild(o);});
  if(folder>=fl.length)folder=0;
  folderSel.value=folder;
  loadFiles();
 }).catch(()=>{loadFiles();});}
 // Server-clock skew (serverNow - clientNow): schedule marks compare against
 // the *server's* clock, which is what actually triggers auto-play.
 let clockSkew=0;
 const srvNow=()=>Date.now()+clockSkew;
 // All schedule times render in the *server's* timezone: filename timestamps
 // are parsed there, so a browser sitting in another zone must still show the
 // wallclock the operator wrote into the filename.
 const serverTz='__SERVER_TZ__';
 const mkFmt=o=>{try{return new Intl.DateTimeFormat('de-DE',Object.assign({timeZone:serverTz},o));}
  catch(e){return new Intl.DateTimeFormat('de-DE',o);}};
 const dayFmt=mkFmt({day:'2-digit',month:'2-digit'});
 const timeFmt=mkFmt({hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
 const fmtWhen=ms=>{const sameDay=dayFmt.format(ms)===dayFmt.format(srvNow());
  return (sameDay?'':dayFmt.format(ms)+' ')+timeFmt.format(ms);};
 // Live server clock in the footer — the clock auto-play actually fires on.
 const clockEl=document.getElementById('clock');
 const tickClock=()=>{clockEl.innerHTML='⏱ '+timeFmt.format(srvNow())+' <span class="tz">'+esc(serverTz)+'</span>';};
 tickClock();setInterval(tickClock,1000);
 // Re-apply schedule marks to the existing rows (which timestamps are still in
 // the future changes as time passes, without any new fetch).
 function markSchedule(){
  const rows=[...flist.children].filter(li=>li.dataset.name);
  let next=null;
  rows.forEach(li=>{const at=Number(li.dataset.playat);
   const up=isFinite(at)&&at>0&&at>srvNow();
   li.classList.toggle('sched',up);
   li.classList.remove('next');
   if(up&&(next===null||at<Number(next.dataset.playat)))next=li;});
  if(next)next.classList.add('next');
 }
 // Breadcrumb over the current position: folder label + each subPath segment,
 // every non-current segment clickable to jump back up.
 function renderCrumbs(){
  const segs=subPath?subPath.split('/'):[];
  let html='<span class="seg'+(segs.length?'':' cur')+'" data-i="-1">'+esc(folderLabels[folder]||'files')+'</span>';
  segs.forEach((s,i)=>{html+='<span class="sep">/</span><span class="seg'+(i===segs.length-1?' cur':'')+'" data-i="'+i+'">'+esc(s)+'</span>';});
  crumbs.innerHTML=html;
 }
 crumbs.onclick=e=>{const s=e.target.closest('.seg');if(!s||s.classList.contains('cur'))return;
  const i=Number(s.dataset.i);
  subPath=i<0?'':subPath.split('/').slice(0,i+1).join('/');
  loadFiles();};
 function loadFiles(){fetch('files?folder='+folder+'&path='+encodeURIComponent(subPath)).then(r=>r.json()).then(d=>{
  const fs=d.files||[];
  if(typeof d.now==='number')clockSkew=d.now-Date.now();
  filesBox.style.display='';
  renderCrumbs();
  flist.innerHTML='';
  if(!fs.length){flist.innerHTML='<li class="none">no audio files in this folder</li>';return;}
  fs.forEach(f=>{
   // Backward compatible: entries are {name,playAtMs} objects (or bare strings).
   const name=typeof f==='string'?f:f.name;
   const li=document.createElement('li');
   if(typeof f==='object'&&f&&f.dir){
    // Subdirectory row: descend instead of playing.
    li.className='dir';
    li.innerHTML='<span class="fname">📁 '+esc(name)+'</span><span class="when">›</span>';
    li.onclick=()=>{subPath=subPath?subPath+'/'+name:name;loadFiles();};
    flist.appendChild(li);return;
   }
   const at=typeof f==='object'&&f&&isFinite(f.playAtMs)?f.playAtMs:null;
   li.dataset.name=name;
   if(at!==null)li.dataset.playat=at;
   const when=at!==null?'⏰ '+fmtWhen(at):'▶';
   const rel=subPath?subPath+'/'+name:name;
   li.innerHTML='<span class="fname">'+esc(name)+'</span><span class="when">'+when+'</span>';
   li.onclick=()=>send({type:'playFile',value:{folder:folder,name:rel}});flist.appendChild(li);});
  markSchedule();
  markPlaying();
 }).catch(()=>{});}
 // Keep the listing and its future/past marks fresh (new synced files appear,
 // elapsed timestamps lose their highlight).
 setInterval(loadFiles,30000);
 setInterval(markSchedule,5000);
 const nextBox=document.getElementById('next');
 function setNext(n){
  if(n&&n.name){nextBox.style.display='';
   // Folder-relative names: show the directory part dimmed, keep the (long,
   // wrappable) filename prominent instead of ellipsizing the whole line.
   const parts=String(n.name).split('/');
   const base=parts.pop();
   const dir=parts.length?'<span class="dim">'+esc(parts.join(' / '))+' /</span> ':'';
   nextBox.innerHTML='⏰ next auto-play: '+dir+'<b>'+esc(base)+'</b> @ '+fmtWhen(n.playAtMs);}
  else nextBox.style.display='none';
 }
 function connect(){
  ws=new WebSocket('ws://'+location.host);
  ws.onmessage=e=>{const s=JSON.parse(e.data);
   if(typeof s.serverNowMs==='number')clockSkew=s.serverNowMs-Date.now();
   // Playout-only mode: no channels -> hide the whole metering/mute surface.
   const playoutOnly=!s.channels||!s.channels.length;
   document.getElementById('metering').style.display=playoutOnly?'none':'';
   mbtn.style.display=playoutOnly?'none':'';
   if(typeof s.micsMuted==='boolean'&&s.micsMuted!==muted){muted=s.micsMuted;setBtn();}
   if(s.recording!==recording){recording=s.recording;setRec();}
   if(s.streaming!==streaming){streaming=s.streaming;setShip();}
   if(s.monitor!==monitor){monitor=s.monitor;setMon();}
   if(s.filePlaying!==playing){playing=s.filePlaying;markPlaying();}
   setNext(s.nextScheduled||null);
   updateFileTime(s.filePosition,s.fileDuration);
   if(!playoutOnly){
    updateRows(s.channels);
    document.getElementById('mom').textContent=fmt(s.momentaryLufs);
    document.getElementById('st').textContent=fmt(s.shortTermLufs);
    document.getElementById('pk').textContent=fmt(s.outPeakDb);
    document.getElementById('lgr').textContent=fmt(s.limiterGrDb);
    document.getElementById('duck').textContent=fmt(s.duckDepthDb);
   }
  };
  ws.onclose=()=>setTimeout(connect,1000);
 }
 // ⋮ menu (top-right): local-playout toggle + scheduled-files modal; more to come.
 const menu=document.getElementById('menu'),menuBtn=document.getElementById('menuBtn');
 menuBtn.onclick=e=>{e.stopPropagation();menu.style.display=menu.style.display==='none'?'':'none';};
 document.addEventListener('click',e=>{if(!menu.contains(e.target))menu.style.display='none';});
 // Scheduled-files modal: every future timestamped file across all folders.
 const modal=document.getElementById('modal'),mlist=document.getElementById('mlist');
 function openSched(){modal.style.display='';
  mlist.innerHTML='<li class="none">loading…</li>';
  fetch('scheduled').then(r=>r.json()).then(d=>{
   if(typeof d.now==='number')clockSkew=d.now-Date.now();
   const up=(d.scheduled||[]).filter(e=>e.playAtMs>srvNow()).sort((a,b)=>a.playAtMs-b.playAtMs);
   if(!up.length){mlist.innerHTML='<li class="none">nothing scheduled</li>';return;}
   mlist.innerHTML='';
   up.forEach(e=>{const li=document.createElement('li');
    const fl=folderLabels.length>1?'<span class="fld">'+esc(folderLabels[e.folder]||'')+' / </span>':'';
    li.innerHTML='<span class="fname">'+fl+esc(e.name)+'</span><span class="when">'+fmtWhen(e.playAtMs)+'</span>';
    mlist.appendChild(li);});
  }).catch(()=>{mlist.innerHTML='<li class="none">could not load the schedule</li>';});}
 document.getElementById('schedBtn').onclick=()=>{menu.style.display='none';openSched();};
 document.getElementById('mclose').onclick=()=>{modal.style.display='none';};
 modal.onclick=e=>{if(e.target===modal)modal.style.display='none';};
 setBtn();
 setRec();
 setShip();
 setMon();
 setStop();
 loadFolders();
 connect();
</script></body></html>`;
