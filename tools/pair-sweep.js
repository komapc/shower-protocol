const S=require('../sim.js');
for (const N of [2,3,4]) for (const P of [0.5,3]) for (const d of [0,1,2,4,8]) {
  let rec=0,col=0,acc=0,jam=0,def=0,silent=0,wrong=0,settle=[],nc=0,disc=0; const R=40;
  for (let seed=1;seed<=R;seed++){
    const r=S.simulate({strategy:'relay',N,P,pairGap:d,seed});
    const evs=r.events.filter(e=>e.kind==='entry');
    const last=evs[evs.length-1];
    if(evs.some(e=>e.collided))col++;
    if(evs.some(e=>e.mergeAccepted))acc++;
    if(evs.some(e=>e.jammed))jam++;
    if(evs.some(e=>e.deferred))def++;
    if(r.rolls.some(x=>x.silentCollision))silent++; if(r.rolls.some(x=>x.kind==="recount"))rec=(rec||0)+1;
    if(r.wrongByGap>0)wrong++; // к плановому выходу
    if(last.settle!=null)settle.push(last.settle);else nc++;
    disc+=r.discomfort;
  }
  settle.sort((a,b)=>a-b);
  console.log(`N=${N} P=${P} Δ=${d}: коллизий ${col}/${R}, двойных синхро узнано ${acc}, стоп-сигналов ${jam}, отложил ${def}, тихих коллизий ${silent}, пересчётов ${rec}, неверное N к плановому выходу ${wrong}, схождение медиана ${settle.length?settle[settle.length>>1].toFixed(1):'-'} с, не сошлось ${nc}, дискомфорт ${(disc/R).toFixed(0)}`);
}
