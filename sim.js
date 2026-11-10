/* Shower protocol simulator. Pure functions, no DOM. Works in browser (window.ShowerSim) and node (module.exports). */
(function (root) {
  'use strict';
  const TH = 60, TC = 15, PIPE0 = 22;
  const TARGETS = [38, 40.5, 37, 39.5, 41, 36.5];

  const DEF = {
    N: 3,            // сколько людей придёт
    L: 5,            // задержка температуры, с
    P: 0.5,          // за сколько доходит изменение напора, с (0 = мгновенно)
    adaptive: true,  // темп T подстраивается под P
    jamGrow: 2,      // во сколько раз растёт окно паузы новенького после стоп-сигнала
    tail: true,      // услышавший чужое синхро новенький пристраивается в хвост той же переклички
    tailAlways: false, // держать окно под хвост в каждой перекличке (иначе — только при лишней ступеньке)
    cwK: 2,          // окно случайной паузы перед синхро не меньше cwK·P (слышно чужое синхро только через ~P)
    tK: 0.2,         // адаптивный темп: T = max(0.5, tK·P); 0.8 давало слишком длинные мырги
    relayPause: false, // true = прежний шаг эстафеты с лишней паузой
    mergeAccept: true, // слившиеся синхро распознаются по напору: N верное сразу, номера разводит жребий
    earlyJump: true, // старожилы прыгают сразу, не дожидаясь конца переклички
    strategy: 'relay', // naive | patient | simple | relay
    simpleK: 0.0015,  // simple: шаг холодной = simpleK·ошибка (°C) за секунду…
    simpleRate: 0.03, // …но не больше 3 % хода крана за секунду
    simpleJit: 0.3,   // интервал между шагами 1 с ± 30 % — против синхронных качелей
    simpleDz: 0.3,    // мёртвая зона, °C
    noise: 0,        // шум ощущаемого напора, в долях амплитуды одного мырга (до сглаживания)
    pairGap: null,   // если число: последний приходит через столько секунд после предпоследнего
    triGap: null,    // если число: последние трое приходят с шагом triGap секунд
    dt: 0.1,
    Rh: 2.0,         // сопротивление общей горячей магистрали (связь сильная)
    Rc: 0.35,        // сопротивление холодной магистрали (связь слабая)
    hotMark: 0.6,    // метка горячего крана
    band: 0.5,       // зона комфорта, ±°C
    tableErr: 0.06,  // ошибка личной таблички, ±доля
    gap: 45,         // секунд между событиями
    seed: 7,
  };

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  function effGh(a, now) { return a.present ? (now < a.pulseUntil ? 0 : a.gh) : 0; }

  function linePressures(agents, p, now, override) {
    let Gh = 0, Gc = 0;
    for (const a of agents) {
      if (!a.present) continue;
      const o = override && override.id === a.id ? override : null;
      Gh += effGh(a, now);
      Gc += o ? o.gc : a.gc;
    }
    return { ph: 1 / (1 + p.Rh * Gh), pc: 1 / (1 + p.Rc * Gc) };
  }

  function mixT(gh, gc, ph, pc) {
    const qh = gh * ph, qc = gc * pc, q = qh + qc;
    return q > 1e-9 ? (qh * TH + qc * TC) / q : null;
  }

  function steadyFor(agents, p, a, gc, now) {
    const { ph, pc } = linePressures(agents, p, now, { id: a.id, gc });
    return mixT(effGh(a, now), gc, ph, pc);
  }

  // Personal table: cold setting for "N people, all hot at the mark". Depends on N only.
  function tableEntry(a, p, n) {
    n = Math.max(1, n);
    const ph = 1 / (1 + p.Rh * p.hotMark * n);
    let gc = 0.3;
    for (let it = 0; it < 6; it++) {
      const pc = 1 / (1 + p.Rc * gc * n);
      const qh = p.hotMark * ph;
      gc = (qh * (TH - a.target) / (a.target - TC)) / pc;
    }
    return clamp(gc * (1 + a.tableErrFor(n)), 0, 1.2);
  }

  function simulate(opts) {
    const p = Object.assign({}, DEF, opts || {});
    const R = rng(p.seed), Rn = rng(p.seed * 7919 + 13); // Rn — отдельный поток для шума, чтобы без шума ничего не менялось
    const dt = p.dt, N = p.N;

    // ---------- scenario ----------
    const arrivals = [];
    for (let i = 0; i < N; i++) arrivals.push(i * p.gap + 2);
    const paired = p.pairGap != null && N >= 2;
    if (paired) arrivals[N - 1] = arrivals[N - 2] + p.pairGap;
    if (p.triGap != null && N >= 3) { arrivals[N - 2] = arrivals[N - 3] + p.triGap; arrivals[N - 1] = arrivals[N - 3] + 2 * p.triGap; }
    const scenario = arrivals.map((t, i) => ({ t, kind: 'entry', who: i }));
    let T_END, tExit = null;
    if (N >= 2) {
      tExit = Math.max(...arrivals) + p.gap;
      scenario.push({ t: tExit, kind: 'exit', who: paired && N === 2 ? 0 : 1 });
      T_END = tExit + p.gap;
    } else T_END = p.gap * 1.5;
    scenario.sort((x, y) => x.t - y.t);

    const steps = Math.round(T_END / dt);
    const Ls = Math.round(p.L / dt);
    const dPure = p.P * 0.4, tau = p.P * 0.2; // ощущение напора: чистая задержка + сглаживание, вместе ≈ P
    const dPs = Math.round(dPure / dt);

    const agents = [];
    for (let i = 0; i < N; i++) {
      const errs = {};
      const a = {
        id: i, target: TARGETS[i % TARGETS.length], present: false,
        gh: 0, gc: 0, pulseUntil: -1, arriveStep: -1,
        num: 0, belief: null, nextAct: 0, frozen: false, cw: 0, ev: null,
        mix: new Array(steps).fill(null), felt: new Array(steps).fill(null),
        ghH: new Array(steps).fill(null), gcH: new Array(steps).fill(null),
        numH: new Array(steps).fill(null), beliefH: new Array(steps).fill(null),
        phase: R(),
      };
      a.tableErrFor = (n) => { if (errs[n] == null) errs[n] = (R() * 2 - 1) * p.tableErr; return errs[n]; };
      agents.push(a);
    }

    const phRaw = new Array(steps), phFelt = new Array(steps), nTrueH = new Array(steps);
    let lag = null;
    const events = [], rolls = [], actions = [];
    function schedule(t, fn) { actions.push({ t, fn }); actions.sort((x, y) => x.t - y.t); }
    const present = () => agents.filter(a => a.present);

    // ---------- relay protocol ----------
    const Tunit = p.adaptive ? Math.max(0.5, p.tK * p.P) : 0.5;
    const pause = p.adaptive ? Tunit : 0.5;
    const perceive = dPure + 5 * tau + (p.P > 0 ? 0.3 : 0); // напор устоялся
    const hear = dPure + 0.3;               // через сколько после начала чужого мырга его слышно
    // эстафета: №k мыргает, как только услышал конец мырга №k−1 (relayPause — прежняя пауза на каждом шаге).
    // Только №1 после синхро выжидает паузу: хвост синхро (а при слиянии — двух) должен затихнуть,
    // чтобы по нему можно было и сравнить площади, и проверить ступеньку.
    const hop = Tunit + hear + (p.relayPause ? pause : 0);
    const hop1 = Tunit + hear + pause;
    const silence = 3 * Tunit;
    const jamLen = 5 * Tunit;
    const cw0 = Math.max(3, 6 * Tunit, p.cwK * p.P); // окно случайной паузы перед синхро: должно покрывать время, за которое слышно чужое синхро
    let roll = null, lastQuiet = -1;        // активная перекличка; когда канал снова тих

    function setTable(x, n) { x.gc = tableEntry(x, p, n); x.tableN = n; }

    function pulse(a, t0, r, label, len) {
      const d = len || Tunit;
      schedule(t0, () => { a.pulseUntil = t0 + d; });
      r.pulses.push({ t: t0, dur: d, who: a.id, label });
    }

    function arriveRelay(a, now) {
      a.gh = p.hotMark; a.gc = tableEntry(a, p, 2); // пока N не знает — догадка «нас двое»
      a.num = 0; a.belief = null; a.cw = cw0;
      a.frozen = true; a.ownP = null;
      schedule(now + perceive, () => { a.ownP = feltNow(); });
      // старожилы видят ступеньку напора и сразу знают новое N
      if (p.earlyJump) schedule(now + perceive, () => {
        const nPhys = present().length;
        for (const x of present()) if (x.num > 0) setTable(x, nPhys);
      });
      schedule(now + perceive + 0.3 + R() * a.cw, () => attempt(a));
    }

    function attempt(a) {
      if (!a.present) return;
      const t = cur;
      if (roll) {
        if (roll.kind === 'entry' && p.tail && isFinite(roll.tail) && t >= roll.sync + hear && t < roll.tail - 0.1) {
          // услышал чужое синхро, и окно под хвост держат — пристраивается: мыргнёт после последнего старожила, выдержав тишину
          roll.joiners.push(a); pulse(a, roll.tail, roll, 'хвост');
          a.ev.joined = (a.ev.joined || 0) + 1;
        } else if (roll.kind !== 'entry' || t >= roll.sync + hear) { // услышал чужое синхро — ждёт конца переклички
          a.ev.deferred = (a.ev.deferred || 0) + 1;
          schedule(roll.end + silence + R() * a.cw, () => attempt(a));
        } else { // не успел услышать — коллизия: его синхро сливается с чужим
          roll.initiators.push(a);
          pulse(a, t, roll, 'синхро');
          a.ev.collided = true;
        }
        return;
      }
      if (t < lastQuiet + silence) { schedule(lastQuiet + silence + R() * a.cw, () => attempt(a)); return; }
      startEntryRoll(a, t);
    }

    function slotsOf(list) { // эстафета по номерам; одинаковые номера мыргают одновременно
      const by = new Map();
      for (const x of list) { if (!by.has(x.num)) by.set(x.num, []); by.get(x.num).push(x); }
      return [...by.keys()].sort((u, v) => u - v).map(k => by.get(k));
    }

    function startEntryRoll(a, t, kind) {
      const r = { kind: kind || 'entry', sync: t, initiators: [a], pulses: [], ev: a.ev };
      roll = r; rolls.push(r);
      pulse(a, t, r, 'синхро');
      const responders = present().filter(x => x.num > 0 && x !== a);
      const slots = slotsOf(responders);
      let tt = t;
      slots.forEach((g, i) => { tt += i ? hop : hop1; g.forEach(x => pulse(x, tt, r, '#' + x.num)); });
      r.lastSlot = tt; r.joiners = [];
      // хвост: после последнего старожила пауза длиннее обычного шага — там мыргают пристроившиеся новенькие
      // окно под хвост держат, только если по напору видно, что пришедших больше, чем синхро
      const withTail = p.tail && r.kind === 'entry' && (p.tailAlways || extraArrival(a));
      r.tail = withTail ? tt + hop + silence : Infinity;
      r.end = (withTail ? r.tail : tt) + Tunit + dPure + silence;
      r.responders = responders;
      for (const x of present()) x.frozen = true;
      schedule(r.end, () => (r.kind === 'recount' ? finishRecount(r) : finishEntryRoll(r)));
    }

    // Ступенька напора за время переклички: если базовый напор до синхро и после конца разный,
    // кто-то пришёл посреди переклички и мог «съесть» мырг — результату верить нельзя.
    function stepH(n) { const Gh = Math.max(1, n) * p.hotMark; return 1 / (1 + p.Rh * (Gh - p.hotMark)) - 1 / (1 + p.Rh * Gh); }
    function contaminated(r, nKnown, tFrom) {
      const k0 = Math.max(0, Math.round((tFrom ?? r.sync) / dt) - 1), k1 = Math.min(steps - 1, Math.round(r.end / dt) - 1); // текущий шаг ещё не посчитан
      if (phFelt[k0] == null || phFelt[k1] == null) return false;
      // под душем nKnown старожилов + инициатор; пришедший добавит ступеньку при nKnown + 2
      return Math.abs(phFelt[k0] - phFelt[k1]) > 0.5 * stepH(nKnown + 2);
    }
    function extraArrival(a) {
      if (ledger.baseP != null && feltNow() != null) return arrivalsFelt() > ledger.syncs + 1;
      // пустая душевая: сравнить с напором, который новенький почувствовал после своего прихода
      return a.ownP != null && feltNow() != null && a.ownP - feltNow() > 0.5 * stepH(2);
    }
    function voidRoll(r) { // все почувствовали лишнюю ступеньку: перекличка не в счёт
      r.voided = true; roll = null; lastQuiet = r.end;
      // приоритет: испорченную перекличку её инициатор повторяет сразу, остальные услышат синхро и подождут
      for (const x of r.joiners || []) schedule(r.end + 0.3 + hear + 0.2, () => attempt(x)); // услышат новое синхро и пристроятся снова
      for (const x of r.initiators) {
        x.ev.voided = (x.ev.voided || 0) + 1;
        schedule(r.end + 0.3, () => { if (!x.present) return; if (roll) { attempt(x); return; } startEntryRoll(x, cur, x.num > 0 ? 'recount' : 'entry'); });
      }
      release(r.end);
    }

    // Пересчёт: синхро без ступеньки напора. Все считают мырги и ставят N = число мыргов; инициатор берёт номер N.
    function finishRecount(r) {
      if (contaminated(r, r.responders.length)) { voidRoll(r); return; }
      // синхро пересчёта одиночное по построению — оно и есть мерка одного мырга для слотов
      const slots = countPulses(syncEndOf(r), r.end);
      const unit = area(r.sync + dPure - 0.1, syncEndOf(r), phFelt[Math.max(0, Math.round(r.sync / dt) - 1)]);
      const counted = p.mergeAccept ? 1 + slotsHeard(r, slots, unit) : countPulses(r.sync, r.end);
      r.detected = counted; r.expected = r.pulses.length;
      roll = null; lastQuiet = r.end;
      const a = r.initiators[0];
      for (const x of present()) if (x.num > 0 || x === a) {
        x.belief = counted; if (x.tableN !== counted) setTable(x, counted);
      }
      a.num = counted;
      release(r.end);
      rebase();
      schedule(r.end + p.L + 1, () => check(a));
    }

    // Проверка прыжка: если промах после прыжка по табличке больше 2 °C — N, видимо, неверное. Пересчёт.
    function check(a, force) {
      if (!a.present || a.num === 0) return;
      // кто-то ещё ждёт своей переклички (лишняя ступенька напора была) — сначала дождаться его
      if (present().some(x => x.num === 0)) { schedule(cur + p.L + 1, () => check(a)); return; }
      if (cur + 1e-6 < a.nextCheckOk) { schedule(a.nextCheckOk + 0.05, () => check(a)); return; }
      const e = a.target - a.felt[Math.max(0, kNow - 1)];
      if (!force && Math.abs(e) <= 2) return;
      if (roll || cur < lastQuiet + silence) { schedule(Math.max(roll ? roll.end : 0, lastQuiet) + silence + R() * cw0, () => check(a, force)); return; }
      a.ev.recount = (a.ev.recount || 0) + 1;
      if (a.ev.recount > 3) return;
      startEntryRoll(a, cur, 'recount');
    }

    // Площадь всплеска в окне ощущаемого напора. Ощущение сглажено (≈ запаздывание с постоянной tau),
    // поэтому к площади добавляется tau·(f(конец) − f(начало)): так хвост, переползший через границу окна,
    // засчитывается тому мыргу, которому он принадлежит. tau человек знает: она того же порядка, что P.
    function area(t0, t1, base) {
      let s = 0; const i0 = Math.max(0, Math.round(t0 / dt)), i1 = Math.min(steps - 1, Math.round(t1 / dt) - 1);
      for (let i = i0; i <= i1; i++) if (phFelt[i] != null) s += (phFelt[i] - base) * dt;
      const f = (i) => phFelt[Math.max(0, Math.min(steps - 1, i))] ?? base;
      return s + tau * (f(i1) - f(i0 - 1));
    }
    // Сколько человек мыргнули почти разом, по отношению площадей «всплеск / один мырг». Напор от числа
    // открытых кранов зависит нелинейно: k мыргов точно разом дают отношение g(k) > k, а разнесённые во
    // времени — ровно k. Синхро разнесены (каждый мыргает в свою случайную паузу): k людям соответствует
    // отношение от k до g(k), порог между k и k+1 — посередине между g(k) и k+1 (между одним и двумя — те же
    // 1,5). В хвосте и в слоте эстафеты мыргают точно разом (exact): порог посередине между g(k) и g(k+1).
    // Ступенька при n людях — то же знание, что и табличка (как в countPulses); абсолютный напор не нужен.
    function kOf(ratio, exact) {
      const n = Math.max(1, present().length), Gh = n * p.hotMark;
      const h = (k) => 1 / (1 + p.Rh * Math.max(0, Gh - k * p.hotMark)) - 1 / (1 + p.Rh * Gh);
      for (let k = 1; k < n; k++) if (ratio < (h(k) / h(1) + (exact ? h(k + 1) / h(1) : k + 1)) / 2) return k;
      return Math.max(1, n - 1);
    }
    const baseAt = (t) => phFelt[Math.max(0, Math.round(t / dt) - 1)];
    // База для ответов и хвоста. Мырг только поднимает напор, приход нового — только опускает. Если
    // ступенька пришла вплотную к синхро (слишком мала, чтобы перекличку признали испорченной), напор
    // до синхро выше, чем во время ответов, и мерка одного мырга занижается. Тогда база — «пол»
    // переклички: нижний квантиль напора после синхро (одиночный шумный отсчёт его не сдвигает). При
    // медленном напоре мырги соседних слотов не успевают спасть, пол выше настоящей базы — там остаётся
    // напор до синхро. Шум тоже чуть опускает пол, поэтому пол берётся, только если он ниже напора до
    // синхро больше чем на четверть ступеньки.
    const rollBase = (r) => {
      const b0 = baseAt(r.sync), fl = floorOf(syncEndOf(r), r.end);
      return b0 - fl > 0.25 * stepH(present().length) ? fl : b0;
    };
    function floorOf(t0, t1) {
      const v = [];
      for (let i = Math.max(0, Math.round(t0 / dt)); i <= Math.min(steps - 1, Math.round(t1 / dt) - 1); i++) if (phFelt[i] != null) v.push(phFelt[i]);
      if (!v.length) return baseAt(t0);
      v.sort((a, b) => a - b);
      return v[Math.floor(0.2 * (v.length - 1))];
    }
    const syncEndOf = (r) => r.sync + hop1 + dPure - 0.1; // до этого момента ответ №1 ещё не ощущается
    // Сколько синхро было: всё, что ощущается до ответа №1, — синхро. Площадь всплеска синхро делится
    // на площадь ответа старожила (тот же кран, тот же напор): от 1,5 — двое и больше, сколько именно — kOf.
    // Площадь, а не число пиков: два мырга вплотную сливаются в один пик, но площадь у них двойная.
    function syncsHeard(r, nResp) {
      const syncEnd = syncEndOf(r);
      // в пустой душевой сравнить не с чем — слияние там ловит пересчёт по температуре
      if (nResp === 0) return { m: 1, unit: null };
      const base = phFelt[Math.max(0, Math.round(r.sync / dt) - 1)], fl = rollBase(r);
      const us = [];
      for (let k = 1; k <= nResp; k++) { const t = r.sync + hop1 + (k - 1) * hop + dPure - 0.1; us.push(area(t, t + hop, fl)); }
      us.sort((u, v) => u - v);
      const unit = us[Math.floor(us.length / 2)];
      const ratio = unit > 0 ? area(r.sync + dPure - 0.1, syncEnd, base) / unit : 1;
      return { m: kOf(ratio), unit };
    }

    // Сколько человек в слотах эстафеты: в слоте мыргают все с одинаковым номером, и если номер у двоих
    // совпал (слились в пустой душевой, сравнить было не с чем), их мырги сливаются. Считаем слот по площади.
    function slotsHeard(r, nSlots, unit) {
      if (!unit || !(unit > 0) || !p.mergeAccept) return nSlots;
      const base = rollBase(r);
      let total = 0;
      for (let k = 1; k <= nSlots; k++) { const t = r.sync + hop1 + (k - 1) * hop + dPure - 0.1; total += kOf(area(t, t + hop, base) / unit, true); }
      return total;
    }

    function finishEntryRoll(r) {
      const split = isFinite(r.tail) ? r.tail - 0.1 : r.end;
      let responses, mm = 1, unit = null;
      if (p.mergeAccept) {
        responses = countPulses(syncEndOf(r), split); // ответы старожилов (не сливаются: у каждого свой шаг)
        ({ m: mm, unit } = syncsHeard(r, responses));
        responses = slotsHeard(r, responses, unit);
        // Ступенька посреди переклички портит и счёт, и сравнение площадей. При двойном синхро смотрим
        // от конца окна синхро: ступенька второго из слившихся могла дойти уже после первого синхро. Но если
        // напор во время ответов провалился ниже, чем был до синхро (база ответов — пол), это не второе
        // синхро, а пришедший посреди ответов: его ступенька и раздула «двойное» — проверять от начала.
        const exempt = mm > 1 && rollBase(r) === baseAt(r.sync);
        if (contaminated(r, r.responders.length, exempt ? syncEndOf(r) : r.sync)) { voidRoll(r); return; }
      } else { // как было: синхро всегда считается одним
        if (r.initiators.length === 1 && contaminated(r, r.responders.length)) { voidRoll(r); return; }
        responses = Math.max(0, countPulses(r.sync, split) - 1);
      }
      r.syncsHeard = mm;
      // сколько мыргов в хвосте: пристроившиеся мыргают почти разом, поэтому, если есть с чем сравнить, — по площади
      let J = isFinite(r.tail) ? countPulses(split, r.end) : 0;
      if (J > 0 && unit && p.mergeAccept) J = Math.max(J, kOf(area(split, r.end, rollBase(r)) / unit, true));
      r.joinHeard = J;
      r.detected = mm + responses + J; r.expected = r.pulses.length;
      const multi = r.initiators.length > 1;
      roll = null; lastQuiet = r.end;
      for (const x of r.responders) { x.belief = (x.belief || 0) + mm + J; if (x.tableN !== x.belief) setTable(x, x.belief); }
      for (const x of r.initiators) {
        if (mm > 1) x.ev.mergeAccepted = true;
        x.belief = responses + mm + J; x.num = responses + 1;
        setTable(x, x.belief);
        schedule(r.end + p.L + 1, () => check(x));
      }
      for (const x of r.joiners) {
        x.belief = responses + mm + J; x.num = responses + mm + 1;
        setTable(x, x.belief);
        schedule(r.end + p.L + 1, () => check(x));
      }
      if (multi && r.responders.length === 0) r.silentCollision = true;
      if (multi) r.merged = true; // для статистики: синхро слились (сами агенты этого не знают)
      release(r.end);
      if (r.responders.length > 0) { ledger.syncs += mm + J; ledger.last = r; audit(); } else rebase();
      // слияние принято: N уже верное у всех, осталось развести одинаковые номера жребием
      if (mm > 1) startTie(r.initiators.filter(x => x.present), responses + 1, r.end, unit, r.ev);
      // в хвосте мыргнули несколько — номер у них тоже один на всех, разводит тот же жребий
      if (J > 1) startTie(r.joiners.filter(x => x.present), responses + mm + 1, r.end, unit, r.ev);
    }

    // Жребий: у слившихся одинаковый номер. Каждый ждёт случайную паузу и мыргает, если не услышал
    // другого раньше. Мыргнувший первым оставляет номер, остальные берут следующий. Мыргнули почти
    // разом (всплеск вдвое больше одного мырга) — повтор с паузой вдвое длиннее.
    function startTie(members, base, t0, unit, ev) {
      if (members.length < 2) return;
      if (roll) { schedule(roll.end + 0.2, () => startTie(members, base, cur, unit, ev)); return; }
      const wait = Math.max(...members.map(x => x.cw));
      const r = { kind: 'tie', sync: t0, initiators: members, pulses: [], ev, base, end: t0 + silence + wait + hear + Tunit + dPure + silence };
      roll = r; rolls.push(r);
      // никого не замораживает: N уже верное, поправки по температуре идут своим чередом
      const fired = [];
      for (const x of members) schedule(t0 + silence + R() * x.cw, () => {
        if (!x.present || fired.some(f => cur >= f.t + hear)) return; // услышал чужой мырг — уступает
        fired.push({ x, t: cur }); pulse(x, cur, r, 'жребий');
      });
      schedule(r.end, () => {
        roll = null; lastQuiet = r.end;
        const first = fired[0];
        let heardTwo = fired.length >= 2; // запасной путь, если не с чем сравнить
        if (first && unit) heardTwo = area(first.t, r.end, phFelt[Math.max(0, Math.round(first.t / dt) - 1)]) / unit >= 1.5; // по ощущаемому
        r.tieClash = heardTwo; r.detected = heardTwo ? 2 : first ? 1 : 0; r.expected = fired.length;
        if (!first) return;
        if (heardTwo) { for (const x of members) x.cw *= p.jamGrow; startTie(members.filter(x => x.present), base, r.end, unit, ev); return; }
        const rest = members.filter(x => x !== first.x && x.present);
        for (const x of rest) x.num = base + 1;
        if (rest.length > 1) startTie(rest, base + 1, r.end, unit, ev);
      });
    }

    // ---------- учёт ступенек: стоп-сигнал по ощущаемому напору ----------
    // Старожил помнит базовый напор (когда всё сходилось) и сколько нас тогда было. Сколько людей
    // пришло с тех пор, он оценивает по тому, на сколько «ступенек при n» упал напор (знание вида
    // «одна ступенька при n людях ощущается так» — такое же, как личная табличка). Синхро он считает
    // на слух. Если ступенек больше, чем синхро, и за окно ожидания недостающее синхро не пришло —
    // кто-то слился: стоп-сигнал, последняя перекличка не в счёт.
    const phOf = (n) => 1 / (1 + p.Rh * p.hotMark * Math.max(0, n));
    const feltNow = () => phFelt[Math.max(0, kNow - 1)];
    const dupLog = [];
    const ledger = { baseP: null, baseN: 0, syncs: 0, last: null, pending: false, jams: 0 };
    // после стоп-сигнала новенькие удваивают паузу — старожил ждёт недостающее синхро тоже вдвое дольше
    const debtWait = () => silence + cw0 * Math.pow(2, ledger.jams) + 1;
    function observer() { const xs = present().filter(x => x.num > 0); return xs.sort((u, v) => u.num - v.num)[0] || null; }
    function rebase() {
      const o = observer(); ledger.pending = false; ledger.syncs = 0; ledger.last = null; ledger.jams = 0;
      if (!o || feltNow() == null) { ledger.baseP = null; return; }
      ledger.baseP = feltNow(); ledger.baseN = o.belief || 1;
      // при медленном напоре последний мырг ещё досыхает: через 5·tau базу уточнить, если напор опустился
      // меньше чем на полступеньки (это хвост мырга, а не новый пришедший)
      const b0 = ledger.baseP;
      schedule(cur + 5 * tau + dt, () => {
        if (ledger.baseP !== b0 || roll || feltNow() == null) return;
        const d = b0 - feltNow();
        if (d > 0 && d < 0.5 * stepH(ledger.baseN + 1)) ledger.baseP = feltNow();
      });
    }
    function arrivalsFelt() {
      const drop = ledger.baseP - feltNow();
      let best = 0, bestErr = Infinity;
      for (let k = 0; k <= 6; k++) { const err = Math.abs(phOf(ledger.baseN) - phOf(ledger.baseN + k) - drop); if (err < bestErr) { bestErr = err; best = k; } }
      return best;
    }
    function audit() {
      if (ledger.baseP == null) { rebase(); return; }
      if (arrivalsFelt() <= ledger.syncs) { rebase(); return; }
      if (ledger.pending) return;
      ledger.pending = true;
      const decide = () => {
        if (roll) { schedule(roll.end + 0.2, decide); return; }
        ledger.pending = false;
        if (ledger.baseP == null) return;
        if (arrivalsFelt() <= ledger.syncs) { rebase(); return; }
        const jammer = observer(), last = ledger.last;
        if (!jammer || !last) { rebase(); return; }
        jam(jammer, last);
      };
      schedule(cur + debtWait(), decide);
    }
    function jam(jammer, last) {
      const jt = cur;
      const jr = { kind: 'jam', sync: jt, initiators: [jammer], pulses: [], end: jt + jamLen + dPure + silence, ev: last.ev };
      rolls.push(jr); roll = jr;
      pulse(jammer, jt, jr, 'стоп', jamLen);
      last.jammed = true;
      // последняя перекличка не в счёт: её новенькие сбрасывают номер, старожилы откатывают N
      const back = (last.syncsHeard || 1) + (last.joinHeard || 0), redo = last.initiators.concat(last.joiners || []);
      for (const x of redo) { x.num = 0; x.belief = null; x.cw *= p.jamGrow; x.ev.jammed = (x.ev.jammed || 0) + 1; }
      for (const x of last.responders) if (x.present) { x.belief = Math.max(1, (x.belief || 1) - back); if (x.tableN !== x.belief) setTable(x, x.belief); }
      ledger.syncs = Math.max(0, ledger.syncs - back); ledger.last = null; ledger.jams += 1;
      for (const x of present()) x.frozen = true;
      schedule(jr.end, () => {
        roll = null; lastQuiet = jr.end;
        for (const x of redo) if (x.present) schedule(jr.end + R() * x.cw, () => attempt(x));
        release(jr.end);
      });
    }

    function release(t) {
      if (roll === null) { // для статистики: у скольких присутствующих номер совпадает с чужим (агенты этого не видят)
        const ns = present().filter(x => x.num > 0).map(x => x.num);
        dupLog.push({ t, dups: ns.filter(v => ns.indexOf(v) !== ns.lastIndexOf(v)).length });
      }
      for (const x of present()) x.nextCheckOk = t + p.L + 1;
      for (const x of present()) { x.frozen = false; x.nextAct = Math.max(x.nextAct, t + p.L + 1); }
      for (const x of present()) if (x.num === 0) x.frozen = true; // ещё не прошёл перекличку — ждёт
    }

    function exitRelay(a, now) {
      const leaverNum = a.num;
      const go = () => {
        if (roll) { schedule(roll.end + 0.1, go); return; }
        const t = cur + perceive;
        const r = { kind: 'exit', sync: t, initiators: [], pulses: [], ev: a.ev };
        roll = r; rolls.push(r);
        const numbered = present().filter(x => x.num > 0);
        const slots = slotsOf(numbered);
        let tt = t - hop, gapDone = false;
        slots.forEach(g => {
          tt += hop;
          if (!gapDone && g[0].num > leaverNum) { tt += silence; gapDone = true; }
          g.forEach(x => pulse(x, tt, r, '#' + x.num));
        });
        r.end = tt + Tunit + dPure + 0.3;
        for (const x of present()) x.frozen = true;
        schedule(r.end, () => {
          r.detected = countPulses(r.sync, r.end); r.expected = r.pulses.length;
          for (const x of numbered) { if (x.num > leaverNum) x.num -= 1; x.belief = Math.max(1, (x.belief || 1) - 1); if (x.tableN !== x.belief) setTable(x, x.belief); }
          roll = null; lastQuiet = r.end;
          release(r.end);
          rebase();
        });
      };
      if (p.earlyJump) schedule(now + perceive, () => { const n = present().length; for (const x of present()) if (x.num > 0) setTable(x, n); });
      go();
    }

    // Сколько мыргов различимо в ощущаемом напоре: пики, которые и поднимаются, и опускаются
    // хотя бы на половину амплитуды одного крана. Ступенька (вход/выход) пиком не считается.
    function countPulses(t0, t1) {
      const i0 = Math.max(1, Math.round(t0 / dt) - 2), i1 = Math.min(steps - 2, Math.round(t1 / dt));
      const n = Math.max(1, present().length);
      const Gh = n * p.hotMark;
      const h = 1 / (1 + p.Rh * (Gh - p.hotMark)) - 1 / (1 + p.Rh * Gh);
      const win = Math.max(3, Math.round((hop + Tunit) / dt));
      const v = (i) => phFelt[i];
      let count = 0, armedBelow = -Infinity;
      for (let i = i0; i <= i1; i++) {
        if (v(i) == null || v(i - 1) == null || v(i + 1) == null) continue;
        if (v(i) < armedBelow) armedBelow = -Infinity; // сигнал снова опустился — можно ловить следующий пик
        if (armedBelow > -Infinity) continue;
        if (!(v(i) > v(i - 1) && v(i) >= v(i + 1))) continue;
        let lmin = v(i), rmin = v(i);
        for (let j = Math.max(0, i - win); j < i; j++) if (v(j) != null) lmin = Math.min(lmin, v(j));
        for (let j = i + 1; j <= Math.min(i1, i + win); j++) if (v(j) != null) rmin = Math.min(rmin, v(j));
        if (v(i) - lmin > 0.5 * h && v(i) - rmin > 0.5 * h) { count++; armedBelow = v(i) - 0.5 * h; }
      }
      return count;
    }

    // ---------- control laws ----------
    function feltOf(a, k) {
      const j = k - Ls;
      if (j < a.arriveStep || j < 0) return PIPE0;
      const v = a.mix[j];
      return v == null ? PIPE0 : v;
    }

    function control(a, now, k) {
      if (!a.present || a.frozen || now < a.nextAct) return;
      const e = a.target - a.felt[k];
      if (p.strategy === 'naive') {
        const ng = a.gh + 0.02 * e;
        if ((ng > 1 && e > 0) || (ng < 0.05 && e < 0)) a.gc = clamp(a.gc - 0.01 * e, 0, 1.2);
        a.gh = clamp(ng, 0.05, 1);
        a.nextAct = now + 1;
      } else if (p.strategy === 'simple') {
        // Простой: горячая на метке, холодная понемногу в сторону коррекции. Никаких сигналов и N.
        if (Math.abs(e) > p.simpleDz) a.gc = clamp(a.gc - clamp(p.simpleK * e, -p.simpleRate, p.simpleRate) * a.tick, 0, 1.2);
        a.tick = 1 + (R() * 2 - 1) * p.simpleJit;
        a.nextAct = now + a.tick;
      } else if (p.strategy === 'patient') {
        if (Math.abs(e) > p.band * 0.6) a.gc = clamp(a.gc - clamp(0.012 * e, -0.08, 0.08), 0, 1.2);
        a.nextAct = now + p.L + 1;
      } else {
        if (Math.abs(e) > p.band * 0.6) {
          const g0 = a.gc, d = 0.01, lo = Math.max(0, g0 - d);
          const s = (steadyFor(agents, p, a, g0 + d, now) - steadyFor(agents, p, a, lo, now)) / (g0 + d - lo);
          if (s < -1e-6) a.gc = clamp(g0 + 0.8 * e / s, 0, 1.2);
        }
        a.nextAct = now + p.L + 1;
      }
    }

    // ---------- main loop ----------
    let si = 0, cur = 0, kNow = 0;
    for (let k = 0; k < steps; k++) {
      const now = k * dt; cur = now; kNow = k;
      while (si < scenario.length && scenario[si].t <= now + 1e-9) {
        const sc = scenario[si++];
        const a = agents[sc.who];
        const ev = { kind: sc.kind, who: sc.who, t: now };
        events.push(ev); a.ev = ev;
        if (sc.kind === 'entry') {
          a.present = true; a.arriveStep = k;
          if (p.strategy === 'naive') { a.gh = 0.5; a.gc = 0.25; a.nextAct = now + p.L + a.phase; }
          else if (p.strategy === 'simple') { a.gh = p.hotMark; a.gc = 0.4; a.tick = 1; a.nextAct = now + 1 + R(); }
          else if (p.strategy === 'patient') { a.gh = p.hotMark; a.gc = 0.4; a.nextAct = now + p.L + 1; }
          else arriveRelay(a, now);
        } else if (p.strategy === 'relay') {
          // уходящий тоже ждёт тишины: закрывает кран только когда никто не перекликается
          const leave = () => {
            if (roll || cur < lastQuiet + silence) { schedule(Math.max(roll ? roll.end : 0, lastQuiet) + silence + 0.1, leave); return; }
            ev.t = cur; a.present = false; exitRelay(a, cur);
          };
          leave();
        } else {
          a.present = false;
        }
      }
      let guard = 0;
      while (actions.length && actions[0].t <= now + 1e-9) { actions.shift().fn(); if (++guard > 500) throw new Error('action loop at t=' + now + ' next=' + (actions[0] && actions[0].fn.toString().slice(0, 120))); }

      const { ph, pc } = linePressures(agents, p, now);
      const nP = present().length;
      phRaw[k] = nP > 0 ? ph : null; nTrueH[k] = nP;
      let src = k - dPs >= 0 ? phRaw[k - dPs] : null;
      if (src != null && p.noise > 0) { // шум ощущения: в долях одного мырга при текущем числе людей
        const g = Math.sqrt(-2 * Math.log(1 - Rn())) * Math.cos(2 * Math.PI * Rn());
        src += p.noise * stepH(Math.max(2, nTrueH[k - dPs])) * g;
      }
      if (src == null) phFelt[k] = lag;
      else { if (lag == null || tau === 0) lag = src; else lag += (src - lag) * (1 - Math.exp(-dt / tau)); phFelt[k] = lag; }
      for (const a of agents) {
        if (!a.present) continue;
        a.mix[k] = mixT(effGh(a, now), a.gc, ph, pc);
        a.ghH[k] = effGh(a, now); a.gcH[k] = a.gc; a.numH[k] = a.num; a.beliefH[k] = a.belief;
      }
      for (const a of agents) if (a.present) a.felt[k] = feltOf(a, k);
      for (const a of agents) control(a, now, k);
    }

    // ---------- metrics: события ближе 20 с друг к другу считаются одним ----------
    const groups = [];
    events.forEach((ev, i) => {
      if (i > 0 && ev.t - events[i - 1].t < 20) groups[groups.length - 1].push(i); else groups.push([i]);
    });
    groups.forEach((g, gi) => {
      const t0 = events[g[0]].t;
      const t1 = gi + 1 < groups.length ? events[groups[gi + 1][0]].t : T_END;
      const k0 = Math.round(t0 / dt), k1 = Math.min(steps - 1, Math.round(t1 / dt) - 1);
      let lastBad = -1;
      for (let k = k0; k <= k1; k++) for (const a of agents) {
        const v = a.felt[k];
        if (v != null && Math.abs(v - a.target) > p.band) { lastBad = k; break; }
      }
      const conv = lastBad < k1 - Math.round(3 / dt);
      g.forEach((i, j) => {
        const ev = events[i];
        if (j < g.length - 1) { ev.mergedWithNext = true; ev.settle = null; ev.converged = null; return; }
        ev.converged = conv; ev.settle = conv ? Math.max(0, (lastBad + 1) * dt - t0) : null; ev.groupStart = t0;
      });
    });
    let discomfort = 0;
    for (let k = 0; k < steps; k++) for (const a of agents) {
      const v = a.felt[k]; if (v != null) discomfort += Math.max(0, Math.abs(v - a.target) - p.band) * dt;
    }
    // итог по знанию N у каждого в конце
    const exitEv = events.find(e => e.kind === 'exit');
    const kChk = exitEv ? Math.max(0, Math.round(exitEv.t / dt) - 1) : steps - 1;
    const wrongBelief = p.strategy === 'relay' ? agents.filter(a => a.felt[kChk] != null && a.beliefH[kChk] !== nTrueH[kChk]).length : 0;
    // то же, но строго к плановому времени выхода: уходящий ждёт тишины, и без этого затянувшаяся
    // перекличка отодвигает момент проверки и прячет ошибку
    const kSch = tExit != null ? Math.min(steps - 1, Math.round(tExit / dt) - 1) : steps - 1;
    const wrongByGap = p.strategy === 'relay' ? agents.filter(a => a.felt[kSch] != null && a.beliefH[kSch] !== nTrueH[kSch]).length : 0;

    return {
      params: p, dt, steps, T_END, phRaw, phFelt, nTrue: nTrueH, events, rolls, dupLog, discomfort, wrongBelief, wrongByGap,
      Tunit, hop, cw0,
      agents: agents.map(a => ({ id: a.id, target: a.target, mix: a.mix, felt: a.felt, gh: a.ghH, gc: a.gcH, num: a.numH, belief: a.beliefH })),
    };
  }

  const api = { simulate, DEF, TARGETS, TH, TC };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ShowerSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
