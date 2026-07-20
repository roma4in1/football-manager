/**
 * technique.test.ts — L3 assertions. Stochastic mechanisms are asserted as
 * RATES across seeds (keyed rng: each seed deterministic, rates honest) and
 * as model properties (probability orderings). Plus the two audit fixes:
 * bodies never interpenetrate, kicks are reach-gated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TECH, touchPopProbability, tackleWinProbability, shieldRadiusM } from './technique.ts';
import { runScenario } from './sim.ts';
import { scenarioByName, SCENARIOS } from './scenarios/index.ts';
import type { BodyAttributes } from './engine2-types.ts';

const attrs = (over: Partial<BodyAttributes> = {}): BodyAttributes => ({
  pace: 12, acceleration: 12, agility: 12, balance: 12, dribbling: 12,
  firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12, ...over,
});

test('first-touch model: difficulty orders by closing speed, height, pressure, receiver speed; skill relieves', () => {
  const silk = attrs({ firstTouch: 18 });
  const heavy = attrs({ firstTouch: 5 });
  assert.ok(touchPopProbability(silk, 13, 0, false) < touchPopProbability(heavy, 13, 0, false), 'skill relieves');
  assert.ok(touchPopProbability(heavy, 6, 0, false) < touchPopProbability(heavy, 14, 0, false), 'faster closing is harder');
  assert.ok(touchPopProbability(heavy, 10, 0, false) < touchPopProbability(heavy, 10, 0.4, false), 'a bouncing ball is harder');
  assert.ok(touchPopProbability(heavy, 10, 0, false) < touchPopProbability(heavy, 10, 0, true), 'pressure bites');
  assert.ok(touchPopProbability(silk, 13, 0, false) < 0.2, 'a silk touch on a driven ball is usually dead');
  // the receiver's own gait matters: walking < running < sprinting
  const walk = touchPopProbability(heavy, 8, 0, false, 1.5);
  const run = touchPopProbability(heavy, 8, 0, false, 6.3);
  const sprint = touchPopProbability(heavy, 8, 0, false, 8.1);
  assert.ok(walk < run && run < sprint, `receiver speed orders difficulty (${walk.toFixed(2)} < ${run.toFixed(2)} < ${sprint.toFixed(2)})`);
});

test('tackle model: the composite edge orders win probability; shield widens with strength+balance', () => {
  const winner = tackleWinProbability(attrs({ tackling: 17, strength: 16 }), attrs({ dribbling: 8, balance: 8 }));
  const loser = tackleWinProbability(attrs({ tackling: 7, strength: 8 }), attrs({ dribbling: 17, balance: 16 }));
  assert.ok(winner > 0.6 && loser < 0.25, `edges express (${winner.toFixed(2)} vs ${loser.toFixed(2)})`);
  assert.ok(shieldRadiusM(attrs({ strength: 18, balance: 18 })) > shieldRadiusM(attrs({ strength: 6, balance: 6 })) + 0.1);
});

/** pop rate for a first-touch drill across seeds */
function popRate(name: string, seeds: number): number {
  let pops = 0;
  let contacts = 0;
  for (let s = 0; s < seeds; s++) {
    const frames = runScenario(scenarioByName(name), `ft-${s}`);
    // a pop = the receiver contacts the ball (it slows near him) but is NOT
    // the carrier immediately after contact
    // contact = genuinely within claim reach (kick noise can miss wide — a
    // missed feed is not a first touch and stays out of the denominator)
    const contact = frames.findIndex((f) => f.tick > 12 &&
      Math.hypot(f.ball.x - f.bodies.find((b) => b.id === 'receiver')!.x,
        f.ball.y - f.bodies.find((b) => b.id === 'receiver')!.y) < 0.85);
    if (contact < 0) continue;
    contacts++;
    const soonCarrier = frames.slice(contact, contact + 6).some((f) => f.ball.carrierId === 'receiver');
    if (!soonCarrier) pops++;
  }
  return contacts === 0 ? 0 : pops / contacts;
}

