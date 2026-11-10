// Быстрые пакетные прогоны без GUI: node tools/sweep.js [имя-набора] [сидов]
const S = require('../sim.js');
const which = process.argv[2] || 'all', SEEDS = +(process.argv[3] || 100);

function run(cfg) {
  const settles = []; let ev = 0, nc = 0, wrong = 0, wrongGap = 0, disc = 0, merged = 0, jams = 0, recs = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = S.simulate(Object.assign({ seed }, cfg));
    for (const e of r.events) { if (e.mergedWithNext) continue; ev++; if (e.converged) settles.push(e.settle); else nc++; }
    if (r.wrongBelief > 0) wrong++;
    if (r.wrongByGap > 0) wrongGap++;
    disc += r.discomfort / Math.max(1, cfg.N || 3);
    if (r.rolls.some(x => x.initiators && x.initiators.length > 1)) merged++;
    jams += r.rolls.filter(x => x.kind === 'jam').length; recs += r.rolls.filter(x => x.kind === 'recount').length;
  }
  settles.sort((a, b) => a - b);
  const q = f => settles.length ? settles[Math.min(settles.length - 1, Math.floor(f * settles.length))] : NaN;
  return { med: q(0.5), p90: q(0.9), nc: nc / ev, wrong: wrong / SEEDS, wrongGap: wrongGap / SEEDS, disc: disc / SEEDS, merged: merged / SEEDS, jams: jams / SEEDS, recs: recs / SEEDS };
}
const pct = x => (100 * x).toFixed(0).padStart(3) + '%';
const sec = x => (isNaN(x) ? '   —' : x.toFixed(1).padStart(5));
function row(label, cfg) {
  const m = run(cfg);
  console.log(label.padEnd(34), 'медиана', sec(m.med), ' p90', sec(m.p90), ' не сошлось', pct(m.nc),
    cfg.strategy === 'sheet' ? ` неверное N ${pct(m.wrongGap)}` : cfg.strategy === 'relay' || !cfg.strategy ? ` неверное N ${pct(m.wrongGap)} (при фактическом выходе ${pct(m.wrong)}) слияний ${pct(m.merged)} стоп ${m.jams.toFixed(2)} пересч ${m.recs.toFixed(2)}` : '',
    ' дискомфорт/чел', m.disc.toFixed(0).padStart(4));
}
const sets = {
  strategies() { // стратегии × N × P
    for (const P of [0, 0.5, 1, 2, 3]) { console.log(`\n— P = ${P} с, L = 5 —`);
      for (const N of [1, 2, 3, 4, 5, 6]) for (const st of ['naive', 'patient', 'simple', 'relay']) row(`N=${N} ${st}`, { N, P, strategy: st }); }
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
  triple() { // трое почти одновременно (последние трое с шагом Δ)
    for (const P of [0.5, 1, 2, 3]) { console.log(`\n— P = ${P} с, трое через Δ —`);
      for (const N of [3, 4, 6]) for (const d of [0, 0.3, 1]) row(`N=${N} Δ=${d} с`, { N, P, triGap: d, strategy: 'relay' }); }
  },
  merge() { // двойное синхро: принять слияние (жребий) против стоп-сигнала и повтора
    for (const P of [0.5, 2, 3, 4]) { console.log(`\n— P = ${P} с, двое одновременно —`);
      for (const N of [2, 4, 6]) for (const ma of [false, true]) row(`N=${N} ${ma ? 'принять слияние' : 'стоп-сигнал   '}`, { N, P, pairGap: 0, mergeAccept: ma }); }
  },
  detect() { // точность распознавания двойного синхро: ложные «двое» и пропущенные слияния
    for (const noise of [0, 0.1]) for (const P of [0.5, 2, 3, 4]) for (const N of [3, 6]) {
      let fp = 0, miss = 0, merged = 0, single = 0;
      for (const pairGap of [null, 0, 0.5, 1, 2, 3]) for (let seed = 1; seed <= Math.ceil(SEEDS / 2); seed++) {
        const r = S.simulate({ seed, N, P, pairGap, noise });
        for (const x of r.rolls) if (x.kind === 'entry' && x.syncsHeard != null && x.responders.length > 0) {
          if (x.initiators.length > 1) { merged++; if (x.syncsHeard < 2) miss++; } else { single++; if (x.syncsHeard > 1) fp++; }
        }
      }
      console.log(`шум ${noise} P=${P} N=${N}: одиночных синхро ${single}, ложно «двое» ${fp}; слияний ${merged}, пропущено ${miss}`);
    }
  },
  noise() { // шум ощущаемого напора, в долях одного мырга
    for (const P of [0.5, 3]) { console.log(`\n— P = ${P} с, N = 4 —`);
      for (const noise of [0, 0.05, 0.1, 0.15, 0.2]) for (const pairGap of [null, 0]) for (const ma of [false, true])
        row(`шум ${noise} ${pairGap == null ? 'по одному' : 'пара     '} ${ma ? 'принять' : 'стоп   '}`, { N: 4, P, noise, pairGap, mergeAccept: ma }); }
  },
  simple() { // простой: холодная понемногу, без сигналов — подбор коэффициента и против эстафеты
    for (const N of [4, 6]) { console.log(`\n— простой, N = ${N}, P = 0.5 —`);
      for (const simpleK of [0.001, 0.0015, 0.002, 0.003]) row(`k=${simpleK}`, { N, P: 0.5, strategy: 'simple', simpleK });
      row('k=0.0015 без случайного интервала', { N, P: 0.5, strategy: 'simple', simpleJit: 0 });
      row('k=0.0015, события раз в 90 с', { N, P: 0.5, strategy: 'simple', gap: 90 });
      row('k=0.001, события раз в 90 с', { N, P: 0.5, strategy: 'simple', simpleK: 0.001, gap: 90 }); }
    for (const L of [3, 5, 8, 12]) { console.log(`\n— L = ${L} с, N = 4, P = 0.5 —`);
      for (const st of ['simple', 'relay']) row(st, { N: 4, P: 0.5, L, strategy: st }); }
    for (const P of [0.5, 3]) { console.log(`\n— P = ${P} с —`);
      for (const N of [2, 4, 6]) for (const st of ['simple', 'relay']) row(`N=${N} ${st}`, { N, P, strategy: st });
      for (const st of ['simple', 'relay']) row(`пара Δ=0 N=6 ${st}`, { N: 6, P, pairGap: 0, strategy: st }); }
  },
  sheet() { // «договор»: перекличка по номерам кабинок против простого и эстафеты
    const ST = ['simple', 'sheet', 'relay'];
    for (const P of [0.5, 1, 2, 3]) { console.log(`\n— P = ${P} с —`);
      for (const N of [2, 4, 6]) for (const st of ST) row(`N=${N} ${st}`, { N, P, strategy: st });
      for (const st of ST) row(`пара Δ=0 N=6 ${st}`, { N: 6, P, pairGap: 0, strategy: st }); }
    for (const L of [3, 8, 12]) { console.log(`\n— L = ${L} с, N = 4, P = 0.5 —`);
      for (const st of ST) row(st, { N: 4, P: 0.5, L, strategy: st }); }
    console.log('\n— события раз в 90 с, N = 6, P = 3 —');
    for (const st of ST) row(st, { N: 6, P: 3, gap: 90, strategy: st });
  },
};
const t0 = Date.now();
for (const k of which === 'all' ? Object.keys(sets) : which.split(',')) { console.log(`\n===== ${k} (${SEEDS} сидов) =====`); sets[k](); }
console.error(`готово за ${((Date.now() - t0) / 1000).toFixed(0)} с`);
