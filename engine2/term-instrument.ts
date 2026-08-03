/**
 * term-instrument.ts — THE POSSESSION-TERMINAL INSTRUMENT.
 *
 * Owing for five sessions; four rushed versions produced void counters. Each
 * of the six traps below voided a real probe in this arc and is designed out
 * here explicitly, named at the site so it cannot quietly return.
 */
import { Sim } from './sim.ts';
import { scenarioByName } from './scenarios/index.ts';
import { BALL } from './ball.ts';

const SEEDS = 6, TICKS = 2700, LIM = 1.0;

/** THE REACH IS THE RECEIVER'S, NOT A CONSTANT. "Did the ball reach its man"
 * is answered against HIS claim radius: an outfielder's control radius plus
 * stretch (~1.0 m), but a KEEPER claims with his hands out to
 * keeperReachBaseM + keeperReachAgility·agility (1.1–2.05 m). Applying the
 * outfield figure to a keeper marks completed passes to him as "never
 * reached" — five of 264 flights here, every one a goalkeeper, at 1.14–1.54 m.
 * It is not the 1.00 m boundary colliding with the claim floor (the values are
 * nowhere near 1.00); it is the wrong radius for the man. */
const reachOf = (r: any): number => (r && /-gk$/.test(r.id)
  ? BALL.keeperReachBaseM + BALL.keeperReachAgility * (r.attributes?.agility ?? 12)
  : LIM);

let reached = 0, died = 0;
const dieDur: number[] = [];
const term: Record<string, number> = { dead: 0, tackled: 0, uncontrolled: 0 };
const loose = { touch: 0, carry: 0, never: 0 };
const split = { aimed: 0, reachable: 0, noRecv: 0 };
let passEvents = 0, passKept = 0, nw = 0, nwTot = 0, completeTracked = 0;
const offend: string[] = [];

