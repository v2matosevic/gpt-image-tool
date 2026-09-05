// Deterministic editorial layouts around real generated samples. No network or generation.
import sharp from 'sharp';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const out = 'docs/launch';
await mkdir(out, { recursive: true });
const ink = '#222421', muted = '#64645d', paper = '#f5f1e8', orange = '#dc552d';
const esc = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = (x,y,size,s,color=ink,weight=400) => `<text x="${x}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${esc(s)}</text>`;
const rect = (x,y,w,h,fill,rx=0) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" rx="${rx}"/>`;
const line = (x1,y1,x2,y2) => `<path d="M${x1} ${y1}H${x2}" stroke="#d4cec1"/>`;
const svg = (w,h,body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${rect(0,0,w,h,paper)}${body}</svg>`);
const image = async (path,w,h) => sharp(path).resize(w,h,{fit:'contain',background:paper}).png().toBuffer();
async function render(path,w,h,body,images=[]) {
  await sharp(svg(w,h,body)).composite(await Promise.all(images.map(async i => ({input:await image(i.path,i.w,i.h),left:i.x,top:i.y})))).png({palette:true,colours:256,effort:8}).toFile(path);
}
const sculpture='docs/assets/paper-sculpture.png';
const fox='docs/assets/fox-mascot.png';
await render('docs/assets/github-banner.png',1280,640,
  text(62,72,25,'gpt-image-tool',ink,700)+text(62,156,15,'OPEN SOURCE  /  MCP + CLI',orange,700)+
  text(58,240,66,'Give your coding',ink,700)+text(58,315,66,'agent an',ink,700)+text(58,390,66,'image tool.',orange,700)+
  text(62,465,22,'Generate. Edit. Export. Stay in your project.',muted)+line(62,522,1218,522)+
  text(62,572,18,'Claude Code · Cursor · Codex · local MCP clients',ink)+text(965,572,16,'MIT LICENSE',muted),
  [{path:sculpture,w:470,h:470,x:758,y:35}]);
await render('docs/assets/workflow.png',1600,920,
  text(60,72,30,'From an idea to a file your agent can use.',ink,700)+
  text(60,118,20,'Actual gpt-image-tool output. Request panel is an explanatory example.',muted)+
  rect(60,172,675,620,ink,16)+text(96,224,16,'01 / REQUEST', '#f09470',700)+
  text(96,298,25,'Make a folded orange paper sculpture.','#f5f1e8')+
  text(96,340,25,'Use product-studio. Save it as hero.png.','#f5f1e8')+
  text(96,440,18,'generate_image({','#b9c8b9')+text(120,478,18,'subject: "a folded paper sculpture",','#d9dfd4')+
  text(120,516,18,'preset: "product-studio",','#d9dfd4')+text(120,554,18,'output_path: "/project/public/hero.png"','#d9dfd4')+
  text(96,592,18,'})','#b9c8b9')+text(96,715,20,'02 / INSPECT THE SAVED IMAGE','#f09470',700)+
  text(835,224,16,'03 / USE IT IN YOUR APP',orange,700)+
  text(835,767,19,'public/hero.png',ink,700)+text(60,860,20,'Image generation uses your account. File export runs locally.',muted),
  [{path:sculpture,w:530,h:490,x:850,y:250}]);
await render(`${out}/x-landscape.png`,1600,900,
  text(72,88,28,'gpt-image-tool',ink,700)+text(72,180,17,'FOR THE AGENT ALREADY WRITING YOUR CODE',orange,700)+
  text(66,290,88,'Your next image,',ink,700)+text(66,390,88,'one tool call',ink,700)+text(66,490,88,'away.',orange,700)+
  text(72,602,28,'Generate images. Save them into your project.',muted)+text(72,656,23,'MCP server + CLI · 70 presets · MIT',ink)+
  line(72,745,1528,745)+text(72,809,25,'github.com/v2matosevic/gpt-image-tool',ink,700),
  [{path:sculpture,w:550,h:550,x:980,y:140}]);
await render(`${out}/linkedin-portrait.png`,1080,1350,
  text(64,82,28,'gpt-image-tool',ink,700)+text(64,156,17,'OPEN SOURCE / MCP + CLI',orange,700)+
  text(58,257,80,'Give your coding',ink,700)+text(58,350,80,'agent an',ink,700)+text(58,443,80,'image tool.',orange,700)+
  text(64,1105,27,'Generate. Edit. Export.',ink,700)+text(64,1153,24,'Claude Code · Cursor · Codex',muted)+
  line(64,1200,1016,1200)+text(64,1264,23,'github.com/v2matosevic/gpt-image-tool',ink),
  [{path:sculpture,w:690,h:560,x:196,y:500}]);
await render(`${out}/story.png`,1080,1920,
  text(80,228,28,'gpt-image-tool',ink,700)+text(80,306,18,'IMAGES INSIDE YOUR CODING WORKFLOW',orange,700)+
  text(74,446,88,'Code needs',ink,700)+text(74,551,88,'images too.',orange,700)+
  text(80,1390,32,'Generate. Edit. Export.',ink,700)+text(80,1450,26,'A local MCP server for your coding agent.',muted)+
  text(80,1552,25,'MIT licensed. Subscription access is experimental.',muted)+
  text(80,1660,24,'github.com/v2matosevic/gpt-image-tool',ink,700),
  [{path:sculpture,w:920,h:650,x:80,y:640}]);
const slides=[
  ['01 / THE IDEA','Your agent writes code.','Now give it images.','Connect gpt-image-tool over local MCP.',sculpture],
  ['02 / THE OUTPUT','Assets that land','in your project.','Hero art, mascots, edits, and local web exports.',fox],
  ['03 / THE FIRST CALL','Pick a preset.','Make one image.','Inspect the file. Then use it in your app.',sculpture],
];
for(let i=0;i<slides.length;i++) {
  const [label,a,b,c,img]=slides[i];
  await render(`${out}/carousel-${i+1}.png`,1080,1350,
    text(64,82,26,'gpt-image-tool',ink,700)+text(64,160,17,label,orange,700)+
    text(60,270,66,a,ink,700)+text(60,350,66,b,orange,700)+
    text(64,1100,24,c,ink)+text(64,1160,22,'MIT · Local MCP + CLI · Experimental subscription backend',muted)+
    line(64,1210,1016,1210)+text(64,1270,23,'github.com/v2matosevic/gpt-image-tool',ink),
    [{path:img,w:780,h:620,x:150,y:415}]);
}
const files=['docs/assets/github-banner.png','docs/assets/workflow.png',`${out}/x-landscape.png`,`${out}/linkedin-portrait.png`,`${out}/story.png`,...slides.map((_,i)=>`${out}/carousel-${i+1}.png`)];
const thumbs=await Promise.all(files.map(async(path,i)=>({input:await sharp(path).resize(400,500,{fit:'contain',background:'#e6e0d4'}).png().toBuffer(),left:(i%4)*400,top:Math.floor(i/4)*500})));
await sharp({create:{width:1600,height:1000,channels:3,background:'#e6e0d4'}}).composite(thumbs).png().toFile(`${out}/contact-sheet.png`);
for(const path of files){const m=await sharp(path).metadata();console.log(`${path}: ${m.width}x${m.height}, ${(await readFile(path)).length} bytes`);}
await writeFile(`${out}/alt-text.json`,JSON.stringify({
  'x-landscape.png':'Give your coding agent an image tool. An orange folded-paper sculpture beside the gpt-image-tool name and GitHub address.',
  'linkedin-portrait.png':'Give your coding agent an image tool. Generate, edit, and export with gpt-image-tool for Claude Code, Cursor, and Codex. Orange paper sculpture below the headline.',
  'story.png':'Code needs images too. gpt-image-tool is a local MCP server for coding agents, with an orange paper sculpture and a link to its GitHub repository.',
  'carousel-1.png':'Your agent writes code. Now give it images. Connect gpt-image-tool over local MCP. Orange paper sculpture.',
  'carousel-2.png':'Assets that land in your project. Hero art, mascots, edits, and local web exports. A generated orange paper fox mascot.',
  'carousel-3.png':'Pick a preset. Make one image. Inspect the file, then use it in your app. gpt-image-tool is MIT licensed with experimental subscription access.'
},null,2)+'\n');
