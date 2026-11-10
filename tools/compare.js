// Итоговое сравнение: node tools/compare.js <simple|sheet|relay> N=6,P=0.5,gap=45
// Печатает: конфиг, стратегия, медиана схождения (с), не сошлось (%), неверное N перед следующим событием (%), дискомфорт/чел.
// «Неверное N» проверяется у каждого человека прямо перед каждым следующим событием и в конце.
const S=require('../sim.js');
const [st,cfgS]=process.argv.slice(2); const cfg=Object.fromEntries(cfgS.split(",").map(x=>{const [k,v]=x.split("=");return [k,+v];})); const SEEDS=100;
let checks=0,bad=0,ev=0,nc=0,set=[],disc=0;
for(let seed=1;seed<=SEEDS;seed++){const r=S.simulate(Object.assign({seed,strategy:st},cfg));
  if(st!=='simple'){const ts=r.events.map(e=>e.t).concat([r.T_END]);
  for(let i=1;i<ts.length;i++){if(ts[i]-ts[i-1]<20)continue;const k=Math.round(ts[i]/r.dt)-2;
    for(const a of r.agents){if(a.felt[k]==null)continue;checks++;if(a.belief[k]!==r.nTrue[k])bad++;}}}
  for(const e of r.events){if(e.mergedWithNext)continue;ev++;if(e.converged)set.push(e.settle);else nc++;}
  disc+=r.discomfort/(cfg.N||3);}
set.sort((a,b)=>a-b);
console.log([cfgS,st,set.length?set[set.length>>1].toFixed(0):'—',(100*nc/ev).toFixed(0),st==='simple'?'':(100*bad/Math.max(1,checks)).toFixed(1),(disc/SEEDS).toFixed(0)].join('\t'));
