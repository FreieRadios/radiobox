import * as http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { MeterSnapshot } from '../dsp/graph';
import { Log } from '../util/log';

/** Headless metering: serves a tiny self-contained page and pushes meter
 *  snapshots over WebSocket at the configured frame rate.
 *
 *  Control protocol (client -> server, JSON over WebSocket):
 *   - { type: 'micsMuted', value: boolean }  toggle "music only" mode
 *   - { type: 'recording', value: boolean }  start/stop the local FLAC recording
 *   - { type: 'streaming', value: boolean }  start/stop shipping to the harbor
 *   - { type: 'monitor', value: boolean }    start/stop local hardware playout
 *   - { type: 'playFile', value: { folder, name } } play a file from a folder
 *   - { type: 'stopFile' }                    stop local file playback
 *  The configured folders are served over HTTP at `/folders`, and the file
 *  listing for one folder at `/files?folder=N`. */
export interface MeterCommand {
  type: string;
  value?: unknown;
}

export class MeterServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private onCmd: ((cmd: MeterCommand) => void) | null = null;
  private onList: ((folder: number) => string[]) | null = null;
  private onFolders: (() => string[]) | null = null;

  constructor(
    private port: number,
    private log: Log
  ) {
    this.server = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0];
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
      } else if (url === '/folders') {
        const folders = this.onFolders ? this.onFolders() : [];
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ folders }));
      } else if (url === '/files') {
        const q = new URL(req.url ?? '/', 'http://localhost');
        const folder = Number(q.searchParams.get('folder') ?? '0') || 0;
        const files = this.onList ? this.onList(folder) : [];
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ files }));
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
  onListFiles(fn: (folder: number) => string[]): void {
    this.onList = fn;
  }

  /** Register the provider for the `/folders` dropdown listing. */
  onListFolders(fn: () => string[]): void {
    this.onFolders = fn;
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>studiobox meters</title>
<style>
 body{background:#111;color:#ddd;font:13px monospace;margin:0;height:100vh;overflow:hidden;display:flex;flex-direction:column}
 h1{font-size:16px;color:#8df;font-weight:bold;letter-spacing:.3px}
 .content{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;padding:14px 18px;overflow:hidden}
 .metering{flex:0 0 auto;min-height:0;display:flex;flex-direction:column;max-width:760px}
 table{border-collapse:collapse;width:100%;max-width:760px;table-layout:fixed;flex:0 0 auto}
 td,th{padding:4px 8px;text-align:right;border-bottom:1px solid #222;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 th:first-child,td:first-child{text-align:left}
 col.c-ch{width:22%}col.c-role{width:12%}col.c-out{width:24%}col.c-gate{width:12%}col.c-comp{width:18%}col.c-mix{width:12%}
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
 .files li{padding:9px 8px;border-bottom:1px solid #222;cursor:pointer;display:flex;justify-content:space-between}
 .files li:hover{background:#1a1a1a}
 .files li.playing{background:#2a1830;color:#fbe}
 .files .none{color:#666}
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
 #ftime{margin-right:auto;text-align:left}
 #ftime .rem{font-size:22px;font-weight:bold;color:#ffd24a;vertical-align:middle}
 /* Landscape (e.g. iPad rotated): two columns — metering left, files right. */
 @media (orientation:landscape) and (min-width:700px){
  .content{flex-direction:row;gap:22px}
  .metering{flex:1 1 0;min-width:0;max-width:none}
  .files{flex:1 1 0;min-width:0;max-width:none;margin-top:0}
 }
</style></head><body>
<div class="topbar bar-panel">
 <h1><span class="dot">●</span>studiobox</h1>
 <span class="spacer"></span>
 <span class="fld" id="fldwrap"><select id="folder"></select></span>
 <button id="rec" class="rec" style="display:none">● Start recording</button>
 <button id="ship" class="ship" style="display:none">● Start streaming</button>
 <button id="mon" class="mon" style="display:none">● Start local playout</button>
</div>
<div class="content">
<div class="metering">
<table id="t"><colgroup><col class="c-ch"><col class="c-role"><col class="c-out"><col class="c-gate"><col class="c-comp"><col class="c-mix"></colgroup><thead><tr>
 <th>channel</th><th>role</th><th>out dB</th><th>gate</th><th>comp GR</th><th>automix</th>
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
 <ul id="flist"></ul>
</div>
</div>
<div class="footer bar-panel">
 <div class="nowplaying" id="nowplaying" style="display:none"></div>
 <div class="ctl">
  <span id="ftime"></span>
  <button id="stop">■ Stop file</button>
  <button id="mute">Mute mics</button>
 </div>
</div>
<script>
 const fmt=(v,d=1)=>(v===null||v===undefined||!isFinite(v))?'–':v.toFixed(d);
 const mmss=v=>{if(v===null||v===undefined||!isFinite(v))return '–';const s=Math.max(0,Math.round(v));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
 const bar=(v,max,cls)=>{const w=Math.max(0,Math.min(1,v/max))*60;return '<span class="bar '+(cls||'')+'" style="width:'+w+'px"></span>'};
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
 let folder=0;
 const stopBtn=document.getElementById('stop');
 // The Stop-file button only makes sense while a file is playing.
 function setStop(){stopBtn.style.display=playing?'':'none';}
 stopBtn.onclick=()=>send({type:'stopFile'});
 folderSel.onchange=()=>{folder=Number(folderSel.value)||0;loadFiles();};
 const npbox=document.getElementById('nowplaying');
 function markPlaying(){[...flist.children].forEach(li=>{li.className=(li.dataset.name===playing)?'playing':'';});
  if(playing){npbox.style.display='';npbox.innerHTML='♪ now playing: <b>'+playing.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</b>';}
  else{npbox.style.display='none';}
  setStop();}
 function updateFileTime(pos,dur){const el=document.getElementById('ftime');if(!el)return;
  if(dur!==null&&dur!==undefined&&isFinite(dur)){el.innerHTML='<span class="rem">'+mmss(dur-(pos||0))+' left</span>';}
  else if(pos!==null&&pos!==undefined&&isFinite(pos)){el.innerHTML='<span class="rem">'+mmss(pos)+'</span>';}
  else el.innerHTML='';}
 function loadFolders(){fetch('folders').then(r=>r.json()).then(d=>{
  const fl=d.folders||[];
  document.getElementById('fldwrap').style.display=fl.length>1?'':'none';
  folderSel.innerHTML='';
  fl.forEach((label,i)=>{const o=document.createElement('option');o.value=i;
   o.textContent=label;folderSel.appendChild(o);});
  if(folder>=fl.length)folder=0;
  folderSel.value=folder;
  loadFiles();
 }).catch(()=>{loadFiles();});}
 function loadFiles(){fetch('files?folder='+folder).then(r=>r.json()).then(d=>{
  const fs=d.files||[];
  filesBox.style.display='';
  if(!fs.length){flist.innerHTML='<li class="none">no audio files in this folder</li>';return;}
  flist.innerHTML='';
  fs.forEach(name=>{const li=document.createElement('li');li.dataset.name=name;
   li.innerHTML='<span>'+name+'</span><span>▶</span>';
   li.onclick=()=>send({type:'playFile',value:{folder:folder,name:name}});flist.appendChild(li);});
  markPlaying();
 }).catch(()=>{});}
 function connect(){
  ws=new WebSocket('ws://'+location.host);
  ws.onmessage=e=>{const s=JSON.parse(e.data);
   if(typeof s.micsMuted==='boolean'&&s.micsMuted!==muted){muted=s.micsMuted;setBtn();}
   if(s.recording!==recording){recording=s.recording;setRec();}
   if(s.streaming!==streaming){streaming=s.streaming;setShip();}
   if(s.monitor!==monitor){monitor=s.monitor;setMon();}
   if(s.filePlaying!==playing){playing=s.filePlaying;markPlaying();}
   updateFileTime(s.filePosition,s.fileDuration);
   const tb=document.querySelector('#t tbody');
   tb.innerHTML=s.channels.map(c=>'<tr><td>'+c.label+'</td><td>'+c.role+'</td>'+
    '<td>'+fmt(c.outDb)+' '+bar(c.outDb+60,60)+'</td>'+
    '<td>'+bar(c.gateOpen,1)+'</td>'+
    '<td>'+fmt(c.compGrDb)+' '+bar(c.compGrDb,20,'gr')+'</td>'+
    '<td>'+fmt(c.automixGainDb)+'</td></tr>').join('');
   document.getElementById('mom').textContent=fmt(s.momentaryLufs);
   document.getElementById('st').textContent=fmt(s.shortTermLufs);
   document.getElementById('pk').textContent=fmt(s.outPeakDb);
   document.getElementById('lgr').textContent=fmt(s.limiterGrDb);
   document.getElementById('duck').textContent=fmt(s.duckDepthDb);
  };
  ws.onclose=()=>setTimeout(connect,1000);
 }
 setBtn();
 setRec();
 setShip();
 setMon();
 setStop();
 loadFolders();
 connect();
</script></body></html>`;
