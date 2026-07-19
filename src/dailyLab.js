/** Daily-timeframe walk-forward: 18y stocks, 8y crypto, same families. */
const YF = require('yahoo-finance2').default;
const yf = new YF({ suppressNotices: ['yahooSurvey'] });

const START_EQ = 100_000, RISK_PCT = 0.01, COST = 0.0005, WARMUP = 250;
const STOCKS = ['NVDA','AMD','TSLA','MSFT','META','AAPL','AMZN','GOOGL','AVGO'];
const CRYPTO = ['BTC-USD','ETH-USD','SOL-USD','AVAX-USD','DOGE-USD','LINK-USD'];

async function fetchD(sym, years) {
  const end = new Date(), start = new Date(end.getTime() - years*365*24*3600*1000);
  const r = await yf.chart(sym, { period1: start, period2: end, interval: '1d' });
  return r.quotes.filter(x=>x.close!=null&&x.high!=null&&x.low!=null)
    .map(x=>({t:x.date.toISOString(),o:x.open,h:x.high,l:x.low,c:x.close}));
}
function atrArr(b,p){const t=[b[0].h-b[0].l];for(let i=1;i<b.length;i++)t.push(Math.max(b[i].h-b[i].l,Math.abs(b[i].h-b[i-1].c),Math.abs(b[i].l-b[i-1].c)));const a=new Array(b.length).fill(0);let s=0;for(let i=0;i<p;i++)s+=t[i];a[p-1]=s/p;for(let i=p;i<b.length;i++)a[i]=(a[i-1]*(p-1)+t[i])/p;return a;}
function emaArr(b,p){const k=2/(p+1),e=new Array(b.length).fill(0);e[0]=b[0].c;for(let i=1;i<b.length;i++)e[i]=b[i].c*k+e[i-1]*(1-k);return e;}
function utArr(b,atr,kv){const r=[];let d=1;for(let i=0;i<b.length;i++){const src=b[i].c,nL=kv*(atr[i]>0?atr[i]:b[i].h-b[i].l);let nt;if(i===0)nt=src-nL;else{const pt=r[i-1].ts,ps=b[i-1].c;if(src>pt&&ps>pt)nt=Math.max(pt,src-nL);else if(src<pt&&ps<pt)nt=Math.min(pt,src+nL);else if(src>pt)nt=src-nL;else nt=src+nL;}if(i>0){const ps=b[i-1].c,pt=r[i-1].ts;if(ps<=pt&&src>nt)d=1;else if(ps>=pt&&src<nt)d=-1;else d=r[i-1].dir;}r.push({dir:d,ts:nt});}return r;}
function rollMax(b,n,f){const o=new Array(b.length);for(let i=0;i<b.length;i++){let m=-Infinity;for(let j=Math.max(0,i-n+1);j<=i;j++)m=Math.max(m,f(b[j]));o[i]=m;}return o;}
function rollMin(b,n,f){const o=new Array(b.length);for(let i=0;i<b.length;i++){let m=Infinity;for(let j=Math.max(0,i-n+1);j<=i;j++)m=Math.min(m,f(b[j]));o[i]=m;}return o;}

