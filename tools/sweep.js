// Быстрые пакетные прогоны без GUI: node tools/sweep.js [имя-набора] [сидов]
const S = require('../sim.js');
const which = process.argv[2] || 'all', SEEDS = +(process.argv[3] || 100);

function run(cfg) {
  const settles = []; let ev = 0, nc = 0, wrong = 0, disc = 0, merged = 0, jams = 0, recs = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = S.simulate(Object.assign({ seed }, cfg));
    for (const e of r.events) { if (e.mergedWithNext) continue; ev++; if (e.converged) settles.push(e.settle); else nc++; }
    if (r.wrongBelief > 0) wrong++;
    disc += r.discomfort / Math.max(1, cfg.N || 3);
    if (r.rolls.some(x => x.initiators && x.initiators.length > 1)) merged++;
    jams += r.rolls.filter(x => x.kind === 'jam').length; recs += r.rolls.filter(x => x.kind === 'recount').length;
  }
  settles.sort((a, b) => a - b);
  const q = f => settles.length ? settles[Math.min(settles.length - 1, Math.floor(f * settles.length))] : NaN;
  return { med: q(0.5), p90: q(0.9), nc: nc / ev, wrong: wrong / SEEDS, disc: disc / SEEDS, merged: merged / SEEDS, jams: jams / SEEDS, recs: recs / SEEDS };
}
const pct = x => (100 * x).toFixed(0).padStart(3) + '%';
const sec = x => (isNaN(x) ? '   —' : x.toFixed(1).padStart(5));
function row(label, cfg) {
  const m = run(cfg);
  console.log(label.padEnd(34), 'медиана', sec(m.med), ' p90', sec(m.p90), ' не сошлось', pct(m.nc),
    cfg.strategy === 'relay' || !cfg.strategy ? ` неверное N ${pct(m.wrong)} слияний ${pct(m.merged)} стоп ${m.jams.toFixed(2)} пересч ${m.recs.toFixed(2)}` : '',
    ' дискомфорт/чел', m.disc.toFixed(0).padStart(4));
}
const sets = {
  strategies() { // стратегии × N × P
    for (const P of [0, 0.5, 1, 2, 3]) { console.log(`\n— P = ${P} с, L = 5 —`);
      for (const N of [1, 2, 3, 4, 5, 6]) for (const st of ['naive', 'patient', 'relay']) row(`N=${N} ${st}`, { N, P, strategy: st }); }
  },
  latency() { // эстафета: задержка температуры × ошибка таблички
    for (const L of [2, 5, 8, 12]) { console.log(`\n— L = ${L} с, N = 3, P = 0.5 —`);
      for (const tableErr of [0, 0.03, 0.06, 0.1, 0.15, 0.25]) for (const st of ['patient', 'relay']) row(`err ±${(tableErr * 100).toFixed(0)}% ${st}`, { N: 3, P: 0.5, L, tableErr, strategy: st }); }
  },
  gap() { // сколько времени между событиями нужно при медленном напоре
    for (const P of [0.5, 1, 2, 3]) { console.log(`\n— P = ${P} с, N = 4, relay —`);
      for (const gap of [20, 30, 45, 60, 90, 120]) row(`gap ${gap} с`, { N: 4, P, gap, strategy: 'relay' }); }
  },
  ablation() { // что даёт каждая часть эстафеты
    for (const P of [0.5, 2]) { console.log(`\n— P = ${P} с, N = 4 —`);
      row('relay (всё включено)', { N: 4, P, strategy: 'relay' });
      row('без адаптивного темпа', { N: 4, P, strategy: 'relay', adaptive: false });
      row('без раннего прыжка', { N: 4, P, strategy: 'relay', earlyJump: false });
      row('без обоих', { N: 4, P, strategy: 'relay', adaptive: false, earlyJump: false });
      row('patient', { N: 4, P, strategy: 'patient' }); }
  },
  tempo() { // какой темп мыргов нужен: T = max(0.5, tK·P)
    for (const P of [1, 2, 3, 4]) { console.log(`\n— P = ${P} с, N = 4, relay —`);
      for (const tK of [0.1, 0.17, 0.25, 0.33, 0.4, 0.5, 0.6, 0.8]) row(`tK=${tK} (T=${Math.max(0.5, tK * P).toFixed(2)} с)`, { N: 4, P, tK, strategy: 'relay' });
      row('patient', { N: 4, P, strategy: 'patient' }); }
  },
  pairs() { // двое почти одновременно
    for (const N of [2, 3, 4, 5]) { console.log(`\n— N = ${N}, P = 0.5, последние двое через Δ —`);
      for (const d of [0, 0.5, 1, 2, 3, 4, 6, 10]) row(`Δ=${d} с`, { N, P: 0.5, pairGap: d, strategy: 'relay' }); }
  },
};
const t0 = Date.now();
for (const k of which === 'all' ? Object.keys(sets) : which.split(',')) { console.log(`\n===== ${k} (${SEEDS} сидов) =====`); sets[k](); }
console.error(`готово за ${((Date.now() - t0) / 1000).toFixed(0)} с`);