test('first-touch scenarios: silk kills driven balls; heavy feet under pressure spill (rates across 24 seeds)', () => {
  const silk = popRate('first-touch-silk', 24);
  const silkPressed = popRate('first-touch-silk-pressed', 24);
  const heavy = popRate('first-touch-heavy', 24);
  const heavyPressed = popRate('first-touch-heavy-pressed', 24);
  assert.ok(silk <= 0.15, `silk, free: almost always dead (${silk.toFixed(2)})`);
  assert.ok(heavyPressed >= 0.33, `heavy under pressure spills often (${heavyPressed.toFixed(2)})`);
  assert.ok(heavyPressed > heavy - 1e-9, 'pressure only ever hurts');
  assert.ok(heavy > silk - 1e-9 && silkPressed >= silk - 1e-9, 'orderings hold');
});

test('tackle scenarios: the ball-winner strips, the shielder holds (rates across 20 seeds)', () => {
  let strips = 0;
  let holds = 0;
  for (let s = 0; s < 20; s++) {
    const strip = runScenario(scenarioByName('tackle-duel-strip'), `tk-${s}`);
    if (strip.some((f) => f.ball.carrierId === 'hunter' || (f.ball.carrierId === null && f.tick > 30))) strips++;
    const hold = runScenario(scenarioByName('tackle-duel-hold'), `tk-${s}`);
    const last = hold[hold.length - 1];
    if (last.ball.carrierId === 'carrier') holds++;
  }
  assert.ok(strips >= 15, `the strong tackler usually dispossesses (${strips}/20)`);
  assert.ok(holds >= 13, `the strong shielder usually survives 30s (${holds}/20)`);
});

test('kick noise: weak feet scatter more than elite feet (spread across 30 seeds)', () => {
  const spread = (passing: number): number => {
    const ys: number[] = [];
    for (let s = 0; s < 30; s++) {
      const def: import('./engine2-types.ts').ScenarioDef = {
        version: 1, name: `scatter-${passing}`, description: '', durationTicks: 50,
        bodies: [{ id: 'k', team: 'home', pos: { x: 20, y: 34 }, attributes: attrs({ passing }) }],
        ball: { carrier: 'k' },
        script: [],
        kicks: [{ atTick: 5, bodyId: 'k', kick: { target: { x: 60, y: 34 }, speedMps: 12, loftDeg: 0 } }],
      };
      const frames = runScenario(def, `sc-${s}`);
      ys.push(frames[frames.length - 1].ball.y);
    }
    const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
    return Math.sqrt(ys.reduce((a, y) => a + (y - mean) ** 2, 0) / ys.length);
  };
  const elite = spread(19);
  const poor = spread(4);
  assert.ok(poor > elite * 2, `passing 4 scatters ≫ passing 19 (σ ${poor.toFixed(2)} vs ${elite.toFixed(2)})`);
  assert.ok(elite < 1.2, `elite feet stay tight at 40m (σ ${elite.toFixed(2)})`);
});

test('kicks are reach-gated: a kick scheduled while the ball is mid-touch away is a no-op', () => {
  const def: import('./engine2-types.ts').ScenarioDef = {
    version: 1, name: 'reach-gate', description: '', durationTicks: 80,
    bodies: [{ id: 'r', team: 'home', pos: { x: 20, y: 34 }, attributes: attrs({ dribbling: 5 }) }],
    ball: { carrier: 'r' },
    script: [{ atTick: 5, bodyId: 'r', command: { type: 'moveTo', target: { x: 80, y: 34 }, regime: 'sprint' } }],
    // scheduled mid-sprint: with heavy feet the ball is routinely > 1.1m ahead
    kicks: [{ atTick: 40, bodyId: 'r', kick: { target: { x: 20, y: 60 }, speedMps: 14, loftDeg: 0 } }],
  };
  const frames = runScenario(def, 'assert');
  const kickTickBall = frames[40].ball;
  const gap = Math.hypot(kickTickBall.x - frames[40].bodies[0].x, kickTickBall.y - frames[40].bodies[0].y);
  if (gap > TECH.kickReachM) {
    // the kick must NOT have fired: the ball keeps rolling forward, not to y=60
    assert.ok(frames[45].ball.y > 30, 'no remote-control strike');
  }
});

