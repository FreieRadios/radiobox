import * as http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { MeterSnapshot } from '../dsp/graph';
import { Log } from '../util/log';

/** Headless metering: serves a tiny self-contained page and pushes meter
 *  snapshots over WebSocket at the configured frame rate. */
export class MeterServer {
  private server: http.Server;
  private wss: WebSocketServer;

  constructor(private port: number, private log: Log) {
    this.server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.wss = new WebSocketServer({ server: this.server });
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
 body{background:#111;color:#ddd;font:13px monospace;margin:16px}
 h1{font-size:15px;color:#7cf}
 table{border-collapse:collapse;width:100%;max-width:760px}
 td,th{padding:4px 8px;text-align:right;border-bottom:1px solid #222}
 th:first-child,td:first-child{text-align:left}
 .bar{display:inline-block;height:10px;background:#3a7;vertical-align:middle}
 .gr{background:#c64}.duck{background:#c4a}
 .master{margin-top:16px;font-size:14px}
 .master span{color:#7cf}
</style></head><body>
<h1>studiobox — live meters</h1>
<table id="t"><thead><tr>
 <th>channel</th><th>role</th><th>out dB</th><th>gate</th><th>comp GR</th><th>automix</th>
</tr></thead><tbody></tbody></table>
<div class="master">
 momentary <span id="mom">–</span> LUFS &nbsp; short-term <span id="st">–</span> LUFS &nbsp;
 peak <span id="pk">–</span> dBFS &nbsp; limiter GR <span id="lgr">–</span> dB &nbsp;
 duck <span id="duck">–</span> dB
</div>
<script>
 const fmt=(v,d=1)=>(v===null||v===undefined||!isFinite(v))?'–':v.toFixed(d);
 const bar=(v,max,cls)=>{const w=Math.max(0,Math.min(1,v/max))*60;return '<span class="bar '+(cls||'')+'" style="width:'+w+'px"></span>'};
 function connect(){
  const ws=new WebSocket('ws://'+location.host);
  ws.onmessage=e=>{const s=JSON.parse(e.data);
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
 connect();
</script></body></html>`;
