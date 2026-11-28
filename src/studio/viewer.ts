// Read-only local viewer: one self-contained page on 127.0.0.1 with pan, zoom, groups, edges,
// thumbnails, take history, full-size preview and live refresh from events.jsonl. Serves files
// only from a graph's assets/, handoff/, views/ and .previews/ folders. No dependencies.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { evaluate } from "./evaluate.js";
import { ensurePreview, listGraphs } from "./api.js";
import { graphDir, readBoth, readEvents, studioRoot } from "./store.js";
import { liveJob, listRecords, readRecord } from "./runner.js";

const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".md": "text/markdown; charset=utf-8", ".json": "application/json; charset=utf-8" };
const ROOTS = ["assets", "handoff", "views", ".previews"];

export interface ViewerOptions { project: string; graph?: string; port?: number; idleExitMinutes?: number; onListen?: (url: string) => void }

/** Resolve a request path inside a graph's served folders, following symlinks before checking. */
export function safeFile(project: string, slug: string, rel: string): string | null {
  let dir: string;
  try { dir = graphDir(project, slug); } catch { return null; }
  if (!rel || isAbsolute(rel) || rel.includes("\0")) return null;
  const abs = resolve(dir, rel);
  const r = relative(dir, abs);
  if (!r || r.startsWith("..") || isAbsolute(r) || !ROOTS.includes(r.split(sep)[0]!)) return null;
  if (!TYPES[extname(abs).toLowerCase()] || !existsSync(abs)) return null;
  try {
    const real = realpathSync(abs), realDir = realpathSync(dir);
    const rr = relative(realDir, real);
    if (!rr || rr.startsWith("..") || isAbsolute(rr) || !statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}

export async function viewerModel(project: string, slug: string) {
  const dir = graphDir(project, slug);
  const { graph, state } = await readBoth(dir);
  const live = await liveJob(dir);
  const evals = await evaluate(graph, state, { dir, project, liveJob: live });
  const jobs = await listRecords(dir);
  const run = jobs.length ? await readRecord(dir, jobs.at(-1)!).catch(() => null) : null;
  return {
    slug, name: graph.name, revision: graph.revision, stateRevision: state.revision, lastSeq: state.eventSeq, live: live ?? null,
    run: run ? { id: run.id, status: live === run.id ? run.status : run.status === "running" || run.status === "starting" ? "interrupted" : run.status, progress: run.progress, planned: run.planned } : null,
    groups: graph.groups, edges: graph.edges,
    nodes: graph.nodes.map(n => {
      const ev = evals.get(n.id)!;
      const ns = state.nodes[n.id];
      return {
        id: n.id, type: n.type, label: n.label ?? null, group: n.group ?? null, position: n.position ?? { x: 0, y: 0 }, settings: n.settings,
        status: ev.status, issues: ev.issues, upstreamStale: ev.upstreamStale,
        outputs: (ev.images ?? []).map(i => ({ ref: `${i.node}/${i.take}`, asset: i.asset, current: i.current, verdict: i.verdict ?? null,
          kind: state.nodes[i.node]?.takes.find(t => t.id === i.take)?.kind ?? "image" })),
        takes: (ns?.takes ?? []).map(t => ({ id: t.id, kind: t.kind, asset: t.asset, verdict: t.verdict ?? null, created: t.created, slot: t.slot, variant: t.variant, width: t.width, height: t.height,
          prompt: t.text?.prompt ?? null, compiledPrompt: t.text?.compiledPrompt ?? null, files: t.files ?? [], generations: t.generations, selected: ns!.selected.includes(t.id) })),
        picks: ns?.picks ?? [], error: ns?.error ?? null,
      };
    }),
  };
}

function send(res: ServerResponse, code: number, body: string | Buffer, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

export function serveViewer(opts: ViewerOptions): Promise<void> {
  const { project } = opts;
  let lastHit = Date.now();
  return new Promise((done, fail) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      lastHit = Date.now();
      try {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        const host = (req.headers.host ?? "").toLowerCase();
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, JSON.stringify({ error: "bad host" }));
        if (req.method !== "GET") return send(res, 405, JSON.stringify({ error: "read-only" }));
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        const g = url.searchParams.get("g") ?? "";
        if (url.pathname === "/") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
          return res.end(PAGE.replace("__DEFAULT_GRAPH__", JSON.stringify(opts.graph ?? null)));
        }
        if (url.pathname === "/api/graphs") return send(res, 200, JSON.stringify(await listGraphs({ project })));
        if (url.pathname === "/api/graph") return send(res, 200, JSON.stringify(await viewerModel(project, g)));
        if (url.pathname === "/api/events") {
          const after = Number(url.searchParams.get("after") ?? 0) || 0;
          return send(res, 200, JSON.stringify({ events: await readEvents(graphDir(project, g), after, 50) }));
        }
        if (url.pathname === "/file" || url.pathname === "/thumb") {
          const rel = url.searchParams.get("p") ?? "";
          let file = safeFile(project, g, rel);
          if (!file) return send(res, 404, JSON.stringify({ error: "not found" }));
          if (url.pathname === "/thumb" && /\.(png|jpe?g|webp)$/i.test(file)) {
            const prev = await ensurePreview(graphDir(project, g), rel, 560);
            if (prev) file = prev;
          }
          res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()]!, "cache-control": "max-age=60", "x-content-type-options": "nosniff" });
          return createReadStream(file).pipe(res);
        }
        send(res, 404, JSON.stringify({ error: "not found" }));
      } catch (e) {
        send(res, 500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    });
    const listen = (port: number, fallback: boolean) => {
      server.once("error", (e: any) => { if (fallback && e?.code === "EADDRINUSE") listen(0, false); else fail(e); });
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}/${opts.graph ? `#${opts.graph}` : ""}`;
        process.stdout.write(`${url}\n`);
        process.stderr.write(`Studio viewer for ${studioRoot(project)} (read-only, 127.0.0.1 only). Ctrl+C to stop.\n`);
        opts.onListen?.(url);
      });
    };
    listen(opts.port ?? 4780, opts.port === undefined);
    const idle = (opts.idleExitMinutes ?? 0) * 60_000;
    if (idle > 0) {
      const t = setInterval(() => { if (Date.now() - lastHit > idle) { clearInterval(t); server.close(() => done()); } }, 10_000);
      t.unref();
    }
    server.on("close", () => done());
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Studio viewer</title><link rel="icon" href="data:,">
<style>
:root{--bg:#f4f3ef;--panel:#fff;--ink:#1d1d1b;--muted:#6b6a65;--line:#d9d7cf;--edge:#9b988d;--accent:#2f6f5e;--warn:#b8641c;--bad:#b23a3a;--grp:rgba(47,111,94,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#151514;--panel:#1f1f1d;--ink:#ecebe6;--muted:#9c9a93;--line:#34332f;--edge:#6d6b64;--accent:#6cc0a6;--warn:#e0a060;--bad:#e07070;--grp:rgba(108,192,166,.07)}}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;overflow:hidden}
header{position:fixed;top:0;left:0;right:0;height:44px;display:flex;align-items:center;gap:12px;padding:0 14px;background:var(--panel);border-bottom:1px solid var(--line);z-index:5}
header h1{font-size:14px;margin:0;font-weight:600}header select,header button{font:inherit;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
#live{color:var(--muted);font-size:12px;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:50vw}
#stage{position:fixed;top:44px;left:0;right:0;bottom:0;cursor:grab;touch-action:none}#stage.drag{cursor:grabbing}
#world{position:absolute;left:0;top:0;transform-origin:0 0}
svg#edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.grp{position:absolute;border:1px dashed var(--line);background:var(--grp);border-radius:12px}
.grp b{position:absolute;top:-20px;left:4px;font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.node{position:absolute;width:240px;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 1px 2px rgba(0,0,0,.06);cursor:pointer;overflow:hidden}
.node.sel{outline:2px solid var(--accent)}
.node .hd{display:flex;align-items:center;gap:6px;padding:7px 9px;border-bottom:1px solid var(--line)}
.node .ty{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#fff;border-radius:4px;padding:1px 5px}
.node .id{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.pill{font-size:10px;border-radius:9px;padding:1px 7px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.pill.current{color:var(--accent);border-color:var(--accent)}.pill.stale,.pill.blocked,.pill.needs-input{color:var(--warn);border-color:var(--warn)}.pill.failed{color:var(--bad);border-color:var(--bad)}.pill.running,.pill.queued{color:#fff;background:var(--accent);border-color:var(--accent)}
.node.img{width:280px}
.node .pk{padding:10px 9px;font-size:12px;border-bottom:1px solid var(--line)}.node .pk a{color:var(--accent)}
.node .pv{position:relative;background:var(--bg);height:260px;display:flex;align-items:center;justify-content:center}
.node .pv img{max-width:100%;max-height:260px;object-fit:contain;display:block}
.node .pv.approved{box-shadow:inset 0 0 0 3px var(--accent)}.node .pv.rejected img{opacity:.45}
.node .pv .vd{position:absolute;left:6px;top:6px;font-size:10px;font-weight:700;text-transform:uppercase;padding:1px 6px;border-radius:4px;background:var(--accent);color:#fff}
.node .pv.rejected .vd{background:#b33}
.node .st{display:flex;align-items:center;gap:6px;padding:5px 8px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--line)}
.node .st button{border:1px solid var(--line);background:var(--panel);color:inherit;border-radius:5px;width:24px;height:22px;cursor:pointer;padding:0;font:inherit}
.node .st .ref{flex:1;text-align:center;font-variant-numeric:tabular-nums}
.node .tx{padding:6px 9px 8px;color:var(--muted);font-size:12px;max-height:62px;overflow:hidden}
.note{position:absolute;width:200px;background:#fff6c9;color:#3b3722;border:1px solid #e6d98a;border-radius:6px;padding:7px 9px;font-size:12px;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.note.res{opacity:.55}.note i{display:block;font-style:normal;font-size:10px;color:#7a7040;margin-bottom:2px}
aside{position:fixed;top:44px;right:0;bottom:0;width:min(420px,100vw);background:var(--panel);border-left:1px solid var(--line);overflow:auto;padding:14px;z-index:4;display:none}
aside.open{display:block}aside h2{font-size:15px;margin:0 0 4px}aside .close{float:right}aside pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);padding:8px;border-radius:6px;font-size:11px}
.takes{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.take{font-size:11px;color:var(--muted);cursor:zoom-in}.take img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;border:2px solid transparent;background:var(--bg)}
.take.out img{border-color:var(--accent)}.badge{font-weight:600}.badge.approved{color:var(--accent)}.badge.rejected{color:var(--bad)}
.issue{color:var(--warn);font-size:12px;margin:4px 0}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.86);display:none;z-index:9;align-items:center;justify-content:center;flex-direction:column;gap:10px;padding:20px}
#lb.open{display:flex}#lb img{max-width:100%;max-height:82vh;object-fit:contain}#lb p{color:#ddd;max-width:900px;font-size:12px;margin:0;max-height:12vh;overflow:auto}
#empty{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:var(--muted)}
</style></head><body>
<header><h1>Studio</h1><select id="pick" aria-label="Graph"></select><button id="fit">Fit</button><span id="live"></span></header>
<div id="stage"><div id="world"><svg id="edges"></svg></div></div><div id="empty"></div>
<aside id="side"></aside><div id="lb" role="dialog"><img id="lbimg" alt=""><p id="lbtxt"></p></div>
<script>
const COLORS={prompt:"#6b7d8c",style:"#8a6bb0",list:"#5f8a6a",reference:"#7b6f5a",generate:"#2f6f5e",edit:"#3f6fa0",process:"#8a7a3a",gallery:"#a0603f",handoff:"#b04a6a",implementation:"#4a5ab0",note:"#b09a3a",canon:"#5a7f8f"};
let slug=__DEFAULT_GRAPH__||location.hash.slice(1)||null,data=null,lastSeq=0,sel=null,view={x:40,y:40,k:1},fitted=false;
const $=s=>document.querySelector(s),stage=$("#stage"),world=$("#world"),svg=$("#edges");
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const f=(p,thumb)=>(thumb?"/thumb":"/file")+"?g="+encodeURIComponent(slug)+"&p="+encodeURIComponent(p);
async function j(u){const r=await fetch(u);if(!r.ok)throw new Error((await r.json()).error||r.status);return r.json()}
function apply(){world.style.transform="translate("+view.x+"px,"+view.y+"px) scale("+view.k+")"}
const IMG=new Set(["reference","generate","edit","process","gallery","implementation","canon","finish"]);const cur={};
function nodeW(n){return IMG.has(n.type)?280:240}
function nodeH(n){return n.type==="note"?70:(n.outputs&&n.outputs.length&&n.outputs[0].kind!=="package"?36+260+33+62:110)}
function summary(n){const s=n.settings||{};switch(n.type){case"prompt":return s.text;case"list":return(s.items||[]).join(" | ");case"style":return[s.preset,s.shot&&Object.values(s.shot).join(", ")].filter(Boolean).join(" · ");
case"reference":return s.path;case"generate":return[s.prompt,"quality "+(s.quality||"low")].filter(Boolean).join(" · ");case"edit":return[s.instruction,"quality "+(s.quality||"low")].filter(Boolean).join(" · ");case"process":return s.op;case"handoff":return s.intent;case"implementation":return s.screenshot||"no screenshot";default:return""}}
function render(){
  world.querySelectorAll(".node,.note,.grp").forEach(e=>e.remove());
  if(!data){return}
  const byId=Object.fromEntries(data.nodes.map(n=>[n.id,n]));
  for(const g of data.groups){const m=data.nodes.filter(n=>n.group===g.id);if(!m.length)continue;
    const x0=Math.min(...m.map(n=>n.position.x))-16,y0=Math.min(...m.map(n=>n.position.y))-16,x1=Math.max(...m.map(n=>n.position.x+nodeW(n)))+16,y1=Math.max(...m.map(n=>n.position.y+nodeH(n)))+16;
    const d=document.createElement("div");d.className="grp";Object.assign(d.style,{left:x0+"px",top:y0+"px",width:(x1-x0)+"px",height:(y1-y0)+"px"});d.innerHTML="<b>"+esc(((g.label||g.id).toLowerCase()===g.stage.toLowerCase()?"":(g.label||g.id)+" · ")+g.stage)+"</b>";world.appendChild(d)}
  let paths="";
  for(const e of data.edges){const a=byId[e.from],b=byId[e.to];if(!a||!b)continue;const ins=data.edges.filter(x=>x.to===e.to);const i=ins.indexOf(e);
    const x1=a.position.x+nodeW(a),y1=a.position.y+20,x2=b.position.x,y2=b.position.y+20+i*14,c=Math.max(40,(x2-x1)/2);
    paths+='<path d="M'+x1+","+y1+" C"+(x1+c)+","+y1+" "+(x2-c)+","+y2+" "+x2+","+y2+'" fill="none" stroke="var(--edge)" stroke-width="1.6"/>'+'<circle cx="'+x2+'" cy="'+y2+'" r="3" fill="var(--edge)"/>'}
  for(const n of data.nodes){if(n.type!=="note")continue;const t=byId[n.settings.on];if(!t)continue;paths+='<path d="M'+(n.position.x+100)+","+(n.position.y+60)+" L"+(t.position.x+120)+","+t.position.y+'" stroke="#d8c15a" stroke-dasharray="4 4" fill="none"/>'}
  svg.innerHTML=paths;
  for(const n of data.nodes){const d=document.createElement("div");
    if(n.type==="note"){d.className="note"+(n.settings.resolved?" res":"");d.innerHTML="<i>"+esc((n.settings.author||"")+" on "+(n.settings.on||""))+"</i>"+esc(n.settings.text);}
    else{const outs=n.outputs||[];d.className="node"+(IMG.has(n.type)?" img":"")+(sel===n.id?" sel":"");
      const i=outs.length?Math.min(cur[n.id]||0,outs.length-1):0,o=outs[i];
      d.innerHTML='<div class="hd"><span class="ty" style="background:'+(COLORS[n.type]||"#777")+'">'+n.type+'</span><span class="id" title="'+esc(n.id)+'">'+esc(n.label||n.id)+'</span><span class="pill '+n.status+'">'+n.status+"</span></div>"+
      (o&&o.kind==="package"?'<div class="pk">Package '+esc(o.ref)+'<br><a href="'+f(o.asset)+'" target="_blank" onclick="event.stopPropagation()">handoff.md</a></div>':"")+
      (o&&o.kind!=="package"?'<div class="pv '+(o.verdict||"")+'"><img loading="lazy" src="'+f(o.asset,1)+'" alt="'+esc(o.ref)+'" title="'+esc(o.ref)+'">'+(o.verdict?'<span class="vd">'+o.verdict+"</span>":"")+"</div>"+
        '<div class="st">'+(outs.length>1?'<button data-d="-1" title="Previous output">&lsaquo;</button>':"")+'<span class="ref">'+esc(o.ref)+(outs.length>1?" · "+(i+1)+"/"+outs.length:"")+(n.takes.length>outs.length?" · "+n.takes.length+" takes":"")+"</span>"+(outs.length>1?'<button data-d="1" title="Next output">&rsaquo;</button>':"")+"</div>":"")+
      '<div class="tx">'+esc(summary(n)||"")+(n.issues.length?'<div class="issue">'+esc(n.issues[0].message)+"</div>":"")+"</div>";
      d.querySelectorAll(".st button").forEach(b=>b.onclick=ev=>{ev.stopPropagation();cur[n.id]=(i+Number(b.dataset.d)+outs.length)%outs.length;render()});
      const pv=d.querySelector(".pv img");if(pv)pv.ondblclick=ev=>{ev.stopPropagation();$("#lbimg").src=f(o.asset);$("#lbtxt").textContent=o.ref+(o.verdict?" · "+o.verdict:"");$("#lb").classList.add("open")};}
    Object.assign(d.style,{left:n.position.x+"px",top:n.position.y+"px"});d.onclick=ev=>{ev.stopPropagation();sel=n.id;render();side(n)};world.appendChild(d)}
  if(!fitted){fit();fitted=true}
}
function fit(){if(!data||!data.nodes.length)return;const xs=data.nodes.map(n=>n.position.x),ys=data.nodes.map(n=>n.position.y);const x0=Math.min(...xs)-40,y0=Math.min(...ys)-60,x1=Math.max(...xs)+320,y1=Math.max(...ys)+420;
  const w=stage.clientWidth,h=stage.clientHeight;view.k=Math.max(.2,Math.min(1.4,Math.min(w/(x1-x0),h/(y1-y0))));view.x=-x0*view.k+(w-(x1-x0)*view.k)/2;view.y=-y0*view.k+20;apply()}
function side(n){const a=$("#side");a.classList.add("open");const outRefs=new Set((n.outputs||[]).map(o=>o.ref));
  a.innerHTML='<button class="close" onclick="document.querySelector(\\'#side\\').classList.remove(\\'open\\')">Close</button><h2>'+esc(n.label||n.id)+"</h2><div>"+n.type+" · "+n.status+(n.upstreamStale.length?" · upstream out of date: "+esc(n.upstreamStale.join(", ")):"")+"</div>"+
  n.issues.map(i=>'<div class="issue">'+esc(i.message)+(i.fix?" Fix: "+esc(i.fix):"")+"</div>").join("")+(n.error?'<div class="issue">Failed: '+esc(n.error.message)+"</div>":"")+
  (n.takes.length?"<h3>Takes ("+n.takes.length+")</h3><div class=takes>"+n.takes.slice().reverse().map(t=>'<div class="take'+(outRefs.has(n.id+"/"+t.id)?" out":"")+'" data-t="'+t.id+'">'+(t.kind==="image"?'<img loading="lazy" src="'+f(t.asset,1)+'" alt="">':"<div>package</div>")+"<div>"+t.id+(t.verdict?' <span class="badge '+t.verdict.decision+'">'+t.verdict.decision+"</span>":"")+(t.selected?" · pinned":"")+"</div></div>").join("")+"</div>":"")+
  (n.picks.length?"<p>Picks: "+esc(n.picks.join(", "))+"</p>":"")+"<h3>Settings</h3><pre>"+esc(JSON.stringify(n.settings,null,2))+"</pre>";
  a.querySelectorAll(".take").forEach(el=>el.onclick=()=>{const t=n.takes.find(x=>x.id===el.dataset.t);if(!t)return;if(t.kind!=="image"){window.open(f(t.asset),"_blank");return}
    $("#lbimg").src=f(t.asset);$("#lbtxt").textContent=n.id+"/"+t.id+(t.width?" · "+t.width+"x"+t.height:"")+(t.verdict?" · "+t.verdict.decision+" by "+t.verdict.by:"")+(t.prompt?"\\n"+t.prompt:"")+(t.compiledPrompt?"\\n\\nCompiled: "+t.compiledPrompt:"");$("#lb").classList.add("open")})}
$("#lb").onclick=()=>$("#lb").classList.remove("open");
document.addEventListener("keydown",e=>{if(e.key==="Escape"){$("#lb").classList.remove("open");$("#side").classList.remove("open")}});
let drag=null;stage.addEventListener("pointerdown",e=>{if(e.target.closest(".node,.note"))return;drag={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y};stage.classList.add("drag");stage.setPointerCapture(e.pointerId)});
stage.addEventListener("pointermove",e=>{if(!drag)return;view.x=drag.vx+e.clientX-drag.x;view.y=drag.vy+e.clientY-drag.y;apply()});
stage.addEventListener("pointerup",()=>{drag=null;stage.classList.remove("drag")});
stage.addEventListener("wheel",e=>{e.preventDefault();const r=stage.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top,k=Math.max(.15,Math.min(3,view.k*Math.exp(-e.deltaY*.0015)));view.x=mx-(mx-view.x)*k/view.k;view.y=my-(my-view.y)*k/view.k;view.k=k;apply()},{passive:false});
stage.addEventListener("click",()=>{sel=null;render()});
$("#fit").onclick=fit;
async function load(){if(!slug)return;data=await j("/api/graph?g="+encodeURIComponent(slug));lastSeq=data.lastSeq;render();status();if(sel){const n=data.nodes.find(x=>x.id===sel);if(n&&$("#side").classList.contains("open"))side(n)}}
function status(){const r=data.run;$("#live").textContent=data.name+" · rev "+data.revision+(r?" · run "+r.id+" "+r.status+" "+r.progress.slotsDone+"/"+r.planned.slots:"")}
async function poll(){try{if(slug){const e=await j("/api/events?g="+encodeURIComponent(slug)+"&after="+lastSeq);if(e.events.length){const last=e.events[e.events.length-1];await load();$("#live").textContent+=" · "+last.type+(last.node?" "+last.node:"")}}}catch(err){$("#live").textContent="viewer: "+err.message}setTimeout(poll,1500)}
async function init(){const r=await j("/api/graphs");const p=$("#pick");p.innerHTML=r.graphs.map(g=>'<option value="'+esc(g.slug)+'">'+esc(g.name||g.slug)+"</option>").join("");
  if(!r.graphs.length){$("#empty").textContent="No Studio graphs in "+r.project;return}if(!slug||!r.graphs.some(g=>g.slug===slug))slug=r.graphs[0].slug;p.value=slug;
  p.onchange=()=>{slug=p.value;location.hash=slug;fitted=false;sel=null;$("#side").classList.remove("open");load()};await load();poll()}
init().catch(e=>{$("#empty").textContent="Viewer error: "+e.message});apply();
</script></body></html>`;