for (let s = 0; s < SEEDS; s++) {
  const sim = new Sim(scenarioByName('m11-match'), `cb-${s}`);
  const P = sim as any;
  // TRAP 4 — THE ATTACK AXIS. x*±1 puts every away possession in −105..0,
  // where the final-third line is unreachable and every away possession
  // scores "died before".
  const au = (b: any): number => (b.team === 'home' ? b.pos.x : 105 - b.pos.x);

  let tackleTick = -99;
  sim.telemetry = (e: any) => {
    if (e.t === 'tackle') tackleTick = e.tick ?? 0;
    if (e.t === 'pass') {
      passEvents++;
      if (e.outcome === 'complete' || e.outcome === 'teammate') passKept++;
      const m = passMin.get(e.tick);
      if (m !== undefined) {
        nwTot++; if (m > reachOf(P.byId.get(e.receiver))) nw++; if (e.outcome === 'complete') completeTracked++;
        if (m > reachOf(P.byId.get(e.receiver)) && e.outcome === 'complete') {
          const r = P.byId.get(e.receiver);
          const gap = r ? Math.hypot(sim.ball.pos.x - r.pos.x, sim.ball.pos.y - r.pos.y) : NaN;
          offend.push(`seed cb-${s} tick ${e.tick} dist ${e.dist.toFixed(1)}m loft ${e.loft} dt ${e.dt} ` +
            `recv ${e.receiver} minLive ${m.toFixed(3)}m gapAtClaim ${gap.toFixed(3)}m ` +
            `ball(${sim.ball.pos.x.toFixed(2)},${sim.ball.pos.y.toFixed(2)}) z ${sim.ball.z.toFixed(2)} ` +
            `recvPos(${r ? r.pos.x.toFixed(2) : '?'},${r ? r.pos.y.toFixed(2) : '?'})`);
        }
      }
    }
  };

  let poss: { team: string; start: number; maxU: number } | null = null;
  let lastOwnCarrierTick = -99;
  // TRAP 1 — SCOPE. minLive is PER PASS. Keyed by launch tick so the terminal
  // reads the flight that actually ended the possession, not the possession's
  // best-received pass. `lastRecv` resets per POSSESSION (a terminal with no
  // pass at all is the no-intended-receiver class, which a never-null
  // lastRecv silently empties).
  const passMin = new Map<number, number>();
  let lastRecv: string | null = null, curTick = -1;
  let prevBall = { x: sim.ball.pos.x, y: sim.ball.pos.y };
  let openTick = -1, openRecv: string | null = null;

  const close = (t: number, dead: boolean): void => {
    if (!poss) return;
    if (poss.maxU >= 70) { reached++; poss = null; return; }
    died++;
    dieDur.push(t - poss.start);
    let kind = 'uncontrolled';
    if (dead) kind = 'dead';
    else if (t - tackleTick <= 5) kind = 'tackled';
    else {
      // the ledger's predicates, in order so they partition
      const r = lastRecv ? P.byId.get(lastRecv) : null;
      const dBall = r ? Math.hypot(sim.ball.pos.x - r.pos.x, sim.ball.pos.y - r.pos.y) : Infinity;
      if (r && dBall <= reachOf(r)) loose.touch++;
      else if (t - lastOwnCarrierTick <= 5) loose.carry++;
      else {
        loose.never++;
        const m = curTick >= 0 ? passMin.get(curTick) : undefined;
        if (!lastRecv) split.noRecv++;
        else if (m === undefined || m > reachOf(P.byId.get(lastRecv))) split.aimed++;
        else split.reachable++;
      }
    }
    term[kind]++;
    poss = null;
  };

  for (let t = 0; t < TICKS; t++) {
    sim.step();
    const cur = { x: sim.ball.pos.x, y: sim.ball.pos.y };
    const op = P.openPass;
    const seg = (rid: string, key: number): void => {
      const r = P.byId.get(rid);
      if (!r) return;
      const vx = cur.x - prevBall.x, vy = cur.y - prevBall.y, L2 = vx * vx + vy * vy;
      const tt = L2 === 0 ? 0 : Math.max(0, Math.min(1,
        ((r.pos.x - prevBall.x) * vx + (r.pos.y - prevBall.y) * vy) / L2));
      const d = Math.hypot(prevBall.x + tt * vx - r.pos.x, prevBall.y + tt * vy - r.pos.y);
      passMin.set(key, Math.min(passMin.get(key) ?? Infinity, d));
    };
    // THE CLAIM TICK. openPass clears INSIDE sim.step(), so the tick on which
    // the ball is actually claimed is never sampled and the last reading is up
    // to 1.6 m stale — enough to put a completed pass outside the 1 m claim
    // radius it demonstrably reached. Sample the flight one last time as it
    // closes, before reading the new one.
    if (openTick >= 0 && openRecv && (!op || op.tick !== openTick)) seg(openRecv, openTick);
    if (op && op.receiver) { openTick = op.tick; openRecv = op.receiver; }
    else { openTick = -1; openRecv = null; }
    if (op && op.receiver) {
      if (op.tick !== curTick) { curTick = op.tick; passMin.set(op.tick, Infinity); lastRecv = op.receiver; }
      // TRAP 2 — POINT SAMPLING. At 10 Hz a 16 m/s ball steps ~1.6 m, so a
      // per-tick hypot skips the true closest approach (it read 96.7%
      // never-within-1m against 84.1% completion). Segment distance.
      seg(op.receiver, op.tick);
    }
    prevBall = cur;

    const c = sim.ball.carrierId;
    if (sim.ball.phase === 'dead') { close(t, true); continue; }
    if (!c) continue;
    const cb = P.byId.get(c);
    if (!cb) continue;
    if (!poss) { poss = { team: cb.team, start: t, maxU: -99 }; lastRecv = null; curTick = -1; }
    else if (poss.team !== cb.team) {
      close(t, false);
      poss = { team: cb.team, start: t, maxU: -99 }; lastRecv = null; curTick = -1;
    }
    // TRAP 3 — THE CARRIER. Updating on ANY carrier includes the opponent
    // whose claim ENDS the possession, so `t − lastCarrierTick` is always 0
    // and carry-security absorbs everything (it read 95.9%).
    if (cb.team === poss.team) lastOwnCarrierTick = t;
    const u = au(cb);
    if (u > poss.maxU) poss.maxU = u;
  }
}