test('moving receives: cushioning in stride is easy, charging onto a drive is hard (closing-speed model)', () => {
  // the detection window matches each drill's closing speed: a slow cushion
  // chase needs a tight window (a wide one fires ~2s before the take); the
  // head-on charge needs a wide one (per-frame sampling steps ~1.6m)
  const rate = (name: string, seeds: number, windowM: number): number => {
    let pops = 0;
    let contacts = 0;
    for (let s = 0; s < seeds; s++) {
      const frames = runScenario(scenarioByName(name), `run-${s}`);
      const contact = frames.findIndex((f) => f.tick > 14 &&
        Math.hypot(f.ball.x - f.bodies.find((b) => b.id === 'receiver')!.x,
          f.ball.y - f.bodies.find((b) => b.id === 'receiver')!.y) < windowM);
      if (contact < 0) continue;
      contacts++;
      const soon = frames.slice(contact, contact + 6).some((f) => f.ball.carrierId === 'receiver');
      if (!soon) pops++;
    }
    return contacts === 0 ? -1 : pops / contacts;
  };
  const withRun = rate('first-touch-run-with', 20, 1.0);
  const onto = rate('first-touch-run-onto', 20, 2.0);
  assert.ok(withRun >= 0 && onto >= 0, 'both drills make contact');
  assert.ok(withRun <= 0.15, `a cushioned take in stride almost always sticks (${withRun.toFixed(2)})`);
  assert.ok(onto > withRun + 0.1, `charging onto the drive spills more (${onto.toFixed(2)} vs ${withRun.toFixed(2)})`);
});

test('the DIRECTIONAL first touch: a charging receiver takes the ball in stride — no dead-stop, no circle-back', () => {
  let taken = 0;
  let inStride = 0;
  for (let s = 0; s < 16; s++) {
    const frames = runScenario(scenarioByName('first-touch-run-onto'), `dir-${s}`);
    const claimIdx = frames.findIndex((f) => f.ball.carrierId === 'receiver');
    if (claimIdx < 0 || claimIdx > frames.length - 12) continue;
    taken++;
    // in stride = still the carrier 1s later, ball progressing along his
    // route (−x), and his speed never collapses to a stand-and-turn
    const later = frames[claimIdx + 10];
    const ballProgressed = later.ball.x < frames[claimIdx].ball.x - 1.5;
    let minSpeed = Infinity;
    for (let i = claimIdx; i < claimIdx + 10; i++) {
      const r = frames[i].bodies.find((b) => b.id === 'receiver')!;
      minSpeed = Math.min(minSpeed, Math.hypot(r.vx, r.vy));
    }
    if (later.ball.carrierId === 'receiver' && ballProgressed && minSpeed > 2.0) inStride++;
  }
  assert.ok(taken >= 8, `enough successful takes to judge (${taken}/16)`);
  assert.ok(inStride >= taken * 0.7, `takes are in stride (${inStride}/${taken})`);
});