function buildSig(d, strat, cfg) {
  const n=d.bars.length;
  const s={long:new Array(n).fill(false),short:new Array(n).fill(false),exitLong:new Array(n).fill(false),exitShort:new Array(n).fill(false),stop:new Array(n).fill(0)};
  const e100=d.ema100;
  if(strat==='UT'){
    const atr=atrArr(d.bars,cfg.atrP), ut=utArr(d.bars,atr,cfg.kv);
    for(let i=1;i<n;i++){const bull=ut[i-1].dir===-1&&ut[i].dir===1,bear=ut[i-1].dir===1&&ut[i].dir===-1,ab=d.bars[i].c>e100[i];
      s.long[i]=bull&&ab;s.short[i]=bear&&!ab;s.exitLong[i]=bear;s.exitShort[i]=bull;s.stop[i]=cfg.kv*atr[i];}
  } else if(strat==='DONCH'){
    const atr=atrArr(d.bars,20),hi=rollMax(d.bars,cfg.entryN,b=>b.h),lo=rollMin(d.bars,cfg.entryN,b=>b.l),xh=rollMax(d.bars,cfg.exitN,b=>b.h),xl=rollMin(d.bars,cfg.exitN,b=>b.l);
    for(let i=1;i<n;i++){const ab=d.bars[i].c>e100[i];
      s.long[i]=d.bars[i].c>hi[i-1]&&ab;s.short[i]=d.bars[i].c<lo[i-1]&&!ab;s.exitLong[i]=d.bars[i].c<xl[i-1];s.exitShort[i]=d.bars[i].c>xh[i-1];s.stop[i]=2*atr[i];}
  } else if(strat==='EMAX'){
    const atr=atrArr(d.bars,14),ef=emaArr(d.bars,cfg.fast),es=emaArr(d.bars,cfg.slow);
    for(let i=1;i<n;i++){const up=ef[i-1]<=es[i-1]&&ef[i]>es[i],dn=ef[i-1]>=es[i-1]&&ef[i]<es[i],ab=d.bars[i].c>e100[i];
      s.long[i]=up&&ab;s.short[i]=dn&&!ab;s.exitLong[i]=dn;s.exitShort[i]=up;s.stop[i]=3*atr[i];}
  }
  return s;
}

function sim(ds, allowShorts, f0, f1) {
  const tsSet=new Set();for(const d of ds)for(const b of d.bars)tsSet.add(b.t);
  const tl=[...tsSet].sort();
  const t0=tl[Math.floor(tl.length*f0)], t1=tl[Math.min(tl.length-1,Math.floor(tl.length*f1))];
  let eq=START_EQ,peak=START_EQ,dd=0;const pos={},tr=[],mo={};
  const close=(sym,p,x,ts)=>{const g=p.side==='long'?(x-p.entry)*p.qty:(p.entry-x)*p.qty;const pnl=g-(p.entry+x)*p.qty*COST;eq+=pnl;tr.push(pnl);mo[ts.slice(0,7)]=(mo[ts.slice(0,7)]??0)+pnl;peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/peak);delete pos[sym];};
  for(const ts of tl){
    if(ts<t0)continue;if(ts>t1)break;
    for(const d of ds){
      const i=d.map.get(ts);if(i===undefined||i<WARMUP||i>=d.bars.length-1)continue;
      const s=d.sig,pr=d.bars[i].c,lo=d.bars[i].l,hi=d.bars[i].h,p=pos[d.sym];
      if(p){if(p.side==='long'){const sh=lo<=p.sl;if(sh||s.exitLong[i])close(d.sym,p,sh?p.sl:pr,ts);}else{const sh=hi>=p.sl;if(sh||s.exitShort[i])close(d.sym,p,sh?p.sl:pr,ts);}continue;}
      const sd=s.stop[i];if(sd<=0)continue;
      const q=Math.min((eq*RISK_PCT)/sd,(eq*0.25)/pr);if(q<=0)continue;
      if(s.long[i])pos[d.sym]={side:'long',entry:pr,qty:q,sl:pr-sd};
      else if(allowShorts&&s.short[i])pos[d.sym]={side:'short',entry:pr,qty:q,sl:pr+sd};
    }
  }
  for(const[sym,p]of Object.entries({...pos})){const d=ds.find(x=>x.sym===sym);close(sym,p,d.bars[d.bars.length-1].c,d.bars[d.bars.length-1].t);}
  const w=tr.filter(p=>p>0),gw=w.reduce((a,b)=>a+b,0),gl=tr.filter(p=>p<=0).reduce((a,b)=>a-b,0);
  const ms=Object.values(mo);
  return{ret:(eq/START_EQ-1)*100,dd:dd*100,pf:gl>0?gw/gl:(gw>0?Infinity:0),n:tr.length,wr:tr.length?w.length/tr.length*100:0,
    nMo:ms.length,posMo:ms.filter(m=>m>0).length,avgMo:ms.length?ms.reduce((a,b)=>a+b,0)/ms.length:0};
}