// ── STEP 2: VERIFY BEFORE READING ────────────────────────────────────────
const fail: string[] = [];
const tot = reached + died;
const lsum = loose.touch + loose.carry + loose.never;
const ssum = split.aimed + split.reachable + split.noRecv;
const tsum = term.dead + term.tackled + term.uncontrolled;
// TRAP 6 — EMPTY CLASSES, checked before anything is read
for (const [n, v] of [['possessions', tot], ['died', died], ['uncontrolled', term.uncontrolled],
  ['never-controlled', loose.never], ['pass events', passEvents], ['tracked flights', nwTot]] as const) {
  if (v === 0) fail.push(`EMPTY CLASS: ${n}`);
}
if (tsum !== died) fail.push(`terminals do not sum: ${tsum} vs ${died}`);
if (lsum !== term.uncontrolled) fail.push(`loose does not sum: ${lsum} vs ${term.uncontrolled}`);
if (ssum !== loose.never) fail.push(`split does not sum: ${ssum} vs ${loose.never}`);
dieDur.sort((a, b) => a - b);
const p50 = dieDur[Math.floor(dieDur.length / 2)] / 10;
const completion = passKept / passEvents;
const nwShare = nw / nwTot;
// THE IMPOSSIBLE PAIR, correctly paired. A ball that never came within 1 m of
// its INTENDED receiver cannot have been 'complete' (that outcome IS the
// intended man claiming it) — but it CAN be 'teammate', a different player
// collecting a ball that missed its man. So the bound is against complete-only;
// pairing it against completion (complete OR teammate) compares two different
// populations and fails a sound instrument.
// ...and on ONE population. nwShare is over TRACKED flights; a complete-share
// over ALL pass events is a different denominator, and comparing the two is
// invalid whatever it returns. Counts on the same set, no shares:
if (nw + completeTracked > nwTot) fail.push(`IMPOSSIBLE PAIR: never-within-1m ${nw} + complete ${completeTracked} > tracked ${nwTot}`);

if (offend.length) console.log(`OFFENDING FLIGHTS (complete AND never-within-${LIM}m):\n  ${offend.join('\n  ')}\n`);
console.log(`VERIFY:`);
console.log(`  early-death median ${p50.toFixed(1)}s   (ledger's independent figure: 3.1s)`);
console.log(`  completion ${(100 * completion).toFixed(1)}% | never-within-1m ${(100 * nwShare).toFixed(1)}% of ${nwTot} tracked flights — of which complete ${completeTracked} — overlap must be 0, headroom ${nwTot - nw - completeTracked}`);
console.log(`  partitions: terminals ${tsum}/${died}, loose ${lsum}/${term.uncontrolled}, split ${ssum}/${loose.never}`);
if (fail.length) { console.log(`\nVERIFICATION FAILED:\n  ${fail.join('\n  ')}`); process.exit(1); }
console.log(`  ALL CHECKS PASS\n`);

const pc = (n: number, d: number): string => (d ? `${(100 * n / d).toFixed(1)}%` : 'VOID');
console.log(`MEASURE (32af69e6, ${SEEDS} seeds cb-*, ${TICKS} ticks):`);
console.log(`  possessions ${tot} | reached final third ${reached} ${pc(reached, tot)} | died before ${died} ${pc(died, tot)}`);
console.log(`  TERMINALS: dead ${term.dead} ${pc(term.dead, died)} | tackled ${term.tackled} ${pc(term.tackled, died)} | uncontrolled ${term.uncontrolled} ${pc(term.uncontrolled, died)}`);
console.log(`  LOOSE: first touch ${loose.touch} ${pc(loose.touch, lsum)} | carry security ${loose.carry} ${pc(loose.carry, lsum)} | never controlled ${loose.never} ${pc(loose.never, lsum)}`);
console.log(`  NEVER-CONTROLLED: aimed badly ${split.aimed} ${pc(split.aimed, ssum)} | reachable but lost ${split.reachable} ${pc(split.reachable, ssum)} | no intended receiver ${split.noRecv} ${pc(split.noRecv, ssum)}`);