test('the receive-geometry matrix makes reliable contact: onto, across, angled all claim (relative sweep)', () => {
  // the regression for frame-relative swept claims: two fast movers crossing
  // must interact — the judged "does not reliably pick up the ball"
  // with departure timed like a real runner's cue, even the 17 m/s feed is
  // read reliably — the DIFFICULTY of a driven ball lives in the touch
  // roll, not the read
  const floors: Record<string, number> = {
    'first-touch-run-onto': 13, 'first-touch-run-across': 13,
    'first-touch-run-angled': 13, 'first-touch-run-across-fast': 13,
  };
  for (const name of ['first-touch-run-onto', 'first-touch-run-across', 'first-touch-run-angled', 'first-touch-run-across-fast']) {
    let interactions = 0;
    const N = 16;
    for (let s = 0; s < N; s++) {
      const frames = runScenario(scenarioByName(name), `geo-${s}`);
      // an interaction = the receiver claims OR the ball's velocity changes
      // sharply near him (a pop counts; a clean fly-through does not)
      const claimed = frames.some((f) => f.ball.carrierId === 'receiver');
      if (claimed) {
        interactions++;
        continue;
      }
      for (let i = 2; i < frames.length - 1; i++) {
        const r = frames[i].bodies.find((b) => b.id === 'receiver')!;
        const near = Math.hypot(frames[i].ball.x - r.x, frames[i].ball.y - r.y) < 2.0;
        if (!near) continue;
        const v0 = Math.hypot(frames[i].ball.x - frames[i - 1].ball.x, frames[i].ball.y - frames[i - 1].ball.y);
        const v1 = Math.hypot(frames[i + 1].ball.x - frames[i].ball.x, frames[i + 1].ball.y - frames[i].ball.y);
        if (v0 > 0.2 && v1 < v0 * 0.6) {
          interactions++;
          break;
        }
      }
    }
    assert.ok(interactions >= floors[name], `${name}: the receiver reliably meets the ball (${interactions}/${N})`);
  }
});

test('contain at contact: the hunter presses a shielding carrier, he does not orbit him (the 360 fix)', () => {
  const frames = runScenario(scenarioByName('tackle-duel-hold'), 'tk-1');
  // once in contact, track the hunter's bearing around the carrier — the
  // total sweep must stay well under a full orbit
  let sweep = 0;
  let prevBearing: number | null = null;
  for (const f of frames) {
    const c = f.bodies.find((b) => b.id === 'carrier')!;
    const h = f.bodies.find((b) => b.id === 'hunter')!;
    const d = Math.hypot(h.x - c.x, h.y - c.y);
    if (d > 1.6) { prevBearing = null; continue; }
    const bearing = Math.atan2(h.y - c.y, h.x - c.x);
    if (prevBearing !== null) {
      let db = bearing - prevBearing;
      if (db > Math.PI) db -= 2 * Math.PI;
      if (db < -Math.PI) db += 2 * Math.PI;
      sweep += Math.abs(db);
    }
    prevBearing = bearing;
  }
  assert.ok(sweep < Math.PI * 1.5, `no 360s around the carrier (total sweep ${(sweep / Math.PI).toFixed(2)}π)`);
});

test('shield bracing: a pressed standing carrier turns his back to the presser', () => {
  const frames = runScenario(scenarioByName('tackle-duel-hold'), 'tk-2');
  // late in the contest, the carrier's facing should point away from the hunter
  const f = frames[200];
  const c = f.bodies.find((b) => b.id === 'carrier')!;
  const h = f.bodies.find((b) => b.id === 'hunter')!;
  if (Math.hypot(h.x - c.x, h.y - c.y) < 1.6 && f.ball.carrierId === 'carrier') {
    const away = Math.atan2(c.y - h.y, c.x - h.x);
    let diff = Math.abs(c.facing - away) % (2 * Math.PI);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    assert.ok(diff < 0.6, `back-on to the presser (off by ${(diff * 180 / Math.PI).toFixed(0)}°)`);
  }
});

