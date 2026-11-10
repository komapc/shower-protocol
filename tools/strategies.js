const S=require('../sim.js');
for (const cfg of [{},{N:5},{P:3},{P:3,adaptive:false},{L:8},{N:1}]) {
  console.log('== cfg',JSON.stringify(cfg));
  for (const st of ['naive','patient','simple','relay']) {
    const r=S.simulate(Object.assign({strategy:st},cfg));
    console.log(st.padEnd(8), 'disc', r.discomfort.toFixed(0).padStart(5), r.events.map(e=>`${e.kind[0]}${e.who}@${e.t.toFixed(0)}:${e.settle==null?'—':e.settle.toFixed(1)}${e.detected!=null?` [${e.detected}/${e.expected}]`:''}`).join('  '));
  }
}
