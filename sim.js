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
    earlyJump: true, // старожилы прыгают сразу, не дожидаясь конца переклички
    strategy: 'relay', // naive | patient | relay
    pairGap: null,   // если число: последний приходит через столько секунд после предпоследнего
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
    const R = rng(p.seed);
    const dt = p.dt, N = p.N;

    // ---------- scenario ----------
    const arrivals = [];
    for (let i = 0; i < N; i++) arrivals.push(i * p.gap + 2);
    const paired = p.pairGap != null && N >= 2;
    if (paired) arrivals[N - 1] = arrivals[N - 2] + p.pairGap;
    const scenario = arrivals.map((t, i) => ({ t, kind: 'entry', who: i }));
    let T_END;
    if (N >= 2) {
      const tExit = Math.max(...arrivals) + p.gap;
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
    const Tunit = p.adaptive ? Math.max(0.5, 0.8 * p.P) : 0.5;
    const pause = p.adaptive ? Tunit : 0.5;
    const perceive = dPure + 5 * tau + (p.P > 0 ? 0.3 : 0); // напор устоялся
    const hear = dPure + 0.3;               // через сколько после начала чужого мырга его слышно
    const hop = Tunit + dPure + pause + 0.3; // эстафета: дождаться, пока услышишь, и выдержать паузу
    const silence = 3 * Tunit;
    const jamLen = 5 * Tunit;
    const cw0 = Math.max(3, 6 * Tunit);     // окно случайной паузы перед синхро-мыргом
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
      a.frozen = true;
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
        if (roll.kind !== 'entry' || t >= roll.sync + hear) { // услышал чужое синхро — ждёт конца переклички
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
      slots.forEach(g => { tt += hop; g.forEach(x => pulse(x, tt, r, '#' + x.num)); });
      r.end = tt + Tunit + dPure + silence;
      r.responders = responders;
      for (const x of present()) x.frozen = true;
      schedule(r.end, () => (r.kind === 'recount' ? finishRecount(r) : finishEntryRoll(r)));
    }

    // Пересчёт: синхро без ступеньки напора. Все считают мырги и ставят N = число мыргов; инициатор берёт номер N.
    function finishRecount(r) {
      const counted = countPulses(r.sync, r.end);
      r.detected = counted; r.expected = r.pulses.length;
      roll = null; lastQuiet = r.end;
      const a = r.initiators[0];
      for (const x of present()) if (x.num > 0 || x === a) {
        x.belief = counted; if (x.tableN !== counted) setTable(x, counted);
      }
      a.num = counted;
      release(r.end);
      schedule(r.end + p.L + 1, () => check(a));
    }

    // Проверка прыжка: если промах после прыжка по табличке больше 2 °C — N, видимо, неверное. Пересчёт.
    function check(a) {
      if (!a.present || a.num === 0) return;
      // кто-то ещё ждёт своей переклички (лишняя ступенька напора была) — сначала дождаться его
      if (present().some(x => x.num === 0)) { schedule(cur + p.L + 1, () => check(a)); return; }
      if (cur + 1e-6 < a.nextCheckOk) { schedule(a.nextCheckOk + 0.05, () => check(a)); return; }
      const e = a.target - a.felt[Math.max(0, kNow - 1)];
      if (Math.abs(e) <= 2) return;
      if (roll || cur < lastQuiet + silence) { schedule(Math.max(roll ? roll.end : 0, lastQuiet) + silence + R() * cw0, () => check(a)); return; }
      a.ev.recount = (a.ev.recount || 0) + 1;
      if (a.ev.recount > 3) return;
      startEntryRoll(a, cur, 'recount');
    }

    function finishEntryRoll(r) {
      const counted = countPulses(r.sync, r.end);
      r.detected = counted; r.expected = r.pulses.length;
      const responses = Math.max(0, counted - 1);
      const multi = r.initiators.length > 1;
      roll = null; lastQuiet = r.end;
      if (multi && r.responders.length > 0) {
        // старожилы видели две ступеньки, а синхро одно: глушилка, все новенькие пробуют заново
        const jammer = r.responders.slice().sort((u, v) => u.num - v.num)[0];
        const jt = r.end;
        const jr = { kind: 'jam', sync: jt, initiators: [jammer], pulses: [], end: jt + jamLen + dPure + silence, ev: r.ev };
        rolls.push(jr); roll = jr;
        pulse(jammer, jt, jr, 'стоп', jamLen);
        r.jammed = true;
        for (const x of r.initiators) { x.cw *= 2; x.ev.jammed = (x.ev.jammed || 0) + 1; }
        schedule(jr.end, () => {
          roll = null; lastQuiet = jr.end;
          for (const x of r.initiators) schedule(jr.end + R() * x.cw, () => attempt(x));
          release(jr.end);
        });
        return;
      }
      // обычный исход (или незамеченная коллизия в пустой душевой)
      for (const x of r.responders) { x.belief = (x.belief || 0) + 1; if (x.tableN !== x.belief) setTable(x, x.belief); }
      for (const x of r.initiators) {
        x.belief = responses + 1; x.num = responses + 1;
        setTable(x, x.belief);
        schedule(r.end + p.L + 1, () => check(x));
      }
      if (multi) r.silentCollision = true;
      release(r.end);
    }

    function release(t) {
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
      const src = k - dPs >= 0 ? phRaw[k - dPs] : null;
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

    return {
      params: p, dt, steps, T_END, phRaw, phFelt, nTrue: nTrueH, events, rolls, discomfort, wrongBelief,
      Tunit, hop, cw0,
      agents: agents.map(a => ({ id: a.id, target: a.target, mix: a.mix, felt: a.felt, gh: a.ghH, gc: a.gcH, num: a.numH, belief: a.beliefH })),
    };
  }

  const api = { simulate, DEF, TARGETS, TH, TC };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ShowerSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