test('head-on duel: the set defender is met, and touch quality decides it (rates across 16 seeds)', () => {
  const run = (name: string) => {
    let through = 0;
    let defWon = 0;
    let engaged = 0;
    for (let s = 0; s < 16; s++) {
      const frames = runScenario(scenarioByName(name), `fd-${s}`);
      let lost = false;
      let minGap = 99;
      for (const f of frames) {
        const a = f.bodies.find((b) => b.id === 'attacker')!;
        const d = f.bodies.find((b) => b.id === 'defender')!;
        minGap = Math.min(minGap, Math.hypot(a.x - d.x, a.y - d.y));
        if (!lost && f.ball.carrierId === 'defender') lost = true;
        if (!lost && f.ball.carrierId === 'attacker' && a.x > 60) { through++; break; }
      }
      if (lost) defWon++;
      if (minGap < 1.8) engaged++;
    }
    return { through, defWon, engaged };
  };
  const close = run('duel-1v1-front-close');
  const heavy = run('duel-1v1-front-heavy');
  // the carrier must actually MEET the defender (the drill's whole point) —
  // pressure-shortened touches keep the ball out of the instant pinch
  assert.equal(close.engaged, 16, `close: the duel happens (${close.engaged}/16 engagements)`);
  assert.equal(heavy.engaged, 16, `heavy: the duel happens (${heavy.engaged}/16 engagements)`);
  // outcome split: close control beats a lunge-only set defender (jockeying
  // is L5e); heavy feet under pressure serve the pinch/tackle a real share
  assert.ok(close.through >= 12, `close control carries through (${close.through}/16)`);
  assert.ok(heavy.defWon >= 4, `heavy feet lose the head-on a real share (${heavy.defWon}/16 defender wins)`);
});

test('knock-past: the touch around the defender is a real, winnable move (rates across 16 seeds)', () => {
  let recollected = 0;
  let defenderWon = 0;
  let firstClaim = 0;
  for (let s = 0; s < 16; s++) {
    const frames = runScenario(scenarioByName('knock-past'), `kp-${s}`);
    // success = the attacker is carrying again BEYOND the defender's park
    const win = frames.some((f) => {
      if (f.ball.carrierId !== 'attacker') return false;
      const a = f.bodies.find((b) => b.id === 'attacker')!;
      return a.x > 55;
    });
    if (win) recollected++;
    else if (frames.some((f) => f.ball.carrierId === 'defender')) defenderWon++;
    // the FIRST claim after the knock is the race itself — winning the ball
    // back later by tackle is a contest, not a beaten man (the old floor
    // passed on tackle-backs while the watched race was lost every time)
    let released = false;
    for (const f of frames) {
      if (!released && f.ball.carrierId === null) released = true;
      else if (released && f.ball.carrierId !== null) {
        if (f.ball.carrierId === 'attacker') firstClaim++;
        break;
      }
    }
  }
  // pace 15 with a flying start vs a flat-footed pace-11 defender: the
  // attacker wins the race to his own knock most times; the defender's
  // occasional stab of a tight knock is the move's honest risk
  assert.ok(firstClaim >= 11, `the attacker beats the man to his own knock (${firstClaim}/16 first claims)`);
  assert.ok(recollected >= 13, `and ends up carrying beyond the park (${recollected}/16)`);
  assert.ok(recollected + defenderWon >= 14, `and it always resolves to a contest, never the void (${defenderWon} defender wins)`);
});

test('bodies never interpenetrate (audit fix): min pairwise separation holds everywhere', () => {
  for (const def of SCENARIOS) {
    if (def.bodies.length < 2) continue;
    const frames = runScenario(def, 'assert');
    for (const f of frames) {
      for (let i = 0; i < f.bodies.length; i++) {
        for (let j = i + 1; j < f.bodies.length; j++) {
          const d = Math.hypot(f.bodies[i].x - f.bodies[j].x, f.bodies[i].y - f.bodies[j].y);
          assert.ok(d >= TECH.bodyRadiusM * 2 - 0.15, `${def.name}: ${f.bodies[i].id}/${f.bodies[j].id} overlap (${d.toFixed(2)}m) at tick ${f.tick}`);
        }
      }
    }
  }
});
