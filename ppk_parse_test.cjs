const XLSX = require("xlsx");
const fs = require("fs");
const buf = fs.readFileSync("C:/tmp/ppk_sample.csv");
const wb = XLSX.read(buf, { type: "buffer" });
const ws = wb.Sheets[wb.SheetNames[0]];
const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
const FIXED = new Set(["ppk style code","matrix name","name","pack token","pack_token","pack","carton total","pack total","size","inner pack qty","qty per box","qty per pack","quantity","qty","(sizes...)"]);
const norm=(v)=>String(v==null?"":v).trim(), lc=(v)=>norm(v).toLowerCase();
const byStyle=new Map(); let cols=null;
const getM=(s,n,p)=>{const k=s.toLowerCase();let m=byStyle.get(k);if(!m){m={ppk_style_code:s,name:n||s,pack_token:p||null,sizes:[]};byStyle.set(k,m);}return m;};
aoa.forEach((row)=>{row=Array.isArray(row)?row:[];
  if(norm(row[0]).startsWith("#"))return; if(row.every(c=>norm(c)===""))return;
  if(lc(row[0])==="ppk style code"){const f=(ns)=>row.findIndex(c=>ns.includes(lc(c)));const sc=[];row.forEach((c,idx)=>{const nm=norm(c);if(nm&&!FIXED.has(lc(c)))sc.push({idx,size:nm});});
    cols={ppk:f(["ppk style code"]),name:f(["matrix name","name"]),pack:f(["pack token","pack_token","pack"]),size:f(["size"]),sizeCols:sc};return;}
  if(!cols||cols.ppk<0)return; const style=norm(row[cols.ppk]); if(!style)return;
  const m=getM(style,cols.name>=0?norm(row[cols.name]):"",cols.pack>=0?norm(row[cols.pack]):"");
  for(const sc of cols.sizeCols){const raw=norm(row[sc.idx]);if(raw==="")continue;const box=parseInt(raw,10);if(box>0)m.sizes.push({size:sc.size,qty_per_pack:box});}
});
for(const m of byStyle.values()){const tot=m.sizes.reduce((a,s)=>a+s.qty_per_pack,0);console.log(`${m.ppk_style_code} [${m.pack_token}] ${m.sizes.map(s=>s.size+":"+s.qty_per_pack).join(",")} = carton ${tot}`);}
