/* Harness validation: does the IC plumbing report signs correctly?
   Test 1: forward return vs itself          -> must be +1.00
   Test 2: NEGATIVE forward return vs itself -> must be -1.00
   Test 3: past 5d return vs forward 5d      -> independent read on whether
           this universe/period was mean-reverting, with no composite involved. */
const rank=a=>{const idx=a.map((v,i)=>[v,i]).sort((x,y)=>x[0]-y[0]);const r=new Array(a.length);let i=0;
 while(i<idx.length){let j=i;while(j+1<idx.length&&idx[j+1][0]===idx[i][0])j++;const av=(i+j)/2+1;
 for(let k=i;k<=j;k++)r[idx[k][1]]=av;i=j+1;}return r;};
const spearman=(x,y)=>{const n=x.length;if(n<3)return NaN;const rx=rank(x),ry=rank(y);
 const mx=rx.reduce((a,b)=>a+b,0)/n,my=ry.reduce((a,b)=>a+b,0)/n;let nu=0,dx=0,dy=0;
 for(let i=0;i<n;i++){const a=rx[i]-mx,b=ry[i]-my;nu+=a*b;dx+=a*a;dy+=b*b;}
 return dx===0||dy===0?NaN:nu/Math.sqrt(dx*dy);};
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
const std=a=>{const m=mean(a);return Math.sqrt(a.reduce((x,y)=>x+(y-m)**2,0)/(a.length-1));};

async function fetchDaily(s,years){const p2=Math.floor(Date.now()/1e3),p1=p2-Math.round(years*365.25*86400);
 try{const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${s}.NS?interval=1d&period1=${p1}&period2=${p2}`,
  {headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(20000)});
  if(!r.ok)return null;const j=await r.json();const q=j?.chart?.result?.[0];if(!q?.timestamp)return null;
  const o=q.indicators.quote[0];const out=[];
  for(let i=0;i<q.timestamp.length;i++){const c=o.close[i];if(c==null||!(c>0))continue;
   out.push({t:new Date(q.timestamp[i]*1e3).toISOString().slice(0,10),c});}
  return out.length>120?out:null;}catch{return null;}}

const {default:uni}=await import('../../engine/data/nse_universe.json',{with:{type:'json'}});
const syms=uni.filter(u=>u.cap==='large').slice(0,80).map(u=>u.symbol);
const data={};
for(let i=0;i<syms.length;i+=8){
 const b=await Promise.all(syms.slice(i,i+8).map(async s=>[s,await fetchDaily(s,3)]));
 for(const [s,v] of b) if(v) data[s]=v;}
console.log('symbols:',Object.keys(data).length);

const byDate=new Map();
for(const [s,bars] of Object.entries(data)){
 for(let i=30;i<bars.length-20;i++){
  const past5=bars[i].c/bars[i-5].c-1;
  const fwd5=bars[i+5].c/bars[i].c-1;
  if(!byDate.has(bars[i].t))byDate.set(bars[i].t,[]);
  byDate.get(bars[i].t).push({past5,fwd5});}}

const t1=[],t2=[],t3=[];
for(const [,rows] of byDate){ if(rows.length<10)continue;
 const f=rows.map(r=>r.fwd5);
 const a=spearman(f,f); if(isFinite(a))t1.push(a);
 const b=spearman(f.map(v=>-v),f); if(isFinite(b))t2.push(b);
 const c=spearman(rows.map(r=>r.past5),f); if(isFinite(c))t3.push(c);}

const rep=(n,a)=>{const m=mean(a),s=std(a);console.log(`  ${n.padEnd(46)} ${m.toFixed(4).padStart(8)}  t=${(m/(s/Math.sqrt(a.length))).toFixed(2).padStart(7)}`);};
console.log('\n  test                                             mean IC     t-stat');
rep('1. forward vs itself (must be +1.0000)',t1);
rep('2. negated forward vs itself (must be -1.0000)',t2);
rep('3. past 5d return vs forward 5d return',t3);