const GRIDS={UT:[{kv:2,atrP:10},{kv:3,atrP:10},{kv:3,atrP:20},{kv:4,atrP:20}],
  DONCH:[{entryN:20,exitN:10},{entryN:55,exitN:20},{entryN:100,exitN:50}],
  EMAX:[{fast:20,slow:50},{fast:50,slow:100},{fast:50,slow:200}]};

(async()=>{
  const prep=async(syms,years)=>{const o=[];for(const s of syms){try{const b=await fetchD(s,years);if(b.length<WARMUP+200){console.log(`  ${s}: ${b.length} — skip`);continue;}o.push({sym:s,bars:b,ema100:emaArr(b,100),map:new Map(b.map((x,i)=>[x.t,i]))});console.log(`  ${s}: ${b.length} days (${b[0].t.slice(0,10)}→)`);}catch(e){console.log(`  ${s}: ERR ${e.message}`);}}return o;};
  console.log('DAILY bars — stocks 18y, crypto 8y:');
  const sd=await prep(STOCKS,18), cd=await prep(CRYPTO,8);
  const run=(lbl,ds,shorts)=>{
    console.log(`\n╔═══ ${lbl} — walk-forward TRAIN 60% / TEST 40% ═══`);
    let champ=null;
    for(const[st,grid]of Object.entries(GRIDS)){
      let best=null;
      for(const cfg of grid){for(const d of ds)d.sig=buildSig(d,st,cfg);
        const tr=sim(ds,shorts,0,0.6);const sc=tr.ret/Math.max(tr.dd,1);
        if(!best||sc>best.sc)best={cfg,sc,tr};}
      for(const d of ds)d.sig=buildSig(d,st,best.cfg);
      const te=sim(ds,shorts,0.6,1.0);
      console.log(`║ ${st.padEnd(6)}${JSON.stringify(best.cfg)}`);
      console.log(`║   TRAIN ${best.tr.ret.toFixed(0).padStart(5)}% /${best.tr.dd.toFixed(0).padStart(3)}%DD PF${best.tr.pf.toFixed(2)} | TEST ${te.ret.toFixed(1).padStart(6)}% /${te.dd.toFixed(1).padStart(5)}%DD PF${te.pf.toFixed(2)} ${te.n}tr ${te.posMo}/${te.nMo}+mo avg$${te.avgMo.toFixed(0)}`);
      if(!champ||te.ret/Math.max(te.dd,1)>champ.te.ret/Math.max(champ.te.dd,1))champ={st,cfg:best.cfg,te};
    }
    console.log(`╚═ TEST champion: ${champ.st} ${JSON.stringify(champ.cfg)} → ${champ.te.ret.toFixed(1)}%/${champ.te.dd.toFixed(1)}%DD, avg mo $${champ.te.avgMo.toFixed(0)}`);
    return champ;
  };
  const sc=run('STOCKS daily 18y (test ≈ last 7y)',sd,true);
  const cc=run('CRYPTO daily 8y (test ≈ last 3y)',cd,false);
  for(const[l,ch]of[['Stocks',sc],['Crypto',cc]]){
    const t=ch.te;const mo=t.nMo?(Math.pow(1+t.ret/100,1/t.nMo)-1)*100:0;
    console.log(`\n${l}: ${mo.toFixed(2)}%/mo compounded on TEST, ${t.dd.toFixed(1)}% maxDD`);
    if(mo>0)console.log(`  $10k/mo needs ~$${Math.round(10000/(mo/100)).toLocaleString()} at full risk; scaled to 5%DD: ×${Math.min(1,5/Math.max(t.dd,0.1)).toFixed(2)} → ~$${Math.round(10000/((mo*Math.min(1,5/Math.max(t.dd,0.1)))/100)).toLocaleString()}`);
  }
})();
