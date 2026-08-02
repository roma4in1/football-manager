/**
 * sim.ts — the L2 simulation loop: fixed 10 Hz tick over kinematic bodies
 * (L1) and one physical ball (L2), driven by scripted commands/kicks.
 *
 * Tick order (fixed — determinism is the contract):
 *   1. scripted command re-targets fire;
 *   2. bodies step (chaseBall reads the ball's pre-step position);
 *   3. scripted kicks fire (carrier-gated);
 *   4. the carry coupling runs (touch / possession loss), then ball physics;
 *   5. loose-ball claims resolve (nearest body in reach, deterministic
 *      tie-break), completing any chaseBall race;
 *   6. the frame snapshots.
 *
 * The sim emits FULL-RATE frames internally; the stored/replayable format is
 * the decimated stream in frames.ts. No wall clock, no unkeyed randomness.
 */

import {
  DT,
  PITCH,
  type BodyState,
  type Frame,
  type FrameBody,
  type MovementCommand,
  type ScenarioDef,
  type Vec2,
} from './engine2-types.ts';
import { BALL, kickBall, loftFlightTimeS, predictBall, predictBallState, rollLaunchForArrival, solveLoftSpeed, stepBall, type BallState } from './ball.ts';
import { currentTarget, KIN, regimeCapMps, stepBody, topSpeedMps } from './kinematics.ts';
import { noisyKick, resolveFirstTouch, shieldRadiusM, tackleWinProbability, TECH } from './technique.ts';
import { adhere, aerialCompletion, attackSign, blockStation, decide, DECIDE, decideDefense, DUEL, GOAL, goalCenter, passCompletion, pivotShift, posValue, runPlan, supportSpot, zoneEngageShade, type Intent, type PlayInstructions } from './decide.ts';
import { KeyedRng } from './keyed-rng.ts';

export class Sim {
  readonly bodies: BodyState[];
  readonly ball: BallState;
  readonly rng: KeyedRng;
  tick = 0;
  private readonly byId = new Map<string, BodyState>();
  private readonly atTick = new Map<number, Array<{ bodyId: string; command: MovementCommand }>>();
  private readonly kicksAt = new Map<number, Array<{ bodyId: string; kick: { target: Vec2; speedMps: number; loftDeg: number; spin?: number } }>>();
  private readonly queues = new Map<string, MovementCommand[]>();
  /** per-tick live steering targets (intercepts/fetches) — the frame's debug
   * overlay shows what the body is ACTUALLY running to */
  private readonly liveTargets = new Map<string, Vec2>();
  /** L4: bodies that run the on-ball decision loop, their instructions,
   * their current intent, and the action label shown in the workbench */
  private readonly brains = new Set<string>();
  /** L7: goalkeeper bodies — they self-position (angle play) and stop shots */
  private readonly keepers = new Set<string>();
  /** tick a keeper first SAW the live shot — the dive starts after his
   * reaction (keeperReactTicks); before it he holds his angle */
  private readonly keeperShotSeen = new Map<string, number>();
  /** keepers ATTACKING a ball this tick (the sweep, the claim run) — they
   * sprint full tilt; the shuffle's face-lock is for POSITIONING only */
  private readonly keeperAttacking = new Set<string>();
  /** the keeper HOLDING the ball in his hands (a catch, a claim, a pickup in
   * his box) — UNTOUCHABLE: no tackle, no pinch, until he releases it */
  private keeperHolding: string | null = null;
  /** tick the hold began — distribution follows after a settle */
  private keeperHeldSince = 0;
  /** a DROP-TO-FEET pass in progress: the ball is down (immunity OFF — he is
   * honestly tackleable) and the ground pass strikes after the beat */
  private keeperDropPass: { keeperId: string; mateId: string; strikeTick: number } | null = null;
  /** goals conceded — a ball crossing either goal line between the posts,
   * under the bar. The minimal seam L7 acceptance needs (saved vs beaten);
   * restarts stay L8's. `against` is the team whose goal it crossed. */
  readonly goals: { tick: number; against: 'home' | 'away'; y: number; z: number }[] = [];
  readonly instructions = new Map<string, PlayInstructions>(); // public: the tactics harness and probes set these
  private readonly intents = new Map<string, Intent>();
  private readonly actionLabels = new Map<string, string>();
  /** the teammate a decided pass is flighted to — gets the receive reflex */
  intendedReceiverId: string | null = null; // public: the monitor's reception tagging reads it
  /** initial positions — the 'keep' objective's drill stations */
  private readonly homes = new Map<string, Vec2>();
  /** THE PHASE-TACTICS LAYER (builder direction, recorded): six phases —
   * possession build/progress/final, defense high/mid/low — detected
   * from possession x ball third (4 m hysteresis). Per-phase homes are
   * DERIVED by band-mapping each base home along the team axis, and the
   * live `homes` map swaps on phase change: every anchor in the engine
   * (stations, zone costs, depth bands, vacancy) becomes phase-correct
   * BY CONSTRUCTION — the home-anchor bug class retires wholesale.
   * Kickoff staging keeps the base formation. Manager per-slot overrides
   * are the recorded next hook. Match scale only. */
  private readonly baseHomes = new Map<string, Vec2>();
  /** manager-authored per-phase placements — override the derived bands */
  private readonly phaseHomeOverrides = new Map<string, Partial<Record<string, Vec2>>>();
  private readonly teamPhase = new Map<'home' | 'away', 'build' | 'progress' | 'final' | 'high' | 'mid' | 'low'>();
  private lastPossessTeam: 'home' | 'away' | null = null;
  private lastFlipTick = -999;
  /** THE DART ECONOMY (L5b priced, the effort economy's second place):
   * a dart that ends UNFED costs its runner a cooldown before the next
   * launch — 59% of darts timed out unfed at the free 0.7s reload
   * (ST ~540 darts/90 vs real 20-40; the cycle was a bare timer).
   * Scaled by stamina (its second consumer): big engines reload faster. */
  private readonly dartRest = new Map<string, number>();
  /** THE WAITING RESTART (watch-8 findings A+B): tick the pending
   * window opened — the goal-kick ceremony waits for LEGALITY (box
   * clear) and a DWELL floor before it may kick. Dwell is SCALED:
   * real goal-kick dead time is ~15-30s (ball-in-play literature,
   * order-of-magnitude provenance); a realistic dwell would consume
   * 10-19% of every pinned 270s slice, so the floor is 6s (enough
   * for the law's own march-out: 16.5m at jog ~4.1s) with a 14s cap
   * against deadlock. Full-realism dwell is deferred to full-match
   * pacing, stated openly in the ledger. */
  private restartPendSince: number | null = null;
  private restartPendType: string | null = null;
  /** MESH-SUPPORT DUTY (the arbitration): ring-filling is a NAMED
   * exemption from the station deadband — flight-step's pattern, third
   * of its kind. Bounded: dCar 16-21 trigger, ~4-9m glide, <=2.5s,
   * cooldown, <=2 concurrent per team. */
  private readonly meshDuty = new Map<string, number>();
  private readonly meshRest = new Map<string, number>();
  /** traps: shade stickiness (defender -> locked threat) */
  private readonly shadeLock = new Map<string, string>();
  /** possession team last tick — to detect the FLIP instant and unfreeze
   * actors stuck on a stale positioning moveTo (the generalised freeze:
   * 34% of actors fail every re-eval gate at the flip because a plain
   * moveTo matches none; they finish a walk decided when the OTHER team
   * had the ball). Extends the pattern the attacking sets already use
   * (idle actors re-decide) to the transition instant. */
  private prevPossessForFlip: 'home' | 'away' | null = null;
  /** phase changes COMMIT only after persisting (the settled lesson —
   * scrum possession flips re-homed both teams several times in
   * seconds) and homes GLIDE to the new band instead of snapping
   * (every station target on the pitch jumped at once — the builder's
   * 'more chaotic now') */
  private readonly pendingPhase = new Map<'home' | 'away', { phase: string; since: number }>();
  private readonly homeTargets = new Map<string, Vec2>();

  // fitted against the EAFC envelope (~40 m both-team): each band keeps
  // a team span of ~34-44 m — the first cut stretched to 48+ and the
  // measured envelope grew to 43.5 (the bands must COMPRESS, phases
  // migrate the block, the ball-relative clamps do the fine shaping)
  private static readonly PHASE_BANDS: Record<string, [number, number]> = {
    build: [10, 52], progress: [24, 66], final: [40, 88],
    high: [34, 78], mid: [22, 60], low: [10, 44],
  };

  private updatePhases(): void {
    if (this.brains.size < 12) return;
    const cb = this.ball.carrierId ? this.byId.get(this.ball.carrierId)
      : this.intendedReceiverId ? this.byId.get(this.intendedReceiverId) : undefined;
    if (cb && !this.keepers.has(cb.id)) this.lastPossessTeam = cb.team;
    else if (cb) this.lastPossessTeam = cb.team;
    const poss = this.lastPossessTeam;
    if (!poss) return;
    for (const team of ['home', 'away'] as const) {
      const sgn = attackSign(team);
      const prog = sgn > 0 ? this.ball.pos.x : PITCH.length - this.ball.pos.x;
      const inPoss = team === poss;
      const cur = this.teamPhase.get(team);
      // thirds at 35/70 with 4 m hysteresis against the current phase
      const seq = inPoss ? (['build', 'progress', 'final'] as const) : (['low', 'mid', 'high'] as const);
      let idx = prog < 35 ? 0 : prog < 70 ? 1 : 2;
      if (cur && seq.includes(cur as never)) {
        const curIdx = seq.indexOf(cur as never);
        if (idx !== curIdx) {
          const boundary = idx > curIdx ? (curIdx === 0 ? 35 : 70) : (curIdx === 2 ? 70 : 35);
          if (Math.abs(prog - boundary) < 4) idx = curIdx; // hold inside the buffer
        }
      }
      const phase = seq[idx];
      if (phase === cur) { this.pendingPhase.delete(team); continue; }
      // persistence: the new phase must hold 15 ticks before committing
      const pend = this.pendingPhase.get(team);
      if (!pend || pend.phase !== phase) {
        this.pendingPhase.set(team, { phase, since: this.tick });
        continue;
      }
      if (this.tick - pend.since < 15) continue;
      this.pendingPhase.delete(team);
      this.teamPhase.set(team, phase);
      // re-derive this team's homes into the phase band
      const outs = this.bodies.filter((b) => b.team === team && !this.keepers.has(b.id) && this.baseHomes.has(b.id));
      if (outs.length < 7) continue;
      const us = outs.map((b) => this.baseHomes.get(b.id)!.x * sgn);
      const minU = Math.min(...us);
      const maxU = Math.max(...us);
      const span = Math.max(1, maxU - minU);
      const [t0, t1] = Sim.PHASE_BANDS[phase];
      for (const b of outs) {
        // the MANAGER'S placement outranks the derivation — anywhere on
        // the field, per phase (the rigid-formation weakness retired)
        const ov = this.phaseHomeOverrides.get(b.id)?.[phase];
        if (ov) {
          this.homeTargets.set(b.id, { x: ov.x, y: ov.y });
          continue;
        }
        const bh = this.baseHomes.get(b.id)!;
        const u = t0 + ((bh.x * sgn - minU) / span) * (t1 - t0);
        const x = Math.max(3, Math.min(PITCH.length - 3, u * sgn + (sgn > 0 ? 0 : PITCH.length)));
        this.homeTargets.set(b.id, { x, y: bh.y }); // homes GLIDE there
      }
    }
  }
  /** drill boundaries, when the scenario defines a positional grid */
  private bounds?: { x0: number; y0: number; x1: number; y1: number };
  /** last scripted atTick per body — a body with a FUTURE scripted command
   * is waiting for his cue, not idle: support must not pre-move him */
  private readonly scriptedUntil = new Map<string, number>();
  /** brains currently making an L5b run (their moveTo is the run, not a
   * script — the run re-plans at cadence) */
  private readonly runningLine = new Set<string>();
  /** the run's phase per runner: RIDE (reload at a jog, level with the
   * line) or DART (sprint diagonally across a defender's blind side into
   * the next seam — the ball is released while the runner is AT PACE) */
  private readonly runPhase = new Map<string, { phase: 'ride' | 'dart'; since: number; dartY: number; lineX: number; laneY?: number }>();
  /** tick each brain last RELEASED a pass — the one-two: a giver near the
   * line bursts immediately (the give IS his trigger; no patient ride) */
  private readonly lastGiveTick = new Map<string, number>();
  /** brains currently holding defensive shape (their moveTo is the line's,
   * re-planned at cadence — not a script) */
  private readonly shapeHolding = new Set<string>();
  /** L5d: when each team LOST possession (the counterpress window) and
   * when the current carrier claimed (the press-the-touch trigger) */
  private readonly lostPossessionAt = new Map<'home' | 'away', number>();
  private carrierSince = -1;
  /** measurement only: probes tap the carrier's live pass board */
  boardTap: ((carrierId: string, tick: number, receiverId: string, utility: number, pC?: number, kind?: string) => void) | null = null;
  /** SELF-PLAY TELEMETRY (the memory space): an optional hook the match
   * harness sets — the sim emits decision→outcome pairs (priced pass
   * completion vs what actually happened) for the calibration ledger.
   * Null in normal play; zero cost when unset. */
  public telemetry: ((ev: Record<string, unknown>) => void) | null = null;
  private openPass: { tick: number; pC?: number; dist: number; loft: number; spin: number; du: number; kicker: string; receiver: string } | null = null;
  private openCarry: { tick: number; carrier: string; density: number; startU: number } | null = null;
  /** L8-minimal restarts (match scale only): when the ball died and who
   * is awarded the put-back; claims are team-locked briefly */
  private deadSinceTick = -1;
  private restartLock: { team: 'home' | 'away'; until: number } | null = null;
  /** the designated restart taker (goal kicks belong to the KEEPER): his
   * own outfielders don't race the ball while set — the builder watched
   * a right-back win the race to his own goal kick and roll it straight
   * to the pressing striker */
  private restartTaker: string | null = null;
  private lastGoalCount = 0;
  private prevCarrierTeam: 'home' | 'away' | null = null;
  /** off-ball ATTACK brains owned by the idle branch (station/support) —
   * without this re-entry set, a body once sent to a moveTo NEVER
   * reconsidered (the m11 chaotic-positions root: stale targets forever) */
  private readonly attackIdle = new Set<string>();
  private readonly homeCentroids = new Map<string, { x: number; y: number }>();
  private teamBrainCount(team: string): number {
    let n = 0;
    for (const id of this.brains) if (this.byId.get(id)!.team === team) n++;
    return n;
  }
  private teamCentroid(team: string): { x: number; y: number } {
    let c = this.homeCentroids.get(team);
    if (!c) {
      let cx = 0; let cy = 0; let n = 0;
      for (const id of this.brains) {
        const b = this.byId.get(id)!;
        if (b.team !== team) continue;
        const h = this.homes.get(id);
        if (!h) continue;
        cx += h.x; cy += h.y; n++;
      }
      c = n ? { x: cx / n, y: cy / n } : { x: PITCH.length / 2, y: PITCH.width / 2 };
      this.homeCentroids.set(team, c);
    }
    return c;
  }
  /** brains currently pressing (the first-defender election's memory) */
  private readonly pressingIds = new Set<string>();
  /** defenders mid STEP-IN (attacking an opponent pass flight's line) —
   * resolved the tick the flight ends: into a press if the opponent
   * claimed at their feet, back to the block otherwise. Without the
   * lifecycle the chase persisted post-receipt (chaseBall matches no
   * defense-chain gate) and the striker ran the vacated line. */
  private readonly steppingIds = new Set<string>();
  /** the half-turn: the intended receiver's anticipated NEXT-play direction,
   * refreshed during the flight — his receive facing opens toward it */
  private readonly receiveOpenDir = new Map<string, number>();
  /** runners whose thread is in flight: they BEND onto the ball's path at
   * pace instead of turning back to meet it (the judged wrongness: a free
   * runner stopping and coming back for a ball played into his run) */
  private readonly bendReceive = new Set<string>();
  /** a decided kick waiting for the ball to come back into touch reach —
   * released ON THE NEXT TOUCH, not after a dead trap (the 1.1s gather
   * latency closed every lane the decision had correctly picked) */
  private readonly pendingKicks = new Map<string, { dest: Vec2; speedMps: number; receiverId?: string; loftDeg?: number; spin?: number; knock?: boolean; kind?: string }>();

  constructor(def: ScenarioDef, seed: string) {
    if (def.version !== 1) {
      throw new Error(`unsupported scenario version ${String((def as { version: unknown }).version)} — this build reads v1`);
    }
    this.rng = new KeyedRng(`${def.name}|${seed}`);
    if (def.halves) {
      this.pendingKickoffTeam = 'home';
      this.halfTick = Math.floor(def.durationTicks / 2);
    }
    this.bodies = def.bodies.map((b) => ({
      id: b.id,
      team: b.team,
      attributes: { ...b.attributes },
      pos: { ...b.pos },
      vel: { x: 0, y: 0 },
      speed: 0,
      keeper: b.keeper === true,
      facing: b.facing ?? (b.pos.x <= 52.5 ? 0 : Math.PI),
      regime: 'walk',
      stance: 'settled',
      command: { type: 'hold' },
      pathIndex: 0,
      arrived: true,
      arrivedAtTick: 0,
    }));
    for (const b of this.bodies) {
      if (this.byId.has(b.id)) throw new Error(`duplicate body id ${b.id}`);
      this.byId.set(b.id, b);
      this.queues.set(b.id, []);
    }
    for (const b of def.bodies) {
      if (b.brain === 'onBall') this.brains.add(b.id);
      if (b.keeper) this.keepers.add(b.id);
      if (b.instructions) this.instructions.set(b.id, { ...b.instructions });
      this.homes.set(b.id, { ...b.pos });
      this.baseHomes.set(b.id, { ...b.pos });
      if (b.phaseHomes) this.phaseHomeOverrides.set(b.id, b.phaseHomes);
    }
    for (const ev of def.script) {
      const body = this.byId.get(ev.bodyId);
      if (!body) throw new Error(`script references unknown body ${ev.bodyId}`);
      if ('atTick' in ev) {
        const list = this.atTick.get(ev.atTick) ?? [];
        list.push({ bodyId: ev.bodyId, command: ev.command });
        this.atTick.set(ev.atTick, list);
        this.scriptedUntil.set(ev.bodyId, Math.max(this.scriptedUntil.get(ev.bodyId) ?? -1, ev.atTick));
      } else {
        this.queues.get(ev.bodyId)!.push(ev.command);
      }
    }
    for (const k of def.kicks ?? []) {
      if (!this.byId.has(k.bodyId)) throw new Error(`kick references unknown body ${k.bodyId}`);
      const list = this.kicksAt.get(k.atTick) ?? [];
      list.push({ bodyId: k.bodyId, kick: k.kick });
      this.kicksAt.set(k.atTick, list);
    }
    this.bounds = def.bounds;
    const carrier = def.ball?.carrier ? this.byId.get(def.ball.carrier) : undefined;
    if (def.ball?.carrier && !carrier) throw new Error(`ball.carrier references unknown body ${def.ball.carrier}`);
    this.ball = {
      pos: carrier ? { ...carrier.pos } : { ...(def.ball?.pos ?? { x: PITCH.length / 2, y: PITCH.width / 2 }) },
      z: 0,
      vel: { x: 0, y: 0 },
      vz: 0,
      spin: 0,
      phase: carrier ? 'carried' : 'rolling',
      carrierId: carrier ? carrier.id : null,
      kickerId: null,
      kickerLockUntilTick: 0,
      touchParity: false,
    };
  }

  /** advance one tick; returns the full-rate frame for it */
  step(): Frame {
    // HALF-TIME: the whistle, then the other team's kickoff ceremony
    if (this.halfTick > 0 && this.tick === this.halfTick && this.half === 1) {
      this.half = 2;
      this.ball.phase = 'dead';
      this.ball.carrierId = null;
      this.ball.vel = { x: 0, y: 0 };
      this.ball.vz = 0;
      this.ball.z = 0;
      this.pendingKickoffTeam = 'away';
      this.bannerText = 'HALF-TIME';
      this.restartTaker = null;
      this.restartType = null;
      this.restartPenalty = false;
      this.restartLock = null;
      this.wallSpots.clear();
      this.pendingFreeKick = null;
      this.telemetry?.({ t: 'half', tick: this.tick });
    }
    // the OPENING kickoff: the match starts dead at the centre
    if (this.pendingKickoffTeam && this.tick === 0) {
      this.ball.phase = 'dead';
      this.ball.carrierId = null;
      this.ball.vel = { x: 0, y: 0 };
    }
    // action labels are per-tick — clear them up front so brain-less scenarios
    // (which skip decidePhase) don't carry a stale header/block/handball label
    this.actionLabels.clear();
    this.attackClaims.get('home')!.length = 0;
    this.attackClaims.get('away')!.length = 0;
    // 0. PERCEPTION: refresh every brain's last-seen picture (cone +
    // peripheral + the awareness-paced scan) before any decisions read it
    this.updatePerception();
    // 0b. PHASES: the six-phase homes follow possession and territory
    this.updatePhases();
    // 0c. FLIP UNFREEZE (the possession-flip freeze, 34%): at the instant
    // possession changes, an actor on a stale positioning moveTo (in NO
    // re-eval set — the freeze condition) is set to HOLD, which the idle
    // branches pick up next tick to re-decide his station for the NEW
    // possession state. Actively-engaged actors (pressing, stepping,
    // racing the ball, the carrier/receiver) keep their commitment.
    if (this.brains.size >= 12 && this.lastPossessTeam && this.lastPossessTeam !== this.prevPossessForFlip) {
      this.lastFlipTick = this.tick;
      for (const id of this.brains) {
        const b = this.byId.get(id)!;
        if (b.command.type !== 'moveTo') continue;
        if (this.pressingIds.has(id) || this.steppingIds.has(id) ||
          this.ball.carrierId === id || this.intendedReceiverId === id ||
          this.tick <= (this.scriptedUntil.get(id) ?? -1)) continue;
        // in an active set? then he is already re-deciding — leave him
        if (this.shapeHolding.has(id) || this.runningLine.has(id) || this.attackIdle.has(id)) continue;
        this.assign(b, { type: 'hold' });
      }
    }
    this.prevPossessForFlip = this.lastPossessTeam;
    // ...gliding, not snapping (6%/tick ≈ settled in ~3 s)
    for (const [hid, tgt] of this.homeTargets) {
      const h = this.homes.get(hid);
      if (!h) continue;
      const dx = tgt.x - h.x;
      const dy = tgt.y - h.y;
      if (Math.abs(dx) + Math.abs(dy) < 0.3) { this.homes.set(hid, tgt); this.homeTargets.delete(hid); continue; }
      this.homes.set(hid, { x: h.x + dx * 0.06, y: h.y + dy * 0.06 });
    }
    // 1. scripted re-targets (replace the current command, keep the queue)
    const events = this.atTick.get(this.tick);
    if (events) {
      for (const ev of events) this.assign(this.byId.get(ev.bodyId)!, ev.command);
    }

    // 1b. L4 — the on-ball decision loop (after scripts: a scripted re-target
    // on a brainless body stands; the carrier's OWN command is decision-owned)
    this.decidePhase();

    // 1c. L7 — keepers self-position on the ball–goal line (after decide so a
    // keeper with the ball at his feet is decision- or script-owned that tick)
    if (this.keeperHolding && this.ball.carrierId !== this.keeperHolding) this.keeperHolding = null;
    if (this.restartTaker && (this.ball.carrierId !== null ||
      this.ball.kickerId === this.restartTaker)) {
      // the taker has it (or already played it — the quick free kick:
      // claim and first-time pass land in one tick, and resolving only
      // on carrier-sight left the lock up with the taker's own receiver
      // barred from the ball) — the ceremony resolves
      // THE SET-PIECE MENU (manager hooks: freeKickStyle / cornerStyle /
      // setPieceTaker): penalties strike, close central free kicks shoot
      // over the retreated nine meters, wide advanced ones cross into
      // the assembled box, deep ones go long or play short to the brain
      let gkWaits = false;
      let fkWaits = false;
      if (this.ball.carrierId === this.restartTaker &&
        (this.restartType === 'corner' || this.restartType === 'free-kick')) {
        const tk = this.byId.get(this.restartTaker)!;
        const style = this.restartType === 'corner'
          ? (this.instructions.get(tk.id)?.cornerStyle ?? 'cross')
          : (this.instructions.get(tk.id)?.freeKickStyle ?? 'auto');
        const g = goalCenter(tk.team);
        const dGoal = Math.hypot(g.x - tk.pos.x, g.y - tk.pos.y);
        const central = Math.abs(tk.pos.y - PITCH.width / 2) <= 18;
        const opps2 = this.bodies.filter((o2) => o2.team !== tk.team);
        // the best BOX target for a delivery, if any mate is assembled
        let boxMate: { m: BodyState; pC: number } | null = null;
        for (const m of this.bodies) {
          if (m.team !== tk.team || m.id === tk.id || this.sentOff.has(m.id)) continue;
          if (Math.hypot(g.x - m.pos.x, g.y - m.pos.y) > 22) continue;
          const landing = { x: m.pos.x + m.vel.x * 0.5, y: m.pos.y + m.vel.y * 0.5 };
          const pC = aerialCompletion(landing, m, opps2);
          if (!boxMate || pC > boxMate.pC) boxMate = { m, pC };
        }
        let act: 'shot' | 'cross' | 'long' | 'short' = 'short';
        if (this.restartPenalty) act = 'shot';
        else if (this.restartType === 'corner') act = style === 'short' ? 'short' : (boxMate ? 'cross' : 'short');
        else if (style === 'shoot' || (style === 'auto' && dGoal <= 26 && central)) act = 'shot';
        else if ((style === 'cross' || (style === 'auto' && dGoal <= 45)) && boxMate) act = 'cross';
        else if (style === 'long') act = 'long';
        // THE CEREMONIED KICK WAITS (the goal kick's sibling): a shot-
        // or cross-class free kick and every penalty defer until the
        // retreat is SATISFIED (9.15 m; the area+arc for penalties)
        // plus the same scaled dwell floor (6 s / cap 14 s). QUICK
        // classes (short, deep long) stay exempt BY LAW — a taker may
        // legally play before the wall sets; that class already lives
        // in this engine and is not sacrificed to fix the ceremony.
        if (this.restartType === 'free-kick' && (act === 'shot' || act === 'cross' || this.restartPenalty)) {
          let violator = false;
          const nearHomeP = tk.pos.x < PITCH.length / 2;
          for (const b of this.bodies) {
            if (b.id === tk.id || this.sentOff.has(b.id)) continue;
            if (this.restartPenalty) {
              if (this.keepers.has(b.id)) continue;
              const inBoxP = (nearHomeP ? b.pos.x < GOAL.boxDepthM + 0.3 : b.pos.x > PITCH.length - GOAL.boxDepthM - 0.3) &&
                Math.abs(b.pos.y - PITCH.width / 2) < GOAL.boxHalfWidthM + 0.3;
              if (inBoxP || Math.hypot(b.pos.x - this.ball.pos.x, b.pos.y - this.ball.pos.y) < 9.15 - 0.5) { violator = true; break; }
            } else if (b.team !== tk.team &&
              Math.hypot(b.pos.x - this.ball.pos.x, b.pos.y - this.ball.pos.y) < 9.15 - 0.5) { violator = true; break; }
          }
          const pendAgeF = this.tick - (this.restartPendSince ?? this.tick);
          if (pendAgeF < 140 && (violator || pendAgeF < 60)) {
            fkWaits = true;
            this.intents.delete(tk.id);
            this.pendingKicks.delete(tk.id);
            if (tk.command.type !== 'hold') this.assign(tk, { type: 'hold' });
          }
        }
        if (!fkWaits && act === 'shot') {
          const yOff = (this.rng.chance(0.5, this.tick, tk.id, 'sp-side') ? 1 : -1) *
            (GOAL.mouthHalfWidthM - 0.6);
          kickBall(this.ball, { x: g.x, y: g.y + yOff },
            this.restartPenalty ? 22 : 23, this.restartPenalty ? 6 : 12, tk.id, this.tick);
          this.actionLabels.set(tk.id, this.restartPenalty ? 'penalty' : 'fk-shot');
        } else if (!fkWaits && act === 'cross' && boxMate) {
          const lead = { x: boxMate.m.pos.x + boxMate.m.vel.x * 0.5, y: boxMate.m.pos.y + boxMate.m.vel.y * 0.5 };
          const dC = Math.hypot(lead.x - tk.pos.x, lead.y - tk.pos.y);
          kickBall(this.ball, lead, Math.min(26, solveLoftSpeed(dC, 23)), 23, tk.id, this.tick);
          this.intendedReceiverId = boxMate.m.id;
          if (this.restartType === 'corner') this.offsideExemptTick = this.tick; // the law's own rule
          this.actionLabels.set(tk.id, this.restartType === 'corner' ? 'corner-cross' : 'fk-cross');
        } else if (!fkWaits && act === 'long') {
          let far: { m: BodyState; score: number } | null = null;
          const sgnT = attackSign(tk.team);
          for (const m of this.bodies) {
            if (m.team !== tk.team || m.id === tk.id || this.sentOff.has(m.id)) continue;
            const dm = Math.hypot(m.pos.x - tk.pos.x, m.pos.y - tk.pos.y);
            if (dm < 25 || dm > 50) continue;
            let free = Infinity;
            for (const o2 of opps2) free = Math.min(free, Math.hypot(o2.pos.x - m.pos.x, o2.pos.y - m.pos.y));
            const score = sgnT * (m.pos.x - tk.pos.x) * 0.02 + Math.min(1, free / 10);
            if (!far || score > far.score) far = { m, score };
          }
          if (far) {
            const dm = Math.hypot(far.m.pos.x - tk.pos.x, far.m.pos.y - tk.pos.y);
            kickBall(this.ball, { x: far.m.pos.x, y: far.m.pos.y }, Math.min(27, solveLoftSpeed(dm, 20)), 20, tk.id, this.tick);
            this.intendedReceiverId = far.m.id;
            this.actionLabels.set(tk.id, 'fk-long');
          }
        }
        // act === 'short': leave the ball with the taker's brain
      }
      // KICKOFF RULE (builder): the taker must PASS — the classic tap
      // back to a teammate, never a solo carry off the spot
      if (this.ball.carrierId === this.restartTaker && this.restartType === 'goal-kick') {
        // THE RESTART WAITS (findings A+B): legality is REACHED, not
        // raced — the kick is deferred until no opponent stands in
        // the box AND the dwell floor has passed. The pin can now
        // assert legality AT THE KICK instead of vacuous grace.
        const tkW = this.byId.get(this.restartTaker)!;
        const nearHomeW = tkW.pos.x < PITCH.length / 2;
        let boxOccupied = false;
        for (const b of this.bodies) {
          if (b.team === tkW.team || this.sentOff.has(b.id)) continue;
          if ((nearHomeW ? b.pos.x < GOAL.boxDepthM + 0.5 : b.pos.x > PITCH.length - GOAL.boxDepthM - 0.5) &&
            Math.abs(b.pos.y - PITCH.width / 2) < GOAL.boxHalfWidthM + 0.5) { boxOccupied = true; break; }
        }
        const pendAge = this.tick - (this.restartPendSince ?? this.tick);
        if (pendAge < 140 && (boxOccupied || pendAge < 60)) {
          gkWaits = true;
          if (tkW.command.type !== 'hold') this.assign(tkW, { type: 'hold' });
        }
      }
      if (!gkWaits && this.ball.carrierId === this.restartTaker && this.restartType === 'goal-kick') {
        // THE GOAL KICK IS KICKED (watch-6, ticks 815+): the ceremony
        // had branches for corner/free-kick/kickoff/throw-in and NONE
        // for the goal kick — the keeper coupled the dead ball, fell
        // through to open play, and picked it up into his hands
        // (procedurally illegal at a kicked restart; retention itself
        // was fine at 81%). The strike reuses his ground menu: short
        // to an unmarked mate when one exists, else the driven ping
        // upfield.
        const tk = this.byId.get(this.restartTaker)!;
        let mate: BodyState | null = null;
        let bd2 = 0;
        let bestScore2 = 0.12;
        const opps3 = this.bodies.filter((o) => o.team !== tk.team);
        for (const m of this.bodies) {
          if (m.team !== tk.team || m.id === tk.id || this.keepers.has(m.id) || this.sentOff.has(m.id)) continue;
          const dm = Math.hypot(m.pos.x - tk.pos.x, m.pos.y - tk.pos.y);
          if (dm > 45 || dm < 8) continue;
          // the distribution menu's own currency: completion x worth
          // (iteration 1 chose nearest-unmarked with no lane pricing and
          // retention collapsed 81 -> 42)
          const spd2 = Math.max(8, Math.min(19, rollLaunchForArrival(5, dm)));
          const pC2 = passCompletion(tk.pos, m.pos, spd2, opps3, dm, m, 13);
          if (pC2 < 0.55) continue;
          const score2 = pC2 * (0.12 + posValue(m.pos, tk.team));
          if (score2 > bestScore2) { bestScore2 = score2; mate = m; bd2 = dm; }
        }
        if (mate) {
          const lead = { x: mate.pos.x + mate.vel.x * 0.4, y: mate.pos.y + mate.vel.y * 0.4 };
          const dm = bd2;
          if (dm > 30) kickBall(this.ball, lead, solveLoftSpeed(Math.max(6, dm - 5), 16), 16, tk.id, this.tick);
          else if (dm > 20) kickBall(this.ball, lead, 26, 5, tk.id, this.tick);
          else kickBall(this.ball, lead, Math.max(8, Math.min(19, rollLaunchForArrival(5, dm))), 0, tk.id, this.tick);
          this.intendedReceiverId = mate.id;
        } else {
          const sgnT = attackSign(tk.team);
          const upAng = (sgnT > 0 ? 0 : Math.PI) + this.rng.gauss(0, 0.25, this.tick, tk.id, 'gk-long');
          kickBall(this.ball, { x: tk.pos.x + Math.cos(upAng) * 45, y: tk.pos.y + Math.sin(upAng) * 45 },
            solveLoftSpeed(45, 16), 16, tk.id, this.tick);
        }
        this.actionLabels.set(tk.id, 'goal-kick');
      }
      if (this.ball.carrierId === this.restartTaker && this.restartType === 'kickoff') {
        const tk0 = this.byId.get(this.restartTaker)!;
        let near: { m: BodyState; d: number } | null = null;
        for (const m of this.bodies) {
          if (m.team !== tk0.team || m.id === tk0.id || this.keepers.has(m.id) || this.sentOff.has(m.id)) continue;
          const dm = Math.hypot(m.pos.x - tk0.pos.x, m.pos.y - tk0.pos.y);
          if (dm < 2 || dm > 30) continue;
          // prefer the man BEHIND the spot (the tap back)
          const behind0 = attackSign(tk0.team) * (m.pos.x - tk0.pos.x) < 0 ? 0 : 8;
          if (!near || dm + behind0 < near.d) near = { m, d: dm + behind0 };
        }
        if (near) {
          kickBall(this.ball, { x: near.m.pos.x, y: near.m.pos.y },
            Math.max(7, Math.min(12, rollLaunchForArrival(4, Math.hypot(near.m.pos.x - tk0.pos.x, near.m.pos.y - tk0.pos.y)))), 0, tk0.id, this.tick);
          this.intendedReceiverId = near.m.id;
          this.actionLabels.set(tk0.id, 'kickoff');
        }
      }
      if (this.ball.carrierId === this.restartTaker && this.restartType === 'throw-in') {
        // the THROW-IN FORM: two-handed, released above the head, to the
        // best near mate — and offside-exempt (the law's own rule)
        const tk = this.byId.get(this.restartTaker)!;
        let bestM: { m: BodyState; score: number } | null = null;
        for (const m of this.bodies) {
          if (m.team !== tk.team || m.id === tk.id || this.sentOff.has(m.id)) continue;
          const dm = Math.hypot(m.pos.x - tk.pos.x, m.pos.y - tk.pos.y);
          if (dm < 3 || dm > 22) continue;
          let free = Infinity;
          for (const o2 of this.bodies) {
            if (o2.team === tk.team) continue;
            free = Math.min(free, Math.hypot(o2.pos.x - m.pos.x, o2.pos.y - m.pos.y));
          }
          const score = Math.min(1, free / 8) - dm * 0.015;
          if (!bestM || score > bestM.score) bestM = { m, score };
        }
        if (bestM) {
          const lead = { x: bestM.m.pos.x + bestM.m.vel.x * 0.4, y: bestM.m.pos.y + bestM.m.vel.y * 0.4 };
          const dT = Math.hypot(lead.x - tk.pos.x, lead.y - tk.pos.y);
          kickBall(this.ball, lead, Math.max(8, Math.min(14, rollLaunchForArrival(5, dT))), 16, tk.id, this.tick);
          this.ball.z = 2.1; // released above the head
          this.intendedReceiverId = bestM.m.id;
          this.offsideExemptTick = this.tick;
          this.actionLabels.set(tk.id, 'throw-in');
        }
      }
      if (!gkWaits && !fkWaits) {
        this.restartTaker = null;
        this.restartType = null;
        this.restartPenalty = false;
        this.restartLock = null;
        this.goalKickPending = null;
        this.wallSpots.clear();
        this.bannerText = null;
      }
    }
    if (this.keeperDropPass && this.ball.carrierId !== this.keeperDropPass.keeperId) this.keeperDropPass = null;
    if (this.beatExec && this.ball.carrierId !== this.beatExec.carrierId) this.beatExec = null;
    this.keeperPhase();

    // 2. bodies move; chaseBall runs to the INTERCEPT point (players
    // anticipate where a ball is going, they don't chase its tail), and a
    // carrier whose touch ran beyond reach STEERS to fetch it — the route is
    // the intent, the ball is the path
    // loose-ball claimant election (L5E arbitration)
    if (this.ball.carrierId === null && this.ball.phase !== 'dead') {
      for (const team of ['home', 'away'] as const) {
        let best: { id: string; score: number } | null = null;
        for (const b2 of this.bodies) {
          if (b2.team !== team || b2.command.type !== 'chaseBall') continue;
          const sc = Math.hypot(this.ball.pos.x - b2.pos.x, this.ball.pos.y - b2.pos.y) /
            Math.max(regimeCapMps(b2.attributes.pace, 'sprint'), 1);
          if (!best || sc < best.score) best = { id: b2.id, score: sc };
        }
        const cur = this.looseClaimant.get(team);
        if (!best) this.looseClaimant.delete(team);
        else if (!cur || cur.id === best.id ||
          !this.bodies.some((b2) => b2.id === cur.id && b2.command.type === 'chaseBall') ||
          best.score < cur.score - 0.3) {
          this.looseClaimant.set(team, best);
        } else {
          // the incumbent holds — refresh his score
          const inc = this.bodies.find((b2) => b2.id === cur.id)!;
          this.looseClaimant.set(team, {
            id: cur.id,
            score: Math.hypot(this.ball.pos.x - inc.pos.x, this.ball.pos.y - inc.pos.y) /
              Math.max(regimeCapMps(inc.attributes.pace, 'sprint'), 1),
          });
        }
      }
    } else {
      this.looseClaimant.clear();
    }
    this.liveTargets.clear();
    this.supportSides.clear();
    this.prevPos.clear();
    for (const body of this.bodies) {
      this.prevPos.set(body.id, { x: body.pos.x, y: body.pos.y });
    }
    // 2-pre: CONTACT DAMPING (the m11 scrum: steering re-created closing
    // velocity every tick faster than the bounded resolver drained it, and
    // pairs ground along merged for ticks) — bodies already in contact
    // lose their into-contact velocity BEFORE the step, so re-entry is one
    // tick of acceleration, which the resolver clears trivially.
    {
      const touchSep = TECH.bodyRadiusM * 2 + 0.1;
      for (let i = 0; i < this.bodies.length; i++) {
        for (let j = i + 1; j < this.bodies.length; j++) {
          const a = this.bodies[i];
          const b = this.bodies[j];
          const dx = b.pos.x - a.pos.x;
          const dy = b.pos.y - a.pos.y;
          const d = Math.hypot(dx, dy);
          if (d >= touchSep || d < 1e-9) continue;
          const nx = dx / d;
          const ny = dy / d;
          const closing = (a.vel.x - b.vel.x) * nx + (a.vel.y - b.vel.y) * ny;
          if (closing > 0) {
            a.vel = { x: a.vel.x - nx * closing * 0.5, y: a.vel.y - ny * closing * 0.5 };
            b.vel = { x: b.vel.x + nx * closing * 0.5, y: b.vel.y + ny * closing * 0.5 };
            a.speed = Math.hypot(a.vel.x, a.vel.y);
            b.speed = Math.hypot(b.vel.x, b.vel.y);
          }
        }
      }
    }
    for (const body of this.bodies) {
      const isCarrier = this.ball.carrierId === body.id;
      const gap = isCarrier
        ? Math.hypot(this.ball.pos.x - body.pos.x, this.ball.pos.y - body.pos.y)
        : 0;
      const fetching = isCarrier && gap > BALL.controlRadiusM &&
        body.command.type !== 'chaseBall' && body.command.type !== 'hold';
      let live: Vec2 | undefined;
      let standing = false;
      let timedCap: number | undefined;
      let brakeIntoLine = false;
      let duelFace: Vec2 | undefined; // the jockey squares to the ball
      // machine OWNERSHIP (the principles pass): the elected presser
      // belongs to the duel machine FROM ELECTION — approach, ride, engage
      // as one continuum. The chaseBall gate parked the approaching presser
      // in moveTo where the machine never rode him (the covered-duel hole);
      // now the machine speaks per tick and the moveTo is only the
      // fallback when it stays silent (out of duel range).
      const duelRide = body.command.type !== 'chaseBall' && !fetching && !isCarrier &&
        this.pressingIds.has(body.id) && !this.keepers.has(body.id) &&
        this.ball.carrierId !== null && this.byId.get(this.ball.carrierId)!.team !== body.team;
      if (body.command.type === 'chaseBall' || fetching || duelRide) {
        const icept = this.interceptPoint(body);
        live = duelRide ? undefined : icept.pMeet;
        // the RECEIVE state machine (judged over eight rounds):
        //  off the line → attack the nearest path point (toward the ball),
        //    braking in when receiving; STICKY phase boundary — a threshold
        //    without hysteresis flapped the target every tick (the judged
        //    rapid right-left-right);
        //  on the line, ball near → STEP AT THE BALL for the final stride
        //    (standing a meter off, waiting, is not how touches are taken);
        //  on the line, ball still far → time the meet, set, watch it in.
        if (body.command.type === 'chaseBall') {
          // CONTESTED chases are RACES: an opponent carries the ball or is
          // hunting it too — sprint to be first, no timing, no final-stride
          // politeness (the receive machine cost the knock-past attacker
          // his race). Uncontested chases RECEIVE.
          const contested =
            (this.ball.carrierId !== null && this.byId.get(this.ball.carrierId)!.team !== body.team) ||
            this.bodies.some((o) => o.id !== body.id && o.team !== body.team && o.command.type === 'chaseBall');
          if (contested) {
            // race mode: run flat-out at the meet point (contain below still
            // takes over at contact range against a glued carrier). With the
            // ball ON TOP of him, step AT it — the 0.3 s reaction margin
            // makes imminent meets "unreachable" and pMeet jumps deep,
            // carving the racer off the line as the ball arrives at his feet
            this.receiveOnLine.delete(body.id);
            const dBall = Math.hypot(this.ball.pos.x - body.pos.x, this.ball.pos.y - body.pos.y);
            if (dBall <= 2.5) {
              live = { x: this.ball.pos.x, y: this.ball.pos.y };
            } else {
              live = icept.pMeet;
              // racing a LOOSE ball to the meet point: SET at it only when
              // COMFORTABLY early (momentum blew an early racer through the
              // line; but braking on marginal meets made lane-chasers
              // stutter under passes that beat them anyway). Chasers of a
              // CARRIED ball keep flying — braking gave them a
              // set-defender's pinch and broke the judged duel.
              if (this.ball.carrierId === null) {
                const dMeet = Math.hypot(icept.pMeet.x - body.pos.x, icept.pMeet.y - body.pos.y);
                const vcap = Math.max(regimeCapMps(body.attributes.pace, body.command.regime), 0.5);
                if (dMeet / vcap < icept.tMeet - 0.35) brakeIntoLine = true;
              }
            }
          } else if (this.bendReceive.has(body.id) && this.bendMeet(body)) {
            // a RUNNER receives ON THE RUN: bend (≤~70°) onto the ball's
            // path ahead at pace — never stop, never turn back for a ball
            // played into the run (hold-up is a pressured behavior)
            live = this.bendMeet(body)!;
            this.receiveOnLine.delete(body.id);
          } else if (this.inStrideMeet(body)) {
            // the RUNNER'S receive: his continued run meets the ball — take
            // it in stride, no timing, no brake (the judged check-and-wait:
            // the receiver anticipated at the meet point and the through
            // ball ran on behind him). Self-selecting: if full pace along
            // the current run does NOT meet the ball, the machine below
            // times it as before.
            live = this.inStrideMeet(body)!;
            this.receiveOnLine.delete(body.id);
          } else {
            let onLine = this.receiveOnLine.get(body.id) ?? false;
            if (!onLine && icept.lineDist <= 1.2) onLine = true;
            else if (onLine && icept.lineDist > 1.8) onLine = false;
            this.receiveOnLine.set(body.id, onLine);
            if (!onLine) {
              live = icept.pNear;
              // brake in when the meet is still ahead in TIME — or when the
              // ball is (near-)static: tNear is meaningless for a waiting
              // ball (first scan sample), and charging a sitting ball at
              // full speed was the judged 2.75 m overrun-and-return
              const ballV = Math.hypot(this.ball.vel.x, this.ball.vel.y);
              if (icept.tNear > 0.5 || ballV < 1.0) brakeIntoLine = true;
            } else if (icept.tMeet <= 1.2) {
              // the final stride: step INTO the arriving ball — aimed at the
              // CROSSING point nudged up-line (aiming at the ball's current
              // spot left a noisy pass's lateral gap unclosed: a judged
              // 3 cm miss at closest approach)
              const ux = this.ball.pos.x - icept.pNear.x;
              const uy = this.ball.pos.y - icept.pNear.y;
              const un = Math.hypot(ux, uy) || 1;
              live = { x: icept.pNear.x + (ux / un) * 0.5, y: icept.pNear.y + (uy / un) * 0.5 };
              timedCap = 2.4;
            } else {
              // EARLY on the line: COME TO the ball — advance along the path
              // toward it at a controlled pace. Timing the meet (slow, set,
              // stand, watch it in) was the judged wait-for-it-backwards: a
              // receiver shortens the pass, he doesn't spectate it. The final
              // stride above takes over as the ball arrives.
              const ux = this.ball.pos.x - body.pos.x;
              const uy = this.ball.pos.y - body.pos.y;
              const un = Math.hypot(ux, uy) || 1;
              live = { x: body.pos.x + (ux / un) * 2.0, y: body.pos.y + (uy / un) * 2.0 };
              timedCap = 2.4; // controlled — meeting a pass is not charging it
            }
          }
        }
        // loose-ball SUPPORT (L5E arbitration): the non-claimant does not
        // race his own mate onto the ball — he takes an offset spot to the
        // side, an outlet instead of a second pair of feet in the same yard
        if (body.command.type === 'chaseBall' && this.ball.carrierId === null) {
          const cl = this.looseClaimant.get(body.team);
          if (cl && cl.id !== body.id) {
            const claimant = this.byId.get(cl.id);
            if (claimant) {
              const lx = this.ball.pos.x - claimant.pos.x;
              const ly = this.ball.pos.y - claimant.pos.y;
              const ln = Math.hypot(lx, ly) || 1;
              // the side of the claimant→ball line this supporter is on
              const sside = Math.sign(-(body.pos.x - claimant.pos.x) * (ly / ln) +
                (body.pos.y - claimant.pos.y) * (lx / ln)) || 1;
              const dClaim = Math.hypot(body.pos.x - claimant.pos.x, body.pos.y - claimant.pos.y);
              let off = dClaim < 1.8 ? 6 : 4; // stacked bodies separate harder
              // DISTINCT spots: the second supporter on the same natural side
              // flips; a third extends — no twin runs
              const taken = this.supportSides.get(body.team) ?? [];
              let useSide = sside;
              if (taken.includes(useSide)) {
                if (!taken.includes(-useSide)) useSide = -useSide;
                else off += 3.5;
              }
              taken.push(useSide);
              this.supportSides.set(body.team, taken);
              live = {
                x: this.ball.pos.x - (ly / ln) * useSide * off,
                y: this.ball.pos.y + (lx / ln) * useSide * off,
              };
            }
          }
        }
        // the DUEL (L5E) wraps the judged contain: RECOVER/JOCKEY/TRACK own
        // the 2–8 m shell; ENGAGE commits the close; and inside 1.9 m the
        // contain-at-contact (the 360-orbit fix) stands exactly as judged.
        if ((body.command.type === 'chaseBall' || duelRide) && this.ball.carrierId !== null && !isCarrier) {
          const carrierB = this.byId.get(this.ball.carrierId)!;
          const gapBC = Math.hypot(this.ball.pos.x - carrierB.pos.x, this.ball.pos.y - carrierB.pos.y);
          const dToCar = Math.hypot(body.pos.x - carrierB.pos.x, body.pos.y - carrierB.pos.y);
          const containing = this.containBearing.has(body.id);
          // hysteresis: enter the press close-in, leave only when knocked
          // well out — a single threshold FLAPS (charge → bounce → charge),
          // thrashing a rotating bearing (the judged 360°)
          const contact = gapBC <= BALL.controlRadiusM && (dToCar <= 1.9 || (containing && dToCar <= 2.6));
          // activation LEADS the closing: a carrier driving AT this defender
          // extends the duel range by his closing speed — the defender starts
          // dropping early and meets him already moving goalward, never
          // flat-footed or stepping INTO a full-pace attacker
          const toMe0X = (body.pos.x - carrierB.pos.x) / Math.max(dToCar, 1e-6);
          const toMe0Y = (body.pos.y - carrierB.pos.y) / Math.max(dToCar, 1e-6);
          const closing0 = carrierB.vel.x * toMe0X + carrierB.vel.y * toMe0Y;
          const inDuel = carrierB.team !== body.team && !this.keepers.has(body.id) &&
            dToCar <= DUEL.activeRangeM + Math.max(0, closing0) * DUEL.activeCloseGainS;
          // the STAGGER outranks everything — a planted man is planted, even
          // in contact range (the contain was bypassing the beaten moment)
          const st0 = this.duels.get(body.id);
          if (st0?.state === 'staggered' && this.tick < (st0.plantedUntil ?? 0)) {
            standing = true;
            live = undefined;
            this.containBearing.delete(body.id);
          } else if (contact) {
            // contact IS engagement — promote the record so the tackle gate
            // opens (a stale jockey record was blocking tackles forever) —
            // unless he is in the BEATEN window (shadow, no lunge)
            const dr = this.duels.get(body.id);
            if (dr && this.tick >= (dr.beatenUntil ?? 0)) { dr.state = 'engage'; this.duels.set(body.id, dr); }
            let bearing = this.containBearing.get(body.id);
            if (bearing === undefined) {
              bearing = Math.atan2(body.pos.y - carrierB.pos.y, body.pos.x - carrierB.pos.x);
              this.containBearing.set(body.id, bearing);
            }
            // press point relative to the CARRIER, clear of his collision
            // disc — clipping it creeps the presser around tangentially
            const hold = TECH.bodyRadiusM * 2 + 0.35;
            live = { x: carrierB.pos.x + Math.cos(bearing) * hold, y: carrierB.pos.y + Math.sin(bearing) * hold };
            // at the press point: STAND (stop without completing the chase)
            if (Math.hypot(body.pos.x - live.x, body.pos.y - live.y) <= 0.45) standing = true;
          } else {
            this.containBearing.delete(body.id);
            if (inDuel) {
              const duel = this.duels.get(body.id) ?? { state: 'jockey' as const, pressure: 0, goalSide: false };
              if (duel.state === 'staggered') {
                if (this.tick < (duel.plantedUntil ?? 0)) {
                  standing = true; // planted — beaten, and it must cost
                  live = undefined;
                  this.duels.set(body.id, duel);
                } else {
                  duel.state = duel.goalSide ? 'jockey' : 'recover';
                  duel.pressure = 0;
                }
              }
              if (duel.state !== 'staggered') {
              const ownG = { x: attackSign(body.team) > 0 ? 0 : PITCH.length, y: GOAL.centerY };
              const gdC = Math.hypot(carrierB.pos.x - ownG.x, carrierB.pos.y - ownG.y);
              const gdD = Math.hypot(body.pos.x - ownG.x, body.pos.y - ownG.y);
              // side hysteresis: gain the side clearly, lose it only clearly
              duel.goalSide = duel.goalSide
                ? gdD <= gdC + DUEL.goalSideExitM
                : gdD <= gdC - DUEL.goalSideEnterM;
              // the patience meter — waiting is hoping for support; a
              // STOPPED carrier invites the lunge; cover behind emboldens
              let fill = DT / DUEL.pressureFillS;
              if (carrierB.speed < 0.8) fill *= DUEL.pressureStoppedFactor;
              // a carrier DRIVING AT YOUR GOAL cannot be waited out — urgency
              // scales with his goalward closing speed
              const gwSp = (carrierB.vel.x * (ownG.x - carrierB.pos.x) + carrierB.vel.y * (ownG.y - carrierB.pos.y)) / Math.max(gdC, 1e-6);
              fill *= 1 + Math.max(0, gwSp) / 3;
              if (this.bodies.some((m) => m.team === body.team && m.id !== body.id &&
                Math.hypot(m.pos.x - carrierB.pos.x, m.pos.y - carrierB.pos.y) < DUEL.dCoverM)) {
                fill *= DUEL.pressureSupportFactor;
              }
              duel.pressure = Math.min(1, duel.pressure + fill);
              // counterpress is innate aggression — no patience
              if (this.actionLabels.get(body.id) === 'counterpress') duel.pressure = Math.max(duel.pressure, 0.9);
              // transitions
              if (duel.state === 'engage') {
                if (dToCar > DUEL.engageEscapeM) {
                  duel.state = duel.goalSide ? 'jockey' : 'recover';
                  duel.pressure = DUEL.pressureResetOnEscape;
                }
              } else if (!duel.goalSide) {
                duel.state = 'recover';
              } else if (duel.pressure >= 1 && dToCar <= DUEL.engageM &&
                this.tick >= (duel.beatenUntil ?? 0)) {
                duel.state = 'engage';
              } else if ((duel.closeTicks ?? 0) >= 3 && dToCar <= 2.4 &&
                this.tick >= (duel.beatenUntil ?? 0)) {
                // the RUNNING CHALLENGE (the escort-conversion root, the
                // queue's last item: a rider goal-side within touching
                // distance for half a second makes his play — riders DO
                // tackle at pace; waiting for the patience meter let a
                // carrier be escorted 35 m to the box)
                duel.state = 'engage';
              } else {
                // JOCKEY only while a square backpedal can hold the gap. Too
                // hot — the carrier escaping at pace OR closing faster than
                // ~3 m/s (a taxed backpedal is ~2-2.5) — and the hips TURN:
                // TRACK, running the give-ground line at full speed, squaring
                // up again when the closing calms. That alternation IS the
                // visible jockey dance.
                const toMeX = (body.pos.x - carrierB.pos.x) / Math.max(dToCar, 1e-6);
                const toMeY = (body.pos.y - carrierB.pos.y) / Math.max(dToCar, 1e-6);
                const closingSp = carrierB.vel.x * toMeX + carrierB.vel.y * toMeY;
                if (duel.state === 'track') {
                  duel.state = carrierB.speed < DUEL.trackExitMps && closingSp < 2.6 ? 'jockey' : 'track';
                } else {
                  duel.state = carrierB.speed > DUEL.trackEnterMps || closingSp > 3.2 ? 'track' : 'jockey';
                }
              }
              duel.closeTicks = dToCar < 2.4 && (duel.state === 'jockey' || duel.state === 'track')
                ? (duel.closeTicks ?? 0) + 1 : 0;
              this.duels.set(body.id, duel);
              // targets — computed from the carrier's PROJECTED position
              // (0.4 s ahead): the jockey LEADS the retreat, matching the
              // advance instead of spooling up after the gap has crashed
              const cfx = carrierB.pos.x + carrierB.vel.x * 0.4;
              const cfy = carrierB.pos.y + carrierB.vel.y * 0.4;
              const gdF = Math.max(Math.hypot(cfx - ownG.x, cfy - ownG.y), 1e-6);
              const tgx = (ownG.x - cfx) / gdF;
              const tgy = (ownG.y - cfy) / gdF;
              if (duel.state === 'engage') {
                live = { x: this.ball.pos.x, y: this.ball.pos.y }; // commit — the contain takes it at 1.9
              } else if (duel.state === 'recover') {
                // never duel from the wrong side: cut the path AHEAD to regain it
                const ahead = Math.min(DUEL.recoverAheadM, gdF * 0.5);
                live = { x: cfx + tgx * ahead, y: cfy + tgy * ahead };
              } else {
                // JOCKEY / TRACK: on the carrier→goal line at the CURRENT
                // range, closing to the hold only as the carrier advances —
                // targeting the 2.0 m point directly meant a defender 6 m
                // goal-side ran forward INTO the carrier (the invisible
                // jockey): you GIVE GROUND square-on, you don't charge
                // NEVER approach a closing carrier (an attacker passes a
                // defender who is static or stepping toward him for free —
                // builder judgment): concede ground at a controlled rate and
                // let HIM close the gap to the hold; actively converge only
                // on an escaping/parallel carrier.
                const concede = closing0 > 0.5 ? 0.2 : 0.5;
                const range = Math.max(DUEL.holdM, Math.min(dToCar - concede, gdF - 0.5));
                live = { x: cfx + tgx * range, y: cfy + tgy * range };
                if (duel.state === 'track' && closing0 > 0.5) {
                  // the concede RATE is a speed: give ground at his pace minus
                  // ~1.7 m/s so the gap closes toward the hold under control —
                  // unbounded full-speed retreat was elastic (herded 20 m at a
                  // constant 8 m gap, never engaging)
                  timedCap = Math.min(timedCap ?? Infinity, Math.max(2.5, carrierB.speed - 1.7));
                }
                if (duel.state === 'jockey') {
                  // backpedal-capped, square to the ball (the L1 face-lock);
                  // TRACK is the full-speed escort — the cap alone donated a
                  // permanent 4 m trail vs a carrier at pace
                  timedCap = Math.min(timedCap ?? Infinity, DUEL.jockeyCapMps);
                  duelFace = { x: this.ball.pos.x, y: this.ball.pos.y };
                  if (Math.hypot(body.pos.x - live.x, body.pos.y - live.y) <= 0.4) standing = true;
                }
              }
              } // end !staggered
            } else {
              this.duels.delete(body.id);
            }
          }
        } else {
          this.duels.delete(body.id);
        }
        if (live !== undefined) this.liveTargets.set(body.id, live);
      }
      // the keeper's SHUFFLE: short repositioning stays square to the ball
      // (facing locked, the shuffle tax on speed); a long relocation — the
      // sweep, a big retreat — turns and runs like anyone
      let face: Vec2 | undefined = duelFace;
      if (this.keepers.has(body.id) && !isCarrier && !this.keeperAttacking.has(body.id)) {
        const kt = (body.command.type === 'chaseBall' ? live : undefined) ?? currentTarget(body);
        const goDist = kt ? Math.hypot(kt.x - body.pos.x, kt.y - body.pos.y) : 0;
        if (goDist <= BALL.keeperShuffleMaxM) face = { x: this.ball.pos.x, y: this.ball.pos.y };
      }
      stepBody(body, this.tick, {
        face,
        external: body.command.type === 'chaseBall' || duelRide ? live : undefined,
        steer: fetching ? live : undefined,
        // CARRYING MEANS THE BALL IS AT HIS FEET (the third
        // isCarrier-means-ownership correction this session): the
        // kinematics-side dribble tax (cap *= 0.84 + 0.04*dribbling/20)
        // was binding 64% of FETCH ticks — a man 2.5 m+ from a ball
        // rolling free, paying a dribbling cost for a ball he is not
        // dribbling. He is chasing; he runs free. THE BOUNDARY IS NOT
        // controlRadiusM: measured, normal dribbling sits at gap p50
        // 1.13 / p90 1.87 m — ABOVE the 0.9 claim radius — so gating
        // there would strip the tax from ordinary carrying, which three
        // drills caught immediately (carry-is-slower, dribble-weave,
        // covered-duel: they were right and the first predicate was
        // wrong). 2.5 m is the engine's own ball-is-right-there
        // threshold in the chase machine and the FAR class this whole
        // investigation measured. EXPECTED EFFECT IS
        // SMALL AND STATED IN ADVANCE (he averages 4.8 m/s against that
        // 5.63 ceiling, so a null is not a failure) — this is a
        // correctness fix, not a performance one.
        carrying: isCarrier && gap <= 2.5,
        // the DRIBBLE SPEED COST (the convergence loop's physics find:
        // carriers ran at FULL sprint with the ball glued, so equal-pace
        // riders could never close and every carry survived by
        // construction): carrying caps at ~89-96% of sprint, scaled by
        // the dribbling attribute — the first true kinematic attribute
        // effect (skill = speed retained with the ball)
        carrySpeedCapMps: isCarrier
          ? Math.min(
            // scaled from the COMMANDED regime — sprint-anchored never
            // bound for run-regime match carriers (byte-identical
            // ledgers proved it a no-op)
            regimeCapMps(body.attributes.pace,
              (body.command.type === 'moveTo' || body.command.type === 'followPath' || body.command.type === 'chaseBall')
                ? body.command.regime : 'run') * (0.87 + 0.005 * body.attributes.dribbling),
            (this.beatExec?.carrierId === body.id && this.beatExec.phase === 'approach'
              ? Math.min(this.dribbleArriveCap(body) ?? 4.2, 4.2)
              : this.dribbleArriveCap(body)) ?? Infinity)
          : undefined,
        stand: standing,
        brakeAtTarget: timedCap !== undefined || brakeIntoLine,
        speedCapMps: timedCap,
      });
      // bodies stay on the park (L5E bounds): the playing area clamps them
      body.pos.x = Math.max(0.2, Math.min(PITCH.length - 0.2, body.pos.x));
      body.pos.y = Math.max(0.2, Math.min(PITCH.width - 0.2, body.pos.y));
      if (standing) {
        // a set receiver watches the ball in — a BRAIN receiver takes it on
        // the HALF-TURN: body opened between the incoming ball and his
        // anticipated next play, so the aligned first-time ball needs no
        // turn (the judged rondo truth: the skill is body shape, not trap)
        const toBall = Math.atan2(this.ball.pos.y - body.pos.y, this.ball.pos.x - body.pos.x);
        let want = toBall;
        const open = this.receiveOpenDir.get(body.id);
        if (open !== undefined) {
          const half = ((open - toBall + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          want = toBall + half * 0.5;
        }
        const delta = ((want - body.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        body.facing += Math.sign(delta) * Math.min(Math.abs(delta), 4.0 * DT);
      }
      if (body.arrived) {
        const next = this.queues.get(body.id)!.shift();
        if (next) this.assign(body, next);
      }
      // idle bodies WATCH THE PLAY: a hold with no facing target lazily
      // tracks the ball (a frozen post-pass facing reads as a mannequin)
      if (body.command.type === 'hold' && body.command.facing === undefined &&
        this.ball.carrierId !== body.id && body.speed < 1.0) {
        const toBall = Math.atan2(this.ball.pos.y - body.pos.y, this.ball.pos.x - body.pos.x);
        const d = ((toBall - body.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        body.facing += Math.sign(d) * Math.min(Math.abs(d), 3.0 * DT);
      }
    }

    // 2b. bodies are SOLID (soft): pairwise separation — nobody ghosts
    // through an opponent. Accumulate displacements, then apply (order-free).
    // iterated (a single pass cannot resolve three-body chains: a crowder
    // pushing the middle man INTO a third body squeezed past the floor);
    // total displacement per body per tick is CAPPED — iterations could
    // accumulate a 0.84 m teleport in dense press scrums
    // DEEPEST-FIRST sequential relaxation (the m11 scrum finding: the
    // order-free batch let opposing pushes cancel vectorially and a
    // deeply merged pair sat unresolved for ticks while shallow contacts
    // consumed the budget) — sorted processing is equally deterministic
    // and spends the budget where the merge is worst.
    const sepTotal = new Map<string, number>();
    const applyPush = (b: BodyState, px: number, py: number): void => {
      const used = sepTotal.get(b.id) ?? 0;
      const mag = Math.hypot(px, py);
      const allowed = Math.max(0, 0.6 - used);
      const k = mag > allowed ? allowed / (mag || 1) : 1;
      b.pos = { x: b.pos.x + px * k, y: b.pos.y + py * k };
      sepTotal.set(b.id, used + mag * k);
    };
    for (let sepIter = 0; sepIter < 3; sepIter++) {
      const minSep = TECH.bodyRadiusM * 2;
      const pairs: Array<{ a: BodyState; b: BodyState; d: number }> = [];
      for (let i = 0; i < this.bodies.length; i++) {
        for (let j = i + 1; j < this.bodies.length; j++) {
          const a = this.bodies[i];
          const b = this.bodies[j];
          const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
          if (d < minSep && d >= 1e-9) pairs.push({ a, b, d });
        }
      }
      if (!pairs.length) break;
      pairs.sort((p1, p2) => p1.d - p2.d);
      for (const { a, b } of pairs) {
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const d = Math.hypot(dx, dy);
        if (d >= minSep || d < 1e-9) continue;
        const overlap = Math.min((minSep - d) / 2, TECH.separationSpeedMps * DT);
        const nx = dx / d;
        const ny = dy / d;
        applyPush(a, -nx * overlap, -ny * overlap);
        applyPush(b, nx * overlap, ny * overlap);
        // velocity resolution: colliding bodies stop CLOSING — remove the
        // approaching components (inelastic shoulder contact, not a bounce)
        const closing = (a.vel.x - b.vel.x) * nx + (a.vel.y - b.vel.y) * ny;
        if (closing > 0) {
          a.vel = { x: a.vel.x - nx * closing * 0.5, y: a.vel.y - ny * closing * 0.5 };
          b.vel = { x: b.vel.x + nx * closing * 0.5, y: b.vel.y + ny * closing * 0.5 };
          a.speed = Math.hypot(a.vel.x, a.vel.y);
          b.speed = Math.hypot(b.vel.x, b.vel.y);
        }
      }
    }

    // 3. scripted kicks — only the current carrier can strike, and only with
    // the ball at the boot (reach-gated — the audit item); execution noise
    // is attribute-driven (L3): the situation picks the kick, the feet decide
    // how faithfully it comes off
    const kicks = this.kicksAt.get(this.tick);
    if (kicks) {
      for (const k of kicks) {
        const kicker = this.byId.get(k.bodyId)!;
        const reach = Math.hypot(this.ball.pos.x - kicker.pos.x, this.ball.pos.y - kicker.pos.y);
        if (this.ball.carrierId === k.bodyId && reach <= TECH.kickReachM) {
          // scripted kicks stay facing-blind: the script IS the player's
          // intent, body shape included — the backheel penalty is for
          // DECIDED kicks (the chooser knows his own facing)
          const noisy = noisyKick(this.rng, this.tick, k.bodyId, kicker.attributes, k.kick.target, this.ball.pos, k.kick.speedMps);
          kickBall(this.ball, noisy.target, noisy.speedMps, k.kick.loftDeg, k.bodyId, this.tick, k.kick.spin ?? 0);
          this.ball.sprayM = Math.hypot(noisy.target.x - k.kick.target.x, noisy.target.y - k.kick.target.y);
        }
      }
    }

    // 3b. tackles (L3): a hunting body (chaseBall) in reach of a GLUED ball
    // contests it physically — tackling+strength vs dribbling+balance. Won:
    // the ball is knocked loose away from the carrier. Lost: the tackler is
    // beaten and cools down before lunging again. Fouls arrive at L9.
    this.resolveTackles();

    // 4. carry coupling, then free-ball physics
    this.coupleCarry();
    const ballFrom = { x: this.ball.pos.x, y: this.ball.pos.y };
    const zFrom = this.ball.z; // pre-step height — the chest touch is a SWEPT z crossing
    stepBall(this.ball);
    // a ball over any boundary is DEAD where it crossed (restarts are L8's;
    // until then it must not roll to infinity — the L4 shot exposed this).
    // Drill BOUNDS count as boundaries too (positional grids).
    // L7 GOAL seam: a crossing of either END line between the posts, under the
    // bar, is a GOAL — recorded (the save/beaten measurement) before the ball
    // goes dead. Crossing point interpolated along this tick's swept path.
    const ob = this.bounds;
    // a CARRIED ball over a line is out too (L5E bounds): dribbling across
    // the touchline/grid edge does not keep the play alive — strip and kill
    if (this.ball.phase !== 'dead' && this.ball.carrierId !== null &&
      (this.ball.pos.x < 0 || this.ball.pos.x > PITCH.length ||
        this.ball.pos.y < 0 || this.ball.pos.y > PITCH.width ||
        (ob !== undefined && (this.ball.pos.x < ob.x0 || this.ball.pos.x > ob.x1 ||
          this.ball.pos.y < ob.y0 || this.ball.pos.y > ob.y1)))) {
      this.ball.carrierId = null;
    }
    if (this.ball.phase !== 'dead' && this.ball.carrierId === null &&
      (this.ball.pos.x < 0 || this.ball.pos.x > PITCH.length)) {
      const lineX = this.ball.pos.x < 0 ? 0 : PITCH.length;
      const dx = this.ball.pos.x - ballFrom.x;
      const t = Math.abs(dx) < 1e-9 ? 1 : (lineX - ballFrom.x) / dx;
      const yAt = ballFrom.y + (this.ball.pos.y - ballFrom.y) * Math.max(0, Math.min(1, t));
      const zAt = zFrom + (this.ball.z - zFrom) * Math.max(0, Math.min(1, t));
      if (Math.abs(yAt - GOAL.centerY) <= GOAL.mouthHalfWidthM && zAt <= GOAL.barZ) {
        // the team DEFENDING this end conceded (home attacks +x, defends x=0)
        this.goals.push({ tick: this.tick, against: lineX === 0 ? 'home' : 'away', y: yAt, z: zAt });
        this.bannerText = 'GOAL!';
      } else if (Math.abs(yAt - GOAL.centerY) <= GOAL.mouthHalfWidthM + 4 && zAt <= GOAL.barZ + 2.5) {
        // NEAR MISS (builder: 'shots hit the goal say goal-kick' — the
        // workbench lerps 10 Hz frames, and a ball passing just wide can
        // LOOK in; the engine's call needs its own word)
        this.bannerText = 'OFF TARGET';
      }
    }
    if (this.ball.phase !== 'dead' && this.ball.carrierId === null &&
      (this.ball.pos.x < 0 || this.ball.pos.x > PITCH.length ||
        this.ball.pos.y < 0 || this.ball.pos.y > PITCH.width ||
        (ob !== undefined && (this.ball.pos.x < ob.x0 || this.ball.pos.x > ob.x1 ||
          this.ball.pos.y < ob.y0 || this.ball.pos.y > ob.y1)))) {
      this.ball.phase = 'dead';
      this.ball.vel = { x: 0, y: 0 };
      this.ball.vz = 0;
      this.ball.z = 0;
    }
    // L8-MINIMAL RESTARTS (the frames' matches keep flowing; ours ended
    // at the first dead ball into polite statues): at match scale (both
    // XIs) a dead ball restarts after 1.5 s — throw-in at the touchline
    // spot, corner or goal-kick on the goal lines, kickoff after a goal
    // — awarded AGAINST the last kicker, with a 2 s team claim lock.
    // Drills (small casts, bounded grids) keep dead-ends-the-drill.
    // THE RESTART LAW HOLDS UNTIL THE BALL IS IN PLAY — not until the
    // ball is merely un-dead: the goal-kick keeper PICKS UP the dead
    // ball (phase 'carried') before striking it, and gating on 'dead'
    // released the box the moment he touched it (the watch-5 regression;
    // the fourth instrument rule's code-side twin — the restriction
    // measured a STATE while the violation happened on the way in).
    if (this.restartType) {
      // the dwell clock is PER WINDOW: a restart chained directly from
      // another (foul during a pending window — no null gap) must not
      // inherit the old clock (witnessed: a penalty with pendAge ~12
      // read >=60 through a stale clock and kicked in 13 ticks)
      if (this.restartPendSince === null || this.restartType !== this.restartPendType) {
        this.restartPendSince = this.tick;
        this.restartPendType = this.restartType;
      }
      this.enforceRestartLaw();
    } else { this.restartPendSince = null; this.restartPendType = null; }
    if (this.ball.phase === 'dead') {
      if (this.deadSinceTick < 0) this.deadSinceTick = this.tick;
      const hN = this.teamBrainCount('home');
      const aN = this.teamBrainCount('away');
      const deadWait = this.goals.length > this.lastGoalCount ? 40 : 15; // the GOAL! banner gets its celebration
      if (hN >= 8 && aN >= 8 && this.bounds === undefined &&
        this.tick - this.deadSinceTick >= deadWait) {
        const lastTeam = this.ball.kickerId ? this.byId.get(this.ball.kickerId)?.team : undefined;
        let award: 'home' | 'away' = lastTeam === 'home' ? 'away' : 'home';
        let spot: Vec2;
        const p = this.ball.pos;
        if (this.pendingKickoffTeam) {
          award = this.pendingKickoffTeam;
          spot = { x: PITCH.length / 2, y: PITCH.width / 2 };
          this.restartType = 'kickoff';
          this.pendingKickoffTeam = null;
        } else if (this.pendingFreeKick) {
          // an offside or foul free kick: the fouled side restarts at the spot
          award = this.pendingFreeKick.team;
          spot = {
            x: Math.max(2, Math.min(PITCH.length - 2, this.pendingFreeKick.spot.x)),
            y: Math.max(2, Math.min(PITCH.width - 2, this.pendingFreeKick.spot.y)),
          };
          // the PENALTY approximation: a foul in the defending box awards
          // the spot itself — 11 m, central, the taker unopposed by the
          // taker-only claim rule (the census: a raw box-spot free kick
          // was a free shot from 5 m; until the full ceremony exists the
          // spot kick is the honest stand-in)
          if (spot.x < 16.5 && award === 'away' && Math.abs(spot.y - PITCH.width / 2) < 20) {
            spot = { x: 11, y: PITCH.width / 2 };
            this.restartPenalty = true;
          } else if (spot.x > PITCH.length - 16.5 && award === 'home' && Math.abs(spot.y - PITCH.width / 2) < 20) {
            spot = { x: PITCH.length - 11, y: PITCH.width / 2 };
            this.restartPenalty = true;
          }
          this.restartType = 'free-kick';
          this.pendingFreeKick = null;
        } else if (this.goals.length > this.lastGoalCount) {
          // kickoff: the conceding side restarts from the centre
          award = this.goals[this.goals.length - 1].against;
          spot = { x: PITCH.length / 2, y: PITCH.width / 2 };
          this.lastGoalCount = this.goals.length;
          this.restartType = 'kickoff';
        } else if (p.y < 0 || p.y > PITCH.width) {
          // throw-in at the touchline spot
          spot = { x: Math.max(2, Math.min(PITCH.length - 2, p.x)), y: p.y < 0 ? 1 : PITCH.width - 1 };
          this.restartType = 'throw-in';
        } else {
          // over a goal line: corner for the attacker, goal-kick for the
          // defender of that end (home defends x=0)
          const endX = p.x < 0 ? 0 : PITCH.length;
          const defenderOfEnd: 'home' | 'away' = endX === 0 ? 'home' : 'away';
          if (award === defenderOfEnd) {
            spot = { x: endX === 0 ? 6 : PITCH.length - 6, y: PITCH.width / 2 + (p.y >= PITCH.width / 2 ? 6 : -6) };
            this.restartType = 'goal-kick';
            for (const kid of this.keepers) {
              const kb = this.byId.get(kid);
              if (kb && kb.team === award) this.restartTaker = kid;
            }
          } else {
            spot = { x: endX === 0 ? 1 : PITCH.length - 1, y: p.y >= PITCH.width / 2 ? PITCH.width - 1 : 1 };
            this.restartType = 'corner';
          }
        }
        // every non-goal-kick restart gets its nearest awarded OUTFIELD
        // taker; the ceremonies quiet the transition instinct (a restart
        // is organized, not a scramble — counterpress labels on the
        // award side's own ball were the builder's 'reset issues' frame)
        if (this.restartType && this.restartType !== 'goal-kick') {
          let bestT: { id: string; d: number } | null = null;
          for (const bid of this.brains) {
            const bb = this.byId.get(bid)!;
            if (bb.team !== award || this.keepers.has(bid) || this.sentOff.has(bid)) continue;
            // the manager's designated taker outranks proximity (the
            // customization hook — free kicks and corners have owners)
            const d = Math.hypot(bb.pos.x - spot.x, bb.pos.y - spot.y) -
              (this.instructions.get(bid)?.setPieceTaker ? 1000 : 0);
            if (!bestT || d < bestT.d) bestT = { id: bid, d };
          }
          this.restartTaker = bestT?.id ?? null;
        }
        this.lostPossessionAt.set('home', -999);
        this.lostPossessionAt.set('away', -999);
        this.bannerText = this.restartPenalty ? 'PENALTY'
          : this.restartType === 'kickoff' ? (this.half === 2 && this.tick <= this.halfTick + 60 ? 'SECOND HALF' : 'KICKOFF')
          : this.restartType === 'throw-in' ? 'THROW-IN'
          : this.restartType === 'corner' ? 'CORNER'
          : this.restartType === 'goal-kick' ? 'GOAL KICK'
          : this.restartType === 'free-kick' ? 'FREE KICK'
          : this.bannerText;
        this.wallSpots.clear();
        if (this.restartType === 'free-kick' && !this.restartPenalty) {
          const g = goalCenter(award);
          const dG = Math.hypot(g.x - spot.x, g.y - spot.y);
          if (dG <= 30) {
            const n2 = dG < 20 ? 4 : dG < 26 ? 3 : 2;
            const ux = (g.x - spot.x) / dG;
            const uy = (g.y - spot.y) / dG;
            const base = { x: spot.x + ux * 9.15, y: spot.y + uy * 9.15 };
            const defs = [...this.brains]
              .map((bid) => this.byId.get(bid)!)
              .filter((bb) => bb.team !== award && !this.keepers.has(bb.id) && !this.sentOff.has(bb.id))
              .sort((a2, b2) => Math.hypot(a2.pos.x - base.x, a2.pos.y - base.y) - Math.hypot(b2.pos.x - base.x, b2.pos.y - base.y))
              .slice(0, n2);
            defs.forEach((bb, i) => {
              const off = (i - (n2 - 1) / 2) * 0.7;
              this.wallSpots.set(bb.id, {
                x: Math.max(2, Math.min(PITCH.length - 2, base.x - uy * off)),
                y: Math.max(2, Math.min(PITCH.width - 2, base.y + ux * off)),
              });
            });
          }
        }
        this.ball.pos = { x: spot.x, y: spot.y };
        this.ball.vel = { x: 0, y: 0 };
        this.ball.z = 0;
        this.ball.vz = 0;
        this.ball.phase = 'rolling';
        this.ball.kickerId = null;
        // the lock holds until the TAKER claims (a long ceiling backstops
        // a stranded taker) — a timed expiry handed restarts to whichever
        // opponent camped the spot (the census: an away striker taking
        // home's free kick at their own box)
        this.restartLock = { team: award, until: this.tick + (this.restartTaker ? 200 : 20) };
        // the dwell clock opens AT THE AWARD (same-type chains — a
        // penalty during a pending free kick — kept the stale clock
        // even after the type-keyed reset; the award is the one true
        // window-open event and this is its only site)
        this.restartPendSince = this.tick;
        this.restartPendType = this.restartType;
        // a goal kick keeps opponents OUT OF THE BOX until it is struck
        if (this.restartType === 'goal-kick') this.goalKickPending = award;
        this.stageRestart(award, spot);
        // staged positions need only a readability beat, not a walk
        this.restartSetupUntil = this.tick + (this.restartTaker ? 12 : 0);
        this.deadSinceTick = -1;
      }
    } else {
      this.deadSinceTick = -1;
    }

    // 4b. the offside law: flags at kicks, whistles on the touch
    this.updateOffside();

    // 5. loose-ball claims (and the chaseBall race resolution) — against the
    // ball's SWEPT PATH this tick, not its sampled endpoint: a 16 m/s ball
    // moves 1.6 m per tick and would otherwise tunnel through a claimant's
    // control disc without ever interacting
    // the keeper's HANDS come before anyone's head — he never heads a ball he
    // can hold (a dropping sweep was being weakly nodded into the arriving
    // runner by the header contest); above his catch ceiling the ball falls
    // through to the header contest, which is his punch
    this.resolveSaves(ballFrom);
    this.resolveHeaders(ballFrom);
    this.resolveChestControl(ballFrom, zFrom);
    this.resolveBlocks(ballFrom);
    this.resolveClaims(ballFrom);

    // L5d bookkeeping: possession flips arm the counterpress window; a
    // fresh carrier arms the press-the-touch trigger
    {
      const cb2 = this.ball.carrierId ? this.byId.get(this.ball.carrierId) : undefined;
      if (cb2) {
        if (this.prevCarrierTeam !== null && cb2.team !== this.prevCarrierTeam) {
          this.lostPossessionAt.set(this.prevCarrierTeam, this.tick);
        }
        if (this.prevCarrierTeam !== cb2.team || this.carrierSince < 0) this.carrierSince = this.tick;
        this.prevCarrierTeam = cb2.team;
      }
    }

    const frame = this.snapshot();
    this.tick++;
    return frame;
  }

  private readonly tackleCooldown = new Map<string, number>();
  /** contain bearings anchor when a press starts — re-deriving them each
   * tick is a feedback loop that walks the presser around the carrier */
  private readonly containBearing = new Map<string, number>();
  /** L5E — the duel state machine (design: L5E-DESIGN.md): per-defender state
   * vs the carrier he confronts. RECOVER (regain the side) / JOCKEY (hold
   * goal-side, capped, square to the ball) / TRACK (full-speed goal-side
   * escort of a carrier at pace) / ENGAGE (the committed close, resolved by
   * the contain + tackle machinery inside 1.9 m). The pressure meter is the
   * patience: it fills with jockey time, spikes on a stopped carrier. */
  /** L5E — loose-ball pursuit arbitration: ONE claimant per team per loose
   * ball (earliest arrival, 0.3 s re-election hysteresis); everyone else
   * SUPPORTS at an offset and stacked bodies separate. Two teammates racing
   * the same loose ball ended 0.7 m apart and each then intercepted the
   * other's pass to a third man (the corner flap's residual). */
  private readonly looseClaimant = new Map<'home' | 'away', { id: string; score: number }>();
  /** the BEAT in execution (L5E): approach (throttled, at the rider) →
   * feint (a step to the FAKE side, selling it to his smoothed read) →
   * burst (the knock through the real side). One carrier at a time. */
  private beatExec: { carrierId: string; fmId: string; phase: 'approach' | 'feint' | 'burst'; side: number; until: number; lastD?: number; stall?: number } | null = null;
  /** support sides taken this tick — two supporters must NOT share a spot
   * (both computed the same natural side and made twin runs, judged) */
  private readonly supportSides = new Map<'home' | 'away', number[]>();
  private readonly duels = new Map<string, { state: 'recover' | 'jockey' | 'track' | 'engage' | 'staggered'; pressure: number; goalSide: boolean; plantedUntil?: number; beatenUntil?: number; closeTicks?: number }>();
  /** pre-movement positions this tick — claims sweep the ball's path in the
   * RECEIVER'S FRAME (a charging receiver adds his own ~0.6 m/tick; testing
   * against his end position alone skips the reach window) */
  private readonly prevPos = new Map<string, Vec2>();
  /** sticky receive-phase state per chaser (hysteresis on the line band) */
  private readonly receiveOnLine = new Map<string, boolean>();

  /** the dribble-to-arrive push cap for this carrier's current stop-leg —
   * also the speed HE should ride at (you decelerate WITH your touch; a
   * probe showed a sprinter overrunning his dying touch straight into the
   * trailing defender's lap) */
  private dribbleArriveCap(carrier: BodyState): number | undefined {
    const cc = carrier.command;
    const legStops = cc.type === 'moveTo' ||
      (cc.type === 'followPath' && (cc.stopAtEach === true || carrier.pathIndex >= cc.points.length - 1));
    if (!legStops) return undefined;
    const dest = currentTarget(carrier);
    if (!dest) return undefined;
    const distToDest = Math.hypot(dest.x - this.ball.pos.x, dest.y - this.ball.pos.y);
    const cap = Math.sqrt(
      BALL.touchArriveResidualMps ** 2 + 2 * BALL.dribbleRollDecelMps2 * Math.max(0, distToDest),
    );
    return cap * 1.05;
  }

  /** the defenders currently planted by a failed lunge — the knock's window */
  private staggeredSet(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const [id, d] of this.duels) {
      if (d.state === 'staggered' && this.tick < (d.plantedUntil ?? 0)) out.add(id);
    }
    return out;
  }

  private resolveTackles(): void {
    const carrier = this.ball.carrierId ? this.byId.get(this.ball.carrierId) : undefined;
    if (!carrier) return;
    // the kick is FREE: no tackle exists during a restart ceremony — the
    // census caught the taker claiming his free kick and being stripped
    // the same instant by the defender the foul spot naturally stands on
    if (this.restartTaker) return;
    // a keeper with the ball IN HIS HANDS is untouchable — no tackle exists
    // against a held ball (the pinch already cannot reach a glued ball)
    if (this.keeperHolding === carrier.id) return;
    const gap = Math.hypot(this.ball.pos.x - carrier.pos.x, this.ball.pos.y - carrier.pos.y);
    if (gap > BALL.controlRadiusM) return; // a running touch is the pinch's domain
    for (const b of this.bodies) {
      if (b.id === carrier.id || b.team === carrier.team || this.sentOff.has(b.id)) continue;
      // intent to win the ball: the chase, OR machine ownership — the
      // duelRide presser (moveTo, ridden per tick) could reach ENGAGE
      // via the running challenge and still never tackle (this gate
      // predates ownership; the conversion loop measured the hole)
      if (b.command.type !== 'chaseBall' && !this.pressingIds.has(b.id)) continue;
      if ((this.tackleCooldown.get(b.id) ?? -1) > this.tick) continue;
      // a DUELIST tackles from any GOAL-SIDE riding state in true reach —
      // the engage-only gate throttled match conversion to 38 rolls per
      // 300 s against 386 close-contact ticks (the funnel measurement);
      // recover/staggered still never lunge (a trailing or planted man
      // has no tackle), and the drills keep their jockey texture because
      // reach itself stays the hard gate.
      const dst = this.duels.get(b.id);
      if (dst && (dst.state === 'recover' || dst.state === 'staggered')) continue;
      const reach = Math.hypot(this.ball.pos.x - b.pos.x, this.ball.pos.y - b.pos.y);
      // an ENGAGE commit is a LUNGE — a slide reaches ~2 m, not the
      // standing poke's 1.2 (the funnel: the machine rides at the 2.0 m
      // hold, architecturally OUTSIDE its own tackle range; 38 rolls in
      // 300 s of match)
      const lungeReach = dst?.state === 'engage' ? 2.0 : TECH.tackleReachM;
      if (reach > lungeReach) continue;
      this.tackleCooldown.set(b.id, this.tick + TECH.tackleCooldownTicks);
      this.telemetry?.({ t: 'tackle', tick: this.tick });
      if (this.brains.size >= 12 && !this.sentOff.has(b.id)) {
        const sp = Math.hypot(carrier.vel.x, carrier.vel.y);
        const hx = sp > 0.5 ? carrier.vel.x / sp : Math.cos(carrier.facing);
        const hy = sp > 0.5 ? carrier.vel.y / sp : Math.sin(carrier.facing);
        const behind = hx * (b.pos.x - carrier.pos.x) + hy * (b.pos.y - carrier.pos.y) < 0;
        const lunging = dst?.state === 'engage' || reach > TECH.tackleReachM;
        const pFoul = Math.min(0.5,
          0.035 * (behind ? 2.2 : 1) + (lunging ? 0.03 : 0) +
          Math.max(0, 10 - b.attributes.tackling) * 0.003);
        if (this.rng.chance(pFoul, this.tick, b.id, 'foul')) {
          this.ball.phase = 'dead';
          this.ball.carrierId = null;
          this.ball.vel = { x: 0, y: 0 };
          this.ball.vz = 0;
          this.ball.z = 0;
          this.pendingFreeKick = { team: carrier.team, spot: { x: carrier.pos.x, y: carrier.pos.y } };
          const n1 = (this.foulCounts.get(b.id) ?? 0) + 1;
          this.foulCounts.set(b.id, n1);
          const harsh = behind && lunging;
          let card: 'yellow' | 'red' | null = null;
          if ((harsh && this.rng.chance(0.5, this.tick, b.id, 'card')) || n1 === 3) {
            if (this.yellows.has(b.id) && !this.keepers.has(b.id)) {
              card = 'red';
              this.sendOff(b.id);
            } else {
              card = 'yellow';
              this.yellows.add(b.id);
            }
          }
          this.actionLabels.set(b.id, card ? `foul·${card}` : 'foul');
          this.bannerText = card === 'red' ? 'FOUL — RED CARD' : card === 'yellow' ? 'FOUL — YELLOW' : 'FOUL';
          this.telemetry?.({ t: 'foul', tick: this.tick, by: b.id, on: carrier.id, behind, lunging, card });
          continue;
        }
      }
      const winP = tackleWinProbability(b.attributes, carrier.attributes) /
        (1 + TECH.tackleCarrierSpeedFactor * carrier.speed);
      // the failed lunge is the BEATEN moment (L5E): planted, and the
      // carrier's window to break past is real — without it the same 27%
      // tackle re-rolls into inevitability over any crawl
      if (!this.rng.chance(winP, this.tick, b.id, 'tackle')) {
        const st = this.duels.get(b.id) ?? { state: 'staggered' as const, pressure: 0, goalSide: false };
        st.state = 'staggered';
        st.pressure = 0;
        st.plantedUntil = this.tick + DUEL.staggerTicks;
        st.beatenUntil = this.tick + DUEL.beatenTicks;
        this.duels.set(b.id, st);
        this.containBearing.delete(b.id);
        this.actionLabels.set(b.id, 'staggered');
        continue;
      }
      {
        // the WON tackle: knocked loose AWAY from the carrier, scattered
        const away = Math.atan2(this.ball.pos.y - carrier.pos.y + (b.pos.y - carrier.pos.y) * -1,
          this.ball.pos.x - carrier.pos.x + (b.pos.x - carrier.pos.x) * -1);
        const dir = away + this.rng.gauss(0, TECH.tackleKnockScatterRad, this.tick, b.id, 'tackle-dir');
        const speed = TECH.tackleKnockMinMps +
          (TECH.tackleKnockMaxMps - TECH.tackleKnockMinMps) * this.rng.float(this.tick, b.id, 'tackle-v');
        this.ball.carrierId = null;
        this.ball.phase = 'rolling';
        this.ball.vel = { x: Math.cos(dir) * speed, y: Math.sin(dir) * speed };
        // the DISPOSSESSED man cannot instantly re-claim the knock (the
        // kicker-refractory class of bug: without this the standing carrier
        // swept-claims the ball back within a tick and the win is undone)
        this.ball.kickerId = carrier.id;
        this.ball.kickerLockUntilTick = this.tick + 8;
      }
    }
  }

  /** the dribble loop: standing keeps the ball at the feet; a mover TOUCHES
   * the ball ahead along his heading whenever it is in reach; a ball that
   * escapes the gap is lost (possession is physics, not a flag) */
  private coupleCarry(): void {
    const carrier = this.ball.carrierId ? this.byId.get(this.ball.carrierId) : undefined;
    if (!carrier) return;
    const d = Math.hypot(this.ball.pos.x - carrier.pos.x, this.ball.pos.y - carrier.pos.y);
    if (d > BALL.maxDribbleGapM) {
      this.ball.carrierId = null;
      this.ball.phase = 'rolling';
      return;
    }
    // the BALL clears the carrier's gates (checked every tick, in reach or
    // not): a touch leads the body through a waypoint, and a gate is served
    // when the ball reaches it OR has passed it relative to the onward route
    // — otherwise the next touch aims backward at a gate already behind
    const ccGate = carrier.command;
    if (ccGate.type === 'followPath') {
      while (carrier.pathIndex < ccGate.points.length - 1) {
        const wp = ccGate.points[carrier.pathIndex];
        const nxt = ccGate.points[carrier.pathIndex + 1];
        const near = Math.hypot(this.ball.pos.x - wp.x, this.ball.pos.y - wp.y) <= KIN.waypointTolM;
        const passed = (wp.x - this.ball.pos.x) * (nxt.x - wp.x) + (wp.y - this.ball.pos.y) * (nxt.y - wp.y) < 0;
        if (near || passed) carrier.pathIndex++;
        else break;
      }
    }
    // a decided kick releases ON THIS TOUCH — the ball is at the boot for one
    // contact and that contact is the pass/shot/clear. The reach for a PENDING
    // kick is a STRIDE (kickReachM), not the dribble's control disc: a man
    // running onto his own rolling touch strikes it FIRST-TIME as he meets it.
    // Gating it on the tighter control radius made a driving striker chase a
    // 6.8 m/s ball for a full second — carrying his decided shot from 16 m out
    // to point-blank into the keeper's gloves (the shot-angle finding).
    const pending = this.pendingKicks.get(carrier.id);
    const pendingAligned = pending !== undefined && (() => {
      const d = Math.atan2(pending.dest.y - carrier.pos.y, pending.dest.x - carrier.pos.x);
      return Math.abs(((d - carrier.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI) <= DECIDE.strikeTurnThresholdRad;
    })();
    if (this.ball.z > BALL.claimMaxZ ||
      d > (pending && pendingAligned ? TECH.kickReachM : BALL.controlRadiusM)) return; // chasing his own touch
    if (pending && pendingAligned) {
      const noisy = noisyKick(this.rng, this.tick, carrier.id, carrier.attributes, pending.dest, this.ball.pos, pending.speedMps, carrier.facing);
      kickBall(this.ball, noisy.target, noisy.speedMps, pending.loftDeg ?? 0, carrier.id, this.tick, pending.spin ?? 0);
      // THE LABEL MARKS THE ACT (second strike site). Reporting only.
      if (pending.kind) this.actionLabels.set(carrier.id, pending.kind === 'pass' ? `pass→${pending.receiverId}` : pending.kind);
      this.ball.sprayM = Math.hypot(noisy.target.x - pending.dest.x, noisy.target.y - pending.dest.y);
      if (pending.receiverId) {
        this.intendedReceiverId = pending.receiverId;
        this.lastGiveTick.set(carrier.id, this.tick);
      }
      this.pendingKicks.delete(carrier.id);
      this.intents.delete(carrier.id);
      this.assign(carrier, pending.knock ? { type: 'chaseBall', regime: 'sprint' } : { type: 'hold' });
      return;
    }
    // a GATHERING carrier (chaseBall) traps the ball dead instead of touching
    // it on — without this the coupling is a donkey-and-carrot: every close
    // knocks the ball ahead again and the chase never ends
    if (carrier.command.type === 'chaseBall') {
      this.ball.vel = { x: 0, y: 0 };
      this.ball.vz = 0;
      this.ball.z = 0;
      this.ball.phase = 'carried';
      carrier.command = { type: 'hold' };
      carrier.arrived = true;
      carrier.arrivedAtTick = this.tick;
      const next = this.queues.get(carrier.id)!.shift();
      if (next) this.assign(carrier, next);
      return;
    }
    if (carrier.speed <= BALL.standingSpeedMps) {
      this.ball.vel = { x: 0, y: 0 };
      this.ball.vz = 0;
      this.ball.z = 0;
      this.ball.phase = 'carried';
      // shield bracing: rotate to put the body between ball and the nearest
      // presser (back-on) — the visible truth of a shield
      let brace: BodyState | null = null;
      let braceD = 2.2;
      for (const o of this.bodies) {
        if (o.team === carrier.team) continue;
        const od = Math.hypot(o.pos.x - carrier.pos.x, o.pos.y - carrier.pos.y);
        if (od < braceD) {
          braceD = od;
          brace = o;
        }
      }
      if (brace) {
        const away = Math.atan2(carrier.pos.y - brace.pos.y, carrier.pos.x - brace.pos.x);
        const delta = ((away - carrier.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        carrier.facing += Math.sign(delta) * Math.min(Math.abs(delta), 3.5 * DT);
      }
      return;
    }
    // a touch is AIMED AT THE ROUTE (you push the ball toward where you are
    // going, not along your momentary velocity — otherwise a fetch-steering
    // carrier and his own touch run in a straight line forever), with the
    // alternating-feet nudge for the left-right texture of a real dribble
    const routeTarget = currentTarget(carrier);
    const baseHeading = routeTarget
      ? Math.atan2(routeTarget.y - this.ball.pos.y, routeTarget.x - this.ball.pos.x)
      : Math.atan2(carrier.vel.y, carrier.vel.x);
    // far-foot dribbling: near a marker the touch biases AWAY from him
    // (alternating feet would play every second ball into his reach); free
    // of pressure, the feet alternate for the natural weave
    let lateral = (this.ball.touchParity ? 1 : -1) * BALL.touchAlternateRad;
    this.ball.touchParity = !this.ball.touchParity;
    let nearestOpp: BodyState | null = null;
    let nearestD: number = BALL.touchShieldRangeM;
    for (const o of this.bodies) {
      if (o.team === carrier.team) continue;
      const od = Math.hypot(o.pos.x - carrier.pos.x, o.pos.y - carrier.pos.y);
      if (od < nearestD) {
        nearestD = od;
        nearestOpp = o;
      }
    }
    if (nearestOpp) {
      // side of the route line the opponent is on → push the other way
      const side = Math.sign(
        Math.cos(baseHeading) * (nearestOpp.pos.y - carrier.pos.y) -
        Math.sin(baseHeading) * (nearestOpp.pos.x - carrier.pos.x),
      ) || 1;
      lateral = -side * BALL.touchShieldRad;
    }
    const heading = baseHeading + lateral;
    const vmax = topSpeedMps(carrier.attributes.pace);
    let push = carrier.speed * (
      BALL.touchPushBase +
      BALL.touchPushSpeedGain * (carrier.speed / vmax) +
      BALL.touchPushControlGain * (1 - carrier.attributes.dribbling / 20)
    );
    // dribble-to-arrive: the touch is weighted for the carrier's own route —
    // a ball pushed at cruise weight into his braking zone would roll meters
    // past the stop he is about to make. Only legs that END IN A STOP are
    // weighted; a slalom gate is dribbled THROUGH, not braked at.
    const cc = carrier.command;
    const legStops = cc.type === 'moveTo' ||
      (cc.type === 'followPath' && (cc.stopAtEach === true || carrier.pathIndex >= cc.points.length - 1));
    const dest = legStops ? currentTarget(carrier) : null;
    if (dest) {
      const distToDest = Math.hypot(dest.x - this.ball.pos.x, dest.y - this.ball.pos.y);
      push = Math.min(push, Math.sqrt(
        BALL.touchArriveResidualMps ** 2 + 2 * BALL.dribbleRollDecelMps2 * Math.max(0, distToDest),
      ));
    }
    // pressure-shortened touches: a defender set AHEAD caps the roll-out to
    // a control-scaled fraction of the gap — you don't push a cruise-weight
    // ball into the man in front of you (riding the shorter dying touch
    // also slows the carrier into the duel, which is the real approach)
    let press: BodyState | null = null;
    let pressD: number = BALL.pressAwareRangeM;
    for (const o of this.bodies) {
      if (o.team === carrier.team) continue;
      const dx = o.pos.x - carrier.pos.x;
      const dy = o.pos.y - carrier.pos.y;
      const od = Math.hypot(dx, dy);
      if (od >= pressD || od < 1e-6) continue;
      if ((dx * Math.cos(heading) + dy * Math.sin(heading)) / od < BALL.pressAwareConeCos) continue;
      press = o;
      pressD = od;
    }
    if (press) {
      const frac = BALL.pressRollFracBase -
        BALL.pressRollFracControlGain * (carrier.attributes.dribbling / 20);
      const rollMax = Math.max(BALL.pressRollMinM, pressD * frac);
      push = Math.min(push, Math.sqrt(
        BALL.touchArriveResidualMps ** 2 + 2 * BALL.dribbleRollDecelMps2 * rollMax,
      ));
    }
    this.ball.vel = { x: Math.cos(heading) * push, y: Math.sin(heading) * push };
    this.ball.z = 0;
    this.ball.vz = 0;
    this.ball.phase = 'carried';
  }

  /** the AERIAL CONTEST — a ball in the header band is challenged in the AIR:
   * bodies within a leap contest it (closer + stronger + a little agility,
   * with a coin-flip of noise), the winner heads it. A DEFENDER near his own
   * goal clears it upfield; an ATTACKER near the opponent goal heads at goal;
   * otherwise a knock-DOWN drops it at his feet to control. This is what makes
   * a loft OVER a defender honest — one standing under it heads it away. */
  /** closest horizontal approach of a body to the ball's swept path this tick,
   * in the body's own frame so a fast ball can't tunnel past his reach between
   * ticks. Shared by the header and the collision — one detection model. */
  private sweptApproach(body: BodyState, from: Vec2): { d: number; at: Vec2 } {
    const ball = this.ball;
    const prev = this.prevPos.get(body.id) ?? body.pos;
    const fx = from.x - (body.pos.x - prev.x);
    const fy = from.y - (body.pos.y - prev.y);
    const dx = ball.pos.x - fx;
    const dy = ball.pos.y - fy;
    const len2 = dx * dx + dy * dy;
    const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((body.pos.x - fx) * dx + (body.pos.y - fy) * dy) / len2));
    const at = { x: fx + dx * t, y: fy + dy * t };
    return { d: Math.hypot(body.pos.x - at.x, body.pos.y - at.y), at };
  }

  private resolveHeaders(from: Vec2): void {
    const ball = this.ball;
    if (ball.phase !== 'airborne' || ball.z < BALL.headMinZ || ball.z > BALL.headMaxZ) return;
    let best: { body: BodyState; score: number } | null = null;
    for (const body of this.bodies) {
      if (body.id === ball.kickerId && this.tick < ball.kickerLockUntilTick) continue;
      // SWEPT reach, like the collision — a fast ball can't tunnel past the
      // leap between ticks (else a rocket at head height reads as a scrambled
      // block instead of the clean header a man standing under it wins)
      const d = this.sweptApproach(body, from).d;
      if (d > BALL.headReachM) continue;
      if (ball.z > BALL.headStandM + BALL.headJumpPerStr * body.attributes.strength) continue; // can't leap to it
      const score = -d + 0.08 * body.attributes.strength + 0.05 * body.attributes.agility +
        this.rng.gauss(0, BALL.headContestNoise, this.tick, body.id, 'header');
      if (!best || score > best.score) best = { body, score };
    }
    if (!best) return;
    const w = best.body;
    // the header REDIRECTS the ball's pace — power from the BALL, plus a
    // strength term the header EARNS by attacking the ball: his approach/leap
    // speed into it. A passive nod under a weak lob adds almost nothing; a
    // committed header drives through it. A fast cross → a powerful header
    // whichever way, because the ball's pace dominates.
    const incoming = Math.hypot(ball.vel.x, ball.vel.y, ball.vz);
    const attack = Math.max(BALL.headPassiveFloor, Math.min(1, w.speed / BALL.headAttackRefMps));
    const headed = incoming * BALL.headRedirect + BALL.headPlayerPower * (w.attributes.strength / 20) * attack;
    const sign = attackSign(w.team);
    const ownGoal = { x: sign > 0 ? 0 : PITCH.length, y: PITCH.width / 2 };
    const oppGoal = goalCenter(w.team);
    const dOwn = Math.hypot(ownGoal.x - w.pos.x, ownGoal.y - w.pos.y);
    const dOpp = Math.hypot(oppGoal.x - w.pos.x, oppGoal.y - w.pos.y);
    if (dOwn < 35) {
      // DEFENSIVE clearance — lofted, far, upfield, with wide direction noise
      const ang = (sign > 0 ? 0 : Math.PI) + this.rng.gauss(0, BALL.headClearScatterRad, this.tick, w.id, 'head-clear');
      kickBall(ball, { x: w.pos.x + Math.cos(ang) * 30, y: w.pos.y + Math.sin(ang) * 30 }, headed, BALL.headClearLoftDeg, w.id, this.tick);
      this.actionLabels.set(w.id, 'header-clear');
    } else if (dOpp < 14) {
      // ATTACKING header at goal — a driven strike, slight noise, low
      const ang = Math.atan2(oppGoal.y - w.pos.y, oppGoal.x - w.pos.x) + this.rng.gauss(0, 0.12, this.tick, w.id, 'head-goal');
      kickBall(ball, { x: w.pos.x + Math.cos(ang) * 20, y: w.pos.y + Math.sin(ang) * 20 }, headed, 8, w.id, this.tick);
      this.actionLabels.set(w.id, 'header-goal');
    } else {
      this.actionLabels.set(w.id, 'header-down');
      // KNOCK-DOWN — cushion the pace OUT (a controlled header down to feet:
      // no kicker lock, he plays it next tick; an opponent may still contest)
      ball.z = 0;
      ball.vz = 0;
      ball.phase = 'rolling';
      ball.carrierId = null;
      ball.kickerId = null;
      ball.vel = { x: sign * incoming * BALL.headKnockCushion, y: this.rng.gauss(0, 1, this.tick, w.id, 'head-knock') };
    }
  }

  /** CHEST / THIGH control — the 0.5–0.9 m gap between the ground first touch
   * and the header. A receiver GOING FOR a fast airborne ball takes it on the
   * chest: a good touch cushions it down to his feet (control), a poor one
   * (fast / high / pressured) BOUNCES OFF him loose. This is the receive's
   * middle band — distinct from the header (a deliberate leap, ≥0.9 m), the
   * collision (a PASSIVE obstacle caroming it), and the ground first touch
   * (≤0.5 m). Only a man attacking the ball — the intended man or a chaser —
   * reaches to control it; a passer merely in the way still caroms (collision).
   * Runs after the header, before the collision, so the receiver's touch beats
   * an obstacle's carom on the same ball. */
  private resolveChestControl(from: Vec2, zFrom: number): void {
    const ball = this.ball;
    if (ball.phase === 'dead' || ball.phase === 'carried') return;
    // the ball's z-path this tick CROSSED the chest band — at 10 Hz a fast ball
    // spans it in one tick (rising or falling through), so an instantaneous-z
    // gate never catches it; the swept crossing does. Only a FAST ball is a
    // chest challenge — a slow drop is let fall and controlled on the ground.
    const zLo = Math.min(zFrom, ball.z);
    const zHi = Math.max(zFrom, ball.z);
    const crossedChest = zLo < BALL.headMinZ && zHi > BALL.claimMaxZ;
    const speed = Math.hypot(ball.vel.x, ball.vel.y, ball.vz);
    if (!crossedChest || speed < BALL.blockMinSpeedMps) return;
    let best: { body: BodyState; d: number; at: Vec2 } | null = null;
    for (const body of this.bodies) {
      if (body.id === ball.kickerId && this.tick < ball.kickerLockUntilTick) continue;
      // only a man ATTACKING the ball chests it — the intended man or a chaser
      if (body.id !== this.intendedReceiverId && body.command.type !== 'chaseBall') continue;
      const { d, at } = this.sweptApproach(body, from);
      if (d > BALL.controlRadiusM) continue;
      if (!best || d < best.d) best = { body, d, at };
    }
    if (!best) return;
    const w = best.body;
    const ballSpeed = Math.hypot(ball.vel.x - w.vel.x, ball.vel.y - w.vel.y);
    const rawSpeed = Math.hypot(ball.vel.x, ball.vel.y);
    const arrivalDir = rawSpeed > 0.1 ? Math.atan2(ball.vel.y, ball.vel.x) : w.facing;
    const pressured = this.bodies.some((o) => o.team !== w.team &&
      Math.hypot(o.pos.x - w.pos.x, o.pos.y - w.pos.y) <= TECH.touchPressureRangeM);
    // the first touch, judged at CHEST height (the band midpoint — the ball
    // swept through it this tick even if it ended at his feet). resolveFirstTouch
    // makes a higher, faster ball harder, so a driven pass to the chest pops more
    const chestZ = (BALL.claimMaxZ + BALL.headMinZ) / 2;
    const touch = resolveFirstTouch(
      this.rng, this.tick, w.id, w.attributes, arrivalDir, ballSpeed, chestZ, pressured, w.speed,
      w.id === this.intendedReceiverId ? this.ball.sprayM ?? 0 : 0,
    );
    ball.pos = { x: best.at.x, y: best.at.y };
    ball.vz = 0;
    ball.z = 0;
    if (touch.pop) {
      // it BOUNCES OFF his chest — a failed control, loose and low; he cannot
      // instantly re-claim his own miss (the same refractory the ground pop uses)
      ball.carrierId = null;
      ball.phase = 'rolling';
      ball.vel = touch.vel;
      ball.kickerId = w.id;
      ball.kickerLockUntilTick = this.tick + 8;
      this.actionLabels.set(w.id, 'chest-miss');
      return;
    }
    // CUSHIONED down to his feet — controlled
    ball.carrierId = w.id;
    ball.phase = 'carried';
    this.completeChases(w.team);
    this.actionLabels.set(w.id, 'chest');
  }

  /** L7 — ANGLE PLAY: the keeper holds the ball–goal line at depth, shading to
   * the ball's angle, clamped to the frame's shadow. He owns his own movement. */
  private keeperPhase(): void {
    if (this.keepers.size === 0) return;
    for (const id of this.keepers) {
      const k = this.byId.get(id);
      if (!k) continue;
      this.keeperAttacking.delete(id);
      const sign = attackSign(k.team);
      const own = { x: sign > 0 ? 0 : PITCH.length, y: GOAL.centerY };
      if (this.ball.carrierId === id) {
        // THE WAITING RESTART: a taker deferring his goal kick STANDS
        // with the ball — no pickup, no drop-pass, no clear (the first
        // goal-kick regression was exactly this fall-through)
        if (this.restartTaker === id && this.restartType === 'goal-kick') continue;
        // OUTSIDE his box he is a defender under pressure — the sweep's
        // ending is a FIRST-TIME clear upfield, not a gather-and-carry
        const outsideBox = Math.abs(this.ball.pos.x - own.x) > GOAL.boxDepthM ||
          Math.abs(this.ball.pos.y - GOAL.centerY) > GOAL.boxHalfWidthM;
        if (outsideBox) {
          const upAng = (sign > 0 ? 0 : Math.PI) +
            this.rng.gauss(0, 0.3, this.tick, id, 'k-clear');
          kickBall(this.ball, { x: k.pos.x + Math.cos(upAng) * 30, y: k.pos.y + Math.sin(upAng) * 30 },
            16, 25, id, this.tick);
          this.actionLabels.set(id, 'keeper-clear');
          continue;
        }
        // a DROP-TO-FEET pass mid-flow: the ball is DOWN (immunity off, he is
        // tackleable) — strike the ground pass after the beat, or pick it
        // straight back up if a presser closes in
        if (this.keeperDropPass?.keeperId === id) {
          const dp = this.keeperDropPass;
          const pressed = this.bodies.some((o) => o.team !== k.team &&
            Math.hypot(o.pos.x - k.pos.x, o.pos.y - k.pos.y) < 3.5);
          if (pressed) {
            this.keeperDropPass = null;
            // the hands are only legal if the ball did NOT arrive as a
            // deliberate teammate kick (the back-pass law): kickerId is
            // stable until his own strike, so the same predicate holds
            const lk = this.ball.kickerId ? this.byId.get(this.ball.kickerId) : undefined;
            if (lk && lk.id !== id && lk.team === k.team) {
              const upAng = (sign > 0 ? 0 : Math.PI) +
                this.rng.gauss(0, 0.3, this.tick, id, 'k-clear');
              kickBall(this.ball, { x: k.pos.x + Math.cos(upAng) * 30, y: k.pos.y + Math.sin(upAng) * 30 },
                16, 25, id, this.tick);
              this.actionLabels.set(id, 'keeper-clear');
              continue;
            }
            this.keeperHolding = id; // back into the hands — safety first
            this.keeperHeldSince = this.tick;
          } else if (this.tick >= dp.strikeTick) {
            this.keeperDropPass = null;
            const m = this.byId.get(dp.mateId);
            if (m) {
              const dm = Math.hypot(m.pos.x - k.pos.x, m.pos.y - k.pos.y);
              const lead = { x: m.pos.x + m.vel.x * 0.4, y: m.pos.y + m.vel.y * 0.4 };
              // the ground-kick MENU, honestly derived from this pitch's
              // friction: a weighted roll dies by ~20 m; the low GRASS CUTTER
              // (5°, skimming) carries pace to ~30; beyond that only the
              // PINGED 16° driven ball arrives alive (a rolled ball is dead by
              // 38, and an 8° delivery needed an uncontrollable rocket)
              if (dm > 30) {
                kickBall(this.ball, lead, solveLoftSpeed(Math.max(6, dm - 5), 16), 16, id, this.tick);
              } else if (dm > 20) {
                kickBall(this.ball, lead, 26, 5, id, this.tick); // the grass cutter
              } else {
                kickBall(this.ball, lead, Math.max(8, Math.min(19, rollLaunchForArrival(5, dm))), 0, id, this.tick);
              }
              this.intendedReceiverId = m.id;
              this.actionLabels.set(id, 'keeper-pass');
            }
          } else if (k.command.type !== 'hold') {
            this.assign(k, { type: 'hold' });
          }
          continue;
        }
        // THE BACK-PASS LAW: a ball deliberately KICKED (or thrown in) to
        // him by his own team may not be picked up — he plays it with his
        // feet. Detection: the ball's last kicker is a teammate other than
        // himself (every deliberate strike/throw sets kickerId; deflections
        // re-attribute to the deflector). Known approximation: a headed
        // back-pass also sets kickerId and is treated as unhandleable —
        // over-strict, rare, and the safe direction to err.
        const lastKicker = this.ball.kickerId ? this.byId.get(this.ball.kickerId) : undefined;
        if (lastKicker && lastKicker.id !== id && lastKicker.team === k.team) {
          const pressedBP = this.bodies.some((o) => o.team !== k.team &&
            Math.hypot(o.pos.x - k.pos.x, o.pos.y - k.pos.y) < 3.5);
          if (!pressedBP && !this.keeperDropPass) {
            // compose from the feet: the nearest unmarked mate gets the
            // ground ball (the keeperDropPass machinery, hands never used)
            let mate: BodyState | null = null;
            let bestD = 42;
            for (const m of this.bodies) {
              if (m.team !== k.team || m.id === id || this.sentOff.has(m.id)) continue;
              const dm = Math.hypot(m.pos.x - k.pos.x, m.pos.y - k.pos.y);
              if (dm >= bestD || dm < 4) continue;
              const marked = this.bodies.some((o) => o.team !== k.team &&
                Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 4);
              if (!marked) { mate = m; bestD = dm; }
            }
            if (mate) {
              this.keeperDropPass = { keeperId: id, mateId: mate.id, strikeTick: this.tick + 5 };
              this.actionLabels.set(id, 'keeper-feet');
              if (k.command.type !== 'hold') this.assign(k, { type: 'hold' });
              continue;
            }
          }
          // pressed, or nobody open: the first-time clear upfield
          const upAng = (sign > 0 ? 0 : Math.PI) +
            this.rng.gauss(0, 0.3, this.tick, id, 'k-clear');
          kickBall(this.ball, { x: k.pos.x + Math.cos(upAng) * 30, y: k.pos.y + Math.sin(upAng) * 30 },
            16, 25, id, this.tick);
          this.actionLabels.set(id, 'keeper-clear');
          continue;
        }
        // INSIDE his box a settled ball at his feet is PICKED UP — held in
        // both hands he is untouchable (no tackle exists against a held ball)
        if (this.keeperHolding !== id) {
          this.keeperHolding = id;
          this.keeperHeldSince = this.tick;
        }
        if (k.command.type !== 'hold') this.assign(k, { type: 'hold' });
        // DISTRIBUTION: a beat to settle, then — the nearest OPEN mate in
        // throw range gets the fast flat THROW; an open mate beyond it (inside
        // kick range, nobody pressing) earns the DROP TO FEET and a ground
        // pass; nobody at all → the PUNT long
        if (this.tick - this.keeperHeldSince >= BALL.keeperHoldTicks) {
          // the PRICED MENU (builder: 'why does the keeper never do long
          // throws or long kicks?'): the old strict cascade let ANY open
          // mate inside flat-throw range annihilate every long option —
          // and after the rest-defense there is always one, so the long
          // ball never fired. Now every candidate (flat throw, loop,
          // drop-kick) is scored in the outfield currency — completion x
          // (position + freedom) — with the distribution instruction
          // biasing range. The breaking striker in space can now OUTBID
          // the open CB next to the box; the punt stays the fallback.
          const opps = this.bodies.filter((o) => o.team !== k.team);
          const style = this.instructions.get(id)?.distribution ?? 'mixed';
          const safe = !this.bodies.some((o) => o.team !== k.team &&
            Math.hypot(o.pos.x - k.pos.x, o.pos.y - k.pos.y) < BALL.keeperDropSafeM);
          let pick: { kind: 'throw' | 'loop' | 'kick'; mate: BodyState; d: number; score: number } | null = null;
          for (const m of this.bodies) {
            if (m.team !== k.team || m.id === id) continue;
            const dm = Math.hypot(m.pos.x - k.pos.x, m.pos.y - k.pos.y);
            const marked = this.bodies.some((o) => o.team !== k.team &&
              Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 4);
            if (marked) continue;
            let free = Infinity;
            for (const o of opps) free = Math.min(free, Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y));
            const worth = 0.12 + posValue(m.pos, k.team) + 0.06 * Math.min(1, free / 12);
            const styleW = style === 'short' ? 1.15 - 0.5 * (dm / 50)
              : style === 'long' ? 0.7 + 0.8 * (dm / 50) : 1;
            const consider = (kind: 'throw' | 'loop' | 'kick', pC: number, floor: number): void => {
              if (pC < floor) return;
              const score = pC * worth * styleW;
              if (!pick || score > pick.score) pick = { kind, mate: m, d: dm, score };
            };
            if (dm >= BALL.keeperThrowMinM && dm <= BALL.keeperThrowMaxM) {
              // a throw ARRIVES with pace — the arrival-race model
              // (passCompletion) is the honest judge, not a static lane
              const spd = Math.max(8, Math.min(16, rollLaunchForArrival(5, dm)));
              consider('throw', passCompletion(k.pos, m.pos, spd, opps, dm, m, 14), 0.62);
            } else if (!safe && dm > BALL.keeperThrowMaxM && dm <= BALL.keeperLoopThrowMaxM &&
              solveLoftSpeed(dm, BALL.keeperLoopThrowLoftDeg) <= BALL.keeperLoopThrowSpeedMax) {
              // the loop is the PRESSED keeper's long reach (release from
              // the hands, immunity intact); composed keepers put it down
              const landing = {
                x: m.pos.x - ((m.pos.x - k.pos.x) / dm) * 3,
                y: m.pos.y - ((m.pos.y - k.pos.y) / dm) * 3,
              };
              consider('loop', aerialCompletion(landing, m, opps), 0.5);
            } else if (safe && dm > BALL.keeperThrowMaxM && dm <= BALL.keeperKickMaxM) {
              // the driven low ball FLIES most of the way and skids the
              // last metres — gated at the ARRIVAL RACE AT THE LANDING
              const landing = {
                x: m.pos.x - ((m.pos.x - k.pos.x) / dm) * 5,
                y: m.pos.y - ((m.pos.y - k.pos.y) / dm) * 5,
              };
              consider('kick', aerialCompletion(landing, m, opps), 0.5);
            }
          }
          // TS's flow analysis cannot see the closure's assignments to
          // `pick` and narrows it to its initializer — read via assertion
          const picked = pick as { kind: 'throw' | 'loop' | 'kick'; mate: BodyState; d: number; score: number } | null;
          const best = picked && picked.kind === 'throw' ? { mate: picked.mate, d: picked.d } : null;
          const loop = picked && picked.kind === 'loop' ? { mate: picked.mate, d: picked.d } : null;
          const kickable = picked && picked.kind === 'kick' ? { mate: picked.mate, d: picked.d } : null;
          this.keeperHolding = null;
          if (best) {
            // the THROW — flat, fast, to feet, weighted by range
            const lead = { x: best.mate.pos.x + best.mate.vel.x * 0.4, y: best.mate.pos.y + best.mate.vel.y * 0.4 };
            kickBall(this.ball, lead, Math.max(8, Math.min(16, rollLaunchForArrival(5, best.d))), BALL.keeperThrowLoftDeg, id, this.tick);
            this.intendedReceiverId = best.mate.id;
            this.actionLabels.set(id, 'throw');
          } else if (loop) {
            // the LOOPING throw — over-arm, arcing to the far man, released
            // from the hands under press
            const lead = { x: loop.mate.pos.x + loop.mate.vel.x * 0.6, y: loop.mate.pos.y + loop.mate.vel.y * 0.6 };
            const dl = Math.hypot(lead.x - k.pos.x, lead.y - k.pos.y);
            kickBall(this.ball, lead, Math.min(BALL.keeperLoopThrowSpeedMax, solveLoftSpeed(dl, BALL.keeperLoopThrowLoftDeg)),
              BALL.keeperLoopThrowLoftDeg, id, this.tick);
            // an over-arm throw RELEASES HIGH (~2.3 m): launched from the
            // grass, the arc passed through head height exactly where the
            // presser stood — he nodded the fresh throw straight back at goal
            this.ball.z = 2.3;
            this.intendedReceiverId = loop.mate.id;
            this.actionLabels.set(id, 'loop-throw');
          } else if (kickable) {
            // the DROP — ball to his feet (tackleable now), the pass follows
            this.keeperDropPass = { keeperId: id, mateId: kickable.mate.id, strikeTick: this.tick + BALL.keeperDropTicks };
            this.actionLabels.set(id, 'drop');
          } else {
            // the PUNT — kicked from the hands, AIMED: the most advanced OPEN
            // mate (a runner breaking for the counter) is led by the punt's
            // hang time; only with nobody upfield does it go long to space
            let counter: { mate: BodyState; d: number } | null = null;
            for (const m of this.bodies) {
              if (m.team !== k.team || m.id === id) continue;
              const up = (m.pos.x - k.pos.x) * sign;
              if (up < 15) continue; // a counter target is genuinely upfield
              const dm = Math.hypot(m.pos.x - k.pos.x, m.pos.y - k.pos.y);
              if (dm > 68) continue;
              const open = !this.bodies.some((o) => o.team !== k.team &&
                Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 5);
              if (!open) continue;
              if (!counter || up > (counter.mate.pos.x - k.pos.x) * sign) counter = { mate: m, d: dm };
            }
            if (counter) {
              // a flatter, faster punt for the counter — led into the run
              const spd0 = solveLoftSpeed(counter.d, 28);
              const hang = loftFlightTimeS(spd0, 28);
              const lead = {
                x: counter.mate.pos.x + counter.mate.vel.x * hang,
                y: Math.max(4, Math.min(PITCH.width - 4, counter.mate.pos.y + counter.mate.vel.y * hang)),
              };
              const dLead = Math.hypot(lead.x - k.pos.x, lead.y - k.pos.y);
              kickBall(this.ball, lead, Math.min(32, solveLoftSpeed(dLead, 28)), 28, id, this.tick);
              this.intendedReceiverId = counter.mate.id;
              this.actionLabels.set(id, 'punt');
            } else {
              const upAng = (sign > 0 ? 0 : Math.PI) +
                this.rng.gauss(0, BALL.keeperPuntScatterRad, this.tick, id, 'punt');
              const target = {
                x: k.pos.x + Math.cos(upAng) * 55,
                y: Math.max(8, Math.min(PITCH.width - 8, k.pos.y + Math.sin(upAng) * 55)),
              };
              kickBall(this.ball, target, BALL.keeperPuntSpeed, BALL.keeperPuntLoftDeg, id, this.tick);
              this.actionLabels.set(id, 'punt');
            }
          }
        }
        continue;
      }
      // the DIVE: a live shot at his goal — after his reaction, he attacks the
      // shot's LINE (its closest point to him) flat out; corners beat the
      // reaction, straight ones don't (why placement matters). A shot is
      // MOUTH-BOUND: its line crosses the goal plane between the posts — a
      // fast through ball rolling for the corner is a ball to SWEEP, not dive at
      const towardGoal = this.ball.vel.x * (own.x - this.ball.pos.x) > 0;
      const yAtGoal = towardGoal && Math.abs(this.ball.vel.x) > 0.5
        ? this.ball.pos.y + this.ball.vel.y * ((own.x - this.ball.pos.x) / this.ball.vel.x)
        : Infinity;
      // ...and IMMINENT: reaching the goal line within ~1.3 s. A 55 m diagonal
      // whose line happens to cross the mouth is a ball to sweep, not a shot.
      const tToGoal = towardGoal && Math.abs(this.ball.vel.x) > 0.5
        ? (own.x - this.ball.pos.x) / this.ball.vel.x : Infinity;
      const shotThreat = this.ball.carrierId === null && this.ball.phase !== 'dead' &&
        Math.hypot(this.ball.vel.x, this.ball.vel.y, this.ball.vz) >= BALL.blockMinSpeedMps &&
        Math.hypot(this.ball.pos.x - own.x, this.ball.pos.y - own.y) <= BALL.keeperEngageM &&
        towardGoal && this.ball.z <= GOAL.barZ && tToGoal < 1.3 &&
        Math.abs(yAtGoal - GOAL.centerY) <= GOAL.mouthHalfWidthM + 1.2;
      if (shotThreat) {
        const seen = this.keeperShotSeen.get(id) ?? this.tick;
        this.keeperShotSeen.set(id, seen);
        if (this.tick - seen >= BALL.keeperReactTicks) {
          const vx = this.ball.vel.x, vy = this.ball.vel.y;
          const v2 = Math.max(vx * vx + vy * vy, 1e-9);
          const t = Math.max(0, ((k.pos.x - this.ball.pos.x) * vx + (k.pos.y - this.ball.pos.y) * vy) / v2);
          const dive = { x: this.ball.pos.x + vx * t, y: this.ball.pos.y + vy * t };
          const cur = k.command.type === 'moveTo' ? k.command.target : null;
          if (!cur || Math.hypot(cur.x - dive.x, cur.y - dive.y) > 0.2) {
            this.assign(k, { type: 'moveTo', target: dive, regime: 'sprint' });
          }
          continue;
        }
      } else {
        this.keeperShotSeen.delete(id);
      }
      // the CHIP READ: a ball ARCING OVER HIM toward his goal — above the bar
      // right now (so no shot gate sees it) but dropping at the mouth. He
      // turns and SPRINTS for his line to contest the drop; the save races it.
      // PENALTY: the defending keeper stands ON HIS LINE until it is
      // struck — angle play would carry him toward the spot
      if (this.restartPenalty && this.restartTaker) {
        const tkB2 = this.byId.get(this.restartTaker);
        if (tkB2 && tkB2.team !== k.team) {
          const lineSpot = { x: own.x + (sign > 0 ? 0.6 : -0.6), y: GOAL.centerY };
          if (Math.hypot(lineSpot.x - k.pos.x, lineSpot.y - k.pos.y) > 0.4) {
            this.assign(k, { type: 'moveTo', target: lineSpot, regime: 'run' });
          } else if (k.command.type !== 'hold') {
            this.assign(k, { type: 'hold' });
          }
          continue;
        }
      }
      const dBallGoal = Math.hypot(this.ball.pos.x - own.x, this.ball.pos.y - own.y);
      const ballCarrier = this.ball.carrierId ? this.byId.get(this.ball.carrierId) : undefined;
      if (ballCarrier === undefined && this.ball.phase === 'airborne' &&
        this.ball.z > GOAL.barZ && this.ball.vel.x * (own.x - this.ball.pos.x) > 0) {
        const kickerB = this.ball.kickerId ? this.byId.get(this.ball.kickerId) : undefined;
        if (kickerB && kickerB.team !== k.team) {
          const chipPred = predictBall(this.ball, 2.5);
          const dPredMouth = Math.hypot(chipPred.x - own.x, chipPred.y - own.y);
          if (dPredMouth < 8) {
            this.keeperAttacking.add(id); // a flat-out backpedal race, no shuffle
            const spot = { x: own.x + (sign > 0 ? 0.8 : -0.8), y: GOAL.centerY };
            const cur = k.command.type === 'moveTo' ? k.command.target : null;
            if (!cur || Math.hypot(cur.x - spot.x, cur.y - spot.y) > 0.3) {
              this.assign(k, { type: 'moveTo', target: spot, regime: 'sprint' });
            }
            continue;
          }
        }
      }
      // the SWEEP-CHASE: a free ball IN (or dropping into) his zone that is
      // not a shot — the through ball in behind, the loose roll. He leaves his
      // line and attacks it; interceptPoint drives him to the drop and
      // resolveClaims/resolveSaves do the pickup. Gated on the PREDICTED ball
      // (waiting for it to slow or arrive gave the runner a 2 s head start).
      if (ballCarrier === undefined && this.ball.phase !== 'dead') {
        const pred = predictBall(this.ball, 2.0);
        const dPredGoal = Math.hypot(pred.x - own.x, pred.y - own.y);
        if (Math.min(dBallGoal, dPredGoal) < BALL.keeperSweepChaseM) {
          const kD = Math.hypot(this.ball.pos.x - k.pos.x, this.ball.pos.y - k.pos.y);
          // an airborne ball dropping INSIDE HIS BOX is HIS — "keeper's!":
          // he attacks a cross through his own defenders; deference to a
          // nearer mate applies only to ground balls outside his command
          // ...but only a REACHABLE drop is his (the born-attainable
          // lesson, now for the keeper): committing to a near-post corner
          // he cannot beat vacated the goal and fed the header EVERY time
          // (watch 5 — deterministic, the bug shape). Find the drop's
          // arrival, compare his sprint time; unreachable -> stay and set.
          let reachDrop = true;
          if (this.ball.phase === 'airborne') {
            let tArr = -1;
            let dropP: Vec2 | null = null;
            let prevZ2 = this.ball.z;
            for (let ts = 0.2; ts <= 2.6; ts += 0.2) {
              const bp = predictBallState(this.ball, ts);
              if (bp.z <= BALL.keeperCatchMaxZ && (bp.vz <= 0.2 || prevZ2 > BALL.keeperCatchMaxZ)) { tArr = ts; dropP = bp.pos; break; }
              prevZ2 = bp.z;
            }
            if (tArr > 0 && dropP) {
              const dDrop = Math.hypot(dropP.x - k.pos.x, dropP.y - k.pos.y);
              reachDrop = 0.35 + dDrop / Math.max(1, regimeCapMps(k.attributes.pace, 'sprint')) <= tArr + 0.25;
            }
          }
          const hisBall = this.ball.phase === 'airborne' && reachDrop &&
            Math.abs(pred.x - own.x) <= GOAL.boxDepthM &&
            Math.abs(pred.y - GOAL.centerY) <= GOAL.boxHalfWidthM;
          const mateNearer = !hisBall && this.restartTaker !== id &&
            this.bodies.some((m) => m.team === k.team && m.id !== k.id &&
            Math.hypot(this.ball.pos.x - m.pos.x, this.ball.pos.y - m.pos.y) < kD - 1);
          if (!mateNearer) {
            if (kD <= 1.2) {
              this.keeperAttacking.add(id); // full tilt — no shuffle on an attack
              // OUTSIDE his box, arriving on a loose low ball, the sweep ends
              // in a FIRST-TIME boot upfield — no gather (hands are illegal
              // and a bouncing gather loses the race to the arriving runner)
              const outsideBox = Math.abs(this.ball.pos.x - own.x) > GOAL.boxDepthM ||
                Math.abs(this.ball.pos.y - GOAL.centerY) > GOAL.boxHalfWidthM;
              if (outsideBox && kD <= TECH.kickReachM && this.ball.z <= BALL.keeperBootMaxZ &&
                (this.ball.kickerId !== id || this.tick >= this.ball.kickerLockUntilTick)) {
                const upAng = (sign > 0 ? 0 : Math.PI) +
                  this.rng.gauss(0, 0.3, this.tick, id, 'k-boot');
                kickBall(this.ball, { x: k.pos.x + Math.cos(upAng) * 30, y: k.pos.y + Math.sin(upAng) * 30 },
                  16, 25, id, this.tick);
                this.actionLabels.set(id, 'keeper-clear');
                continue;
              }
              // inside the box: claims/saves resolve the pickup
              if (k.command.type !== 'chaseBall') this.assign(k, { type: 'chaseBall', regime: 'sprint' });
              continue;
            } else {
              // the sweep is a RACE, not a receive — the generic chase's
              // receive machine stands on the line and waits (a receiver's
              // politeness) while the bounce drifts past his reach. Attack the
              // EARLIEST ground point on the ball's future path he can beat
              // the ball to, re-read every tick.
              const vcap = Math.max(regimeCapMps(k.attributes.pace, 'sprint'), 0.5);
              const c: BallState = {
                pos: { ...this.ball.pos }, z: this.ball.z, vel: { ...this.ball.vel }, vz: this.ball.vz,
                spin: this.ball.spin, phase: this.ball.phase,
                carrierId: null, kickerId: null, kickerLockUntilTick: 0, touchParity: false,
              };
              // a CROSS in his box he attacks at HANDS' height mid-descent —
              // the earliest claimable point, UPSTREAM of the leapers (aiming
              // at the ground landing always arrived downstream of the header
              // contest: the near-post flick beat him to every corner)
              const zCatch = hisBall ? BALL.keeperClaimMaxZ : BALL.headMinZ;
              let target: Vec2 = { x: this.ball.pos.x, y: this.ball.pos.y };
              for (let i = 1; i <= 30; i++) {
                stepBall(c);
                if (c.z < zCatch) {
                  const dK = Math.hypot(c.pos.x - k.pos.x, c.pos.y - k.pos.y);
                  target = { x: c.pos.x, y: c.pos.y };
                  if (dK / vcap + 0.15 <= i * DT) break; // he beats the ball there
                }
              }
              // a sweep goes FORWARD — out toward the play, where he collects
              // (his box's hands, or feet beyond it). A ball rolling BEHIND
              // him is not a sweep: fall through to the ladder and RETREAT
              // (angle play walks him back goal-side, square to the ball).
              const dTargGoal = Math.hypot(target.x - own.x, target.y - own.y);
              const dKGoal = Math.hypot(k.pos.x - own.x, k.pos.y - own.y);
              if (dTargGoal >= dKGoal - 1) {
                this.keeperAttacking.add(id); // full tilt — no shuffle on an attack
                const cur = k.command.type === 'moveTo' ? k.command.target : null;
                if (!cur || Math.hypot(cur.x - target.x, cur.y - target.y) > 0.3) {
                  this.assign(k, { type: 'moveTo', target, regime: 'sprint' });
                }
                continue;
              }
              // behind him → not a sweep: fall through to the ladder (retreat)
            }
          }
        }
      }
      // NEAR-POST cover: the guarded line runs from the ball to a point shaded
      // toward the post on the ball's side — beaten at the near post is a
      // keeper's sin; the across-goal ball (the long dive) is the honest one
      const shade = Math.max(-1, Math.min(1, (this.ball.pos.y - GOAL.centerY) / 12)) * BALL.keeperNearPostShadeM;
      const anchor = { x: own.x, y: GOAL.centerY + shade };
      const bx = this.ball.pos.x - anchor.x;
      const by = this.ball.pos.y - anchor.y;
      const d = Math.max(Math.hypot(bx, by), 1e-6);
      // the DEPTH is SITUATIONAL — never a fixed post:
      //  · 1v1 RUSH: a lone opponent through (no defending teammate goal-side)
      //    → out to penalty-spot / edge-of-box range to smother it early;
      //  · SWEEPER: own team in possession, or play far upfield → a HIGH line
      //    off his goal, sweeping the space behind the defence;
      //  · else the base angle play, closing down as the ball nears.
      const oppHasBall = ballCarrier !== undefined && ballCarrier.team !== k.team;
      const ownHasBall = ballCarrier !== undefined && ballCarrier.team === k.team;
      const goalSideMates = this.bodies.filter((m) => m.team === k.team && m.id !== k.id &&
        Math.hypot(m.pos.x - own.x, m.pos.y - own.y) < d - 1).length;
      // the breakaway is read EARLY (a lone carrier bearing down from 40 m IS
      // the 1v1) — triggering only inside 30 left the keeper mid-rush when the
      // shot came
      const oneVsOne = oppHasBall && d < 45 && goalSideMates === 0;
      let depth: number;
      if (oneVsOne) {
        // POUNCE vs DELAY — the real 1v1 craft: rush hard only when the ball
        // is AWAY from the striker's feet (a heavy touch, the smother
        // window). At his feet, HOLD ~6 m: stay big, delay — from there the
        // backpedal beats the chip, and from 11 m out nothing does (the chip
        // finding: a keeper that far out cannot recover a good chip, so the
        // craft is not to be there while the striker is in control).
        const cGap = ballCarrier
          ? Math.hypot(this.ball.pos.x - ballCarrier.pos.x, this.ball.pos.y - ballCarrier.pos.y)
          : 99;
        const pounce = ballCarrier === undefined || cGap > 1.6;
        depth = pounce
          ? Math.min(Math.max(d - 7, BALL.keeperCloseGain * (28 - d), BALL.keeperDepthMinM), BALL.keeperRushMaxM)
          : Math.min(Math.max(BALL.keeperCloseGain * (28 - d), BALL.keeperDepthMinM), BALL.keeperDelayDepthM);
      } else if (ownHasBall || d > 45) {
        depth = Math.min(Math.max(BALL.keeperSweepGain * (d - 18), BALL.keeperDepthMinM), BALL.keeperSweepMaxM);
      } else {
        // CLOSING DOWN: come out toward the shooter as the ball nears — the
        // cone narrows toward him, so depth buys coverage (the chip is later)
        depth = Math.min(
          Math.max(BALL.keeperDepthMinM, BALL.keeperCloseGain * (28 - d)),
          BALL.keeperDepthMaxM,
        );
      }
      depth = Math.min(depth, Math.max(0.6, d - 1));
      const spot = { x: anchor.x + (bx / d) * depth, y: anchor.y + (by / d) * depth };
      // near his line he stays in the frame's shadow; further out the guard
      // cone widens with depth (a hard clamp at 16 m would drag him off-line)
      const yRoom = GOAL.mouthHalfWidthM + 0.5 + depth * 0.45;
      spot.y = Math.max(GOAL.centerY - yRoom, Math.min(GOAL.centerY + yRoom, spot.y));
      const cur = k.command.type === 'moveTo' ? k.command.target : null;
      if (!cur || Math.hypot(cur.x - spot.x, cur.y - spot.y) > 0.3) {
        const far = Math.hypot(k.pos.x - spot.x, k.pos.y - spot.y);
        this.assign(k, { type: 'moveTo', target: spot, regime: far > 3 ? 'sprint' : 'run' });
      }
    }
  }

  /** L7 — the SAVE: a free ball THREATENING his goal, within his dive's xyz
   * reach — CAUGHT (held, he becomes the carrier) when slow/low enough for his
   * handling, else PARRIED wide of the mouth. The block's swept footing with a
   * dive's reach (agility) and a catch (firstTouch as handling). Claims on
   * crosses, distribution, and sweeping are later L7 sub-phases. */
  private resolveSaves(from: Vec2): void {
    const ball = this.ball;
    if (ball.carrierId !== null || ball.phase === 'dead') return;
    const speed = Math.hypot(ball.vel.x, ball.vel.y, ball.vz);
    if (speed < 3) return; // a dying ball is an ordinary claim
    for (const id of this.keepers) {
      const k = this.byId.get(id);
      if (!k) continue;
      if (k.id === ball.kickerId && this.tick < ball.kickerLockUntilTick) continue;
      const sign = attackSign(k.team);
      const own = { x: sign > 0 ? 0 : PITCH.length, y: GOAL.centerY };
      // HANDS ARE LEGAL ONLY IN HIS BOX — outside it he is an outfielder
      // (feet: the ordinary claim machinery collects for him out there)
      if (Math.abs(ball.pos.x - own.x) > GOAL.boxDepthM ||
        Math.abs(ball.pos.y - GOAL.centerY) > GOAL.boxHalfWidthM) continue;
      const dGoal = Math.hypot(ball.pos.x - own.x, ball.pos.y - own.y);
      const towardGoal = ball.vel.x * (own.x - ball.pos.x) > 0;
      const shotLike = dGoal <= BALL.keeperEngageM && towardGoal && ball.z <= GOAL.barZ;
      if (!shotLike) {
        // the CROSS in his box — a corner, a whipped ball ACROSS the face
        // (not toward his line, so no shot gate catches it). His hands rule
        // the air: CLAIM (hold) what he can get to and hold; too hot, or
        // contested in the air at height, he PUNCHES it clear — distance
        // over control.
        if (ball.phase !== 'airborne' || ball.z > BALL.keeperClaimMaxZ) continue;
        const { d: dc, at: atc } = this.sweptApproach(k, from);
        if (dc > BALL.keeperClaimReachM) continue;
        const canHold = speed <= BALL.keeperCatchBase + BALL.keeperCatchTouch * k.attributes.firstTouch;
        const contested = this.bodies.some((o) => o.team !== k.team &&
          Math.hypot(o.pos.x - ball.pos.x, o.pos.y - ball.pos.y) <= BALL.keeperPunchContestM);
        if (!canHold || (contested && ball.z >= BALL.keeperPunchMinZ)) {
          // PUNCH — a fist through it, high and far upfield, with scatter
          ball.pos = { x: atc.x, y: atc.y };
          const upAng = (sign > 0 ? 0 : Math.PI) +
            this.rng.gauss(0, BALL.keeperPunchScatterRad, this.tick, k.id, 'punch');
          kickBall(ball, { x: atc.x + Math.cos(upAng) * 25, y: atc.y + Math.sin(upAng) * 25 },
            BALL.keeperPunchSpeed, BALL.keeperPunchLoftDeg, k.id, this.tick);
          this.actionLabels.set(k.id, 'punch');
        } else {
          // CLAIMED — the cross is his, held
          ball.pos = { x: atc.x, y: atc.y };
          ball.z = 0;
          ball.vz = 0;
          ball.spin = 0;
          ball.vel = { x: 0, y: 0 };
          ball.phase = 'carried';
          ball.carrierId = k.id;
          ball.kickerId = null;
          this.keeperHolding = k.id;
          this.keeperHeldSince = this.tick;
          this.completeChases(k.team);
          this.actionLabels.set(k.id, 'claim');
        }
        return; // one pair of hands per tick
      }
      // the SPREAD: point-blank — the SHOOTER right on top of him (the 1v1
      // smother) — he makes himself BIG, arms and legs wide. Gated on the
      // kicker's distance, not the ball's (the ball is always close when a
      // save resolves; gating on it spread him against every 17 m drive).
      const kicker = ball.kickerId ? this.byId.get(ball.kickerId) : undefined;
      const spread = kicker && Math.hypot(kicker.pos.x - k.pos.x, kicker.pos.y - k.pos.y) <= BALL.keeperSpreadRangeM
        ? BALL.keeperSpreadBonusM : 0;
      const reach = BALL.keeperReachBaseM + BALL.keeperReachAgility * k.attributes.agility + spread;
      const { d, at } = this.sweptApproach(k, from);
      if (d > reach) continue;
      // the raised catch floor (a keeper HOLDS a routine shot) is a
      // MATCH-SCALE realism fix — the 1v1 drills pin the raw physics of a
      // stranded keeper (who should NOT catch a shot past him). At match
      // scale the base is higher; drills keep the 9 m/s floor.
      const catchBase = this.brains.size >= 12 ? 19 : BALL.keeperCatchBase; // match keeper holds firmer shots
      // THE STRETCH-HOLD GATE (match scale; drills keep raw physics): a
      // save at the edge of his dive is a PARRY — fingertips don't hold.
      // Attribute-honest twice over: reach is agility's, and the margin a
      // hold needs shrinks with handling (firstTouch).
      const stretchHold = this.brains.size < 12 ||
        reach - d >= BALL.keeperHoldMarginM * (1.4 - 0.04 * k.attributes.firstTouch);
      const catchable = speed <= catchBase + BALL.keeperCatchTouch * k.attributes.firstTouch &&
        ball.z <= BALL.keeperCatchMaxZ && stretchHold;
      ball.pos = { x: at.x, y: at.y };
      ball.vz = 0;
      ball.z = 0;
      ball.spin = 0;
      if (catchable) {
        // held — his ball now
        ball.vel = { x: 0, y: 0 };
        ball.phase = 'carried';
        ball.carrierId = k.id;
        ball.kickerId = null;
        this.keeperHolding = k.id;
        this.keeperHeldSince = this.tick;
        this.completeChases(k.team);
        this.actionLabels.set(k.id, 'save-catch');
      } else {
        // PARRY — turned WIDE: outward through the contact, then rotated away
        // from the centre axis toward the flank (a central palm straight back
        // out tees up the arriving runner — the sweeper finding). Side = the
        // contact's side of goal; dead-central picks the side away from the
        // nearest opponent.
        let side = Math.sign(at.y - own.y);
        if (side === 0 || Math.abs(at.y - own.y) < 0.3) {
          const opp = this.bodies.filter((b) => b.team !== k.team)
            .sort((a, b2) => Math.hypot(a.pos.x - at.x, a.pos.y - at.y) - Math.hypot(b2.pos.x - at.x, b2.pos.y - at.y))[0];
          side = opp ? -Math.sign(opp.pos.y - at.y) || 1 : 1;
        }
        // TIP IT OUT (the recycle fix, MATCH SCALE): a diving parry
        // concedes the CORNER — pushed beyond the byline wide of the
        // post, not palmed into the six-yard box for the rebound (44% of
        // shots recycled; corners ~0). The 1v1 DRILLS pin the raw parry
        // physics (a stranded keeper's parry must not save everything by
        // tipping out), so they keep the old wide-into-play.
        let ang: number;
        let sp: number;
        // only the FULL-STRETCH parry tips behind for the corner; a parry
        // from a set position (beaten by pace, not reach) is pushed WIDE
        // INTO PLAY — with every parry tipping out, corners read 17.5 per
        // team-90 against the ~5 reference on the first measurement
        const atLimit = reach - d < BALL.keeperHoldMarginM * (1.4 - 0.04 * k.attributes.firstTouch) + 0.15;
        if (this.brains.size >= 12 && atLimit) {
          const sgnK = attackSign(k.team);
          const bylineX = sgnK > 0 ? -0.5 : PITCH.length + 0.5;
          const postSide = Math.sign(at.y - GOAL.centerY) || side || 1;
          const target = { x: bylineX, y: GOAL.centerY + postSide * (GOAL.mouthHalfWidthM + 2.5) };
          ang = Math.atan2(target.y - at.y, target.x - at.x) +
            this.rng.gauss(0, 0.25, this.tick, k.id, 'parry');
          sp = Math.max(speed * 0.7, 9); // match parry keeps pace to leave the pitch
        } else if (this.brains.size >= 12) {
          // set-position parry: strong wrists push it wide of the box, live
          ang = Math.atan2(at.y - own.y, at.x - own.x) + side * 0.9 +
            this.rng.gauss(0, 0.3, this.tick, k.id, 'parry');
          sp = Math.max(speed * 0.5, 8);
        } else {
          ang = Math.atan2(at.y - own.y, at.x - own.x) + side * 0.7 +
            this.rng.gauss(0, 0.35, this.tick, k.id, 'parry');
          sp = speed * 0.35;
        }
        ball.vel = { x: Math.cos(ang) * sp, y: Math.sin(ang) * sp };
        ball.vz = sp * 0.22;
        ball.z = 0.01;
        ball.phase = 'airborne';
        ball.carrierId = null;
        ball.kickerId = k.id;
        ball.kickerLockUntilTick = this.tick + 4;
        this.actionLabels.set(k.id, 'save-parry');
      }
      return; // one pair of hands per tick
    }
  }

  /** the 3-D COLLISION — interception in xyz, not xy: a DRIVEN airborne ball
   * (a shot, a cross, a driven pass) that passes through a body deflects off
   * him; one flighted OVER his reach clears. Reach is PER-PLAYER — the same
   * jump the header uses (headStandM + headJumpPerStr·strength), so a stronger
   * man reaches higher. An OPPONENT in the way is a BLOCK; a teammate who is
   * not the intended man is an accidental COLLISION (a hard ball caroms off
   * him). Only the intended receiver is exempt — he is controlling it, not
   * deflecting his own ball. A slow ball is controlled/headed, not deflected.
   * Runs after the deliberate header, before the ground claim. (The keeper — a
   * higher reach and a catch — is L7; the HANDBALL ruling belongs to the Fouls
   * layer, and cannot be a pure-geometry hook here: a ball merely passing OVER
   * a man's head is not a handball, only one his arm deliberately plays is —
   * that needs intent, not a reach test. The per-player reach below is the
   * foundation that layer will build on.) */
  private resolveBlocks(from: Vec2): void {
    const ball = this.ball;
    if (ball.phase !== 'airborne' || ball.z > BALL.headMaxZ) return; // above any reach → clears
    const speed = Math.hypot(ball.vel.x, ball.vel.y, ball.vz);
    if (speed < BALL.blockMinSpeedMps) return; // slow enough to be controlled/headed
    const kicker = ball.kickerId ? this.byId.get(ball.kickerId) : undefined;
    const kickerTeam = kicker?.team;
    let best: { body: BodyState; d: number; at: Vec2 } | null = null;
    for (const body of this.bodies) {
      if (body.id === ball.kickerId && this.tick < ball.kickerLockUntilTick) continue;
      if (body.id === this.intendedReceiverId) continue; // the intended man controls it
      // a teammate ATTACKING the ball (chasing it — a striker onto a cross) is
      // RECEIVING it, not an obstacle; he heads/controls it, he doesn't carom
      if (body.team === kickerTeam && body.command.type === 'chaseBall') continue;
      // PER-PLAYER vertical reach — the same leap the header gates on; a ball
      // above his head passes over (only an arm would reach it — a handball,
      // which is the Fouls layer's call, not here)
      if (ball.z > BALL.headStandM + BALL.headJumpPerStr * body.attributes.strength) continue;
      const { d, at } = this.sweptApproach(body, from);
      if (d > BALL.controlRadiusM) continue;
      if (!best || d < best.d) best = { body, d, at };
    }
    if (!best) return;
    // a BLOCK (opponent, deliberate) or a COLLISION (teammate, accidental) —
    // both deflect loose, but a body not trying to block scrubs less pace off
    const isCollision = kickerTeam !== undefined && best.body.team === kickerTeam;
    const keep = isCollision ? BALL.collisionDeflectKeep : BALL.blockDeflectKeep;
    // a teammate COLLISION reflects (accidental); an opponent BLOCK is a
    // defender getting a body in the way — it deflects roughly AWAY from
    // his own goal (a clearance direction), wide spread, NOT back at the
    // shooter (the +PI reflection fed the shot straight back for the
    // rebound — the recycle loop that made shots 27x real). A block that
    // caroms over the byline is a corner; toward a mate is cleared.
    let ang: number;
    if (isCollision) {
      ang = Math.atan2(ball.vel.y, ball.vel.x) + Math.PI + this.rng.gauss(0, 0.8, this.tick, best.body.id, 'block');
    } else {
      const ownGoal = goalCenter(best.body.team);
      const away = Math.atan2(best.body.pos.y - ownGoal.y, best.body.pos.x - ownGoal.x);
      // (a 0.9 -> 1.25 match widening was tried for carom-behind corners
      // and REVERTED same session: it spiked possessions 578 -> 715 — the
      // wide tail made loose-ball churn, not corners. The parry supplies
      // the class alone; blocks keep the anti-rebound geometry.)
      ang = away + this.rng.gauss(0, 0.9, this.tick, best.body.id, 'block');
    }
    const sp = speed * keep;
    ball.pos = { x: best.at.x, y: best.at.y };
    ball.vel = { x: Math.cos(ang) * sp, y: Math.sin(ang) * sp };
    ball.vz = sp * 0.3;
    ball.phase = 'airborne';
    ball.carrierId = null;
    ball.kickerId = best.body.id;
    ball.kickerLockUntilTick = this.tick + 4;
    ball.spin = 0;
    this.actionLabels.set(best.body.id, isCollision ? 'collision' : 'block');
  }

  /** THE EFFORT ECONOMY (L1's regimes, finally priced). REST IS THE
   * DEFAULT WITH A COST TO LEAVE: a station-holder inside the deadband
   * STANDS; departing rest and each regime escalation is justified only
   * by urgency the SITUATION supplies — computed from ball/possession
   * state here, never claimed by the mover (the utility board's
   * demonstrated maximal-action bias would otherwise have everything
   * claim urgency and the economy becomes a no-op with extra steps).
   * This prices ONLY station-class repositioning — the flattener that
   * was ~50% of every position's distance via the unpriced
   * `d > 8 ? 'run' : 'jog'` default. Duties (press, chase, marks,
   * recovery, the flight-step's sprint) keep their pace: they ARE the
   * urgency. stamina's FIRST consumer: willingness to jog voluntarily
   * scales with it (the fatigue model builds on this later — the
   * sequencing the ledger locks). */
  /** THE COOLDOWN LEAK (the arithmetic thread: same-player dart gaps
   * of 6s against an 11s unfed cooldown): eight paths end a dart;
   * only the dart->ride transition paid the cooldown. The three
   * ELECTION deletions (atStation demotion, boxOccupy reroute,
   * plan-null flip) discarded the run mid-dart with no debt — so any
   * motion that churns ranks (every support trigger) minted free
   * reloads. An unfed dart pays its cooldown HOWEVER it ends. */
  private endDartCooldown(id: string): void {
    const st = this.runPhase.get(id);
    if (!st || st.phase !== 'dart') return;
    if (this.brains.size < 12 || this.intendedReceiverId === id || this.ball.carrierId === id) return;
    const b = this.byId.get(id);
    if (!b) return;
    const cd = 110 - ((b.attributes.stamina ?? 13) - 13) * 6;
    this.dartRest.set(id, this.tick + Math.max(50, cd));
  }

  private stationMove(body: BodyState, d: number, minU: 0 | 1 | 2 = 0, target?: Vec2): { go: boolean; regime: 'walk' | 'glide' | 'jog' | 'run' } {
    // MATCH SCALE ONLY (the drill rule): scenarios pin raw semantics —
    // a 4-man line drill or a cross drill wants its original pace
    if (this.brains.size < 12) return { go: d > 1.5, regime: d > 8 ? 'run' : 'jog' };
    const team = body.team;
    const poss = this.lastPossessTeam;
    const defending = poss !== null && poss !== team;
    const ownGoalX = team === 'home' ? 0 : PITCH.length;
    const gd = Math.hypot(this.ball.pos.x - ownGoalX, this.ball.pos.y - PITCH.width / 2);
    let u: 0 | 1 | 2 = minU;
    if (this.tick - this.lastFlipTick < 30) u = defending ? 2 : (u < 1 ? 1 : u); // transition: reorg keeps pace
    else if (defending) {
      // the BACK LINE's stations track danger — a walked retreat lags the
      // entry and the box phase cannot recover it (the box-entry pin
      // tripped at 18.8 m); the line keeps its legs whenever the ball is
      // in range. Real CB rest comes from slow circulation, not walked
      // retreats. Others: never calm-class (the rest-line pin), urgent
      // only at the box.
      const line = this.backLineHome(body.id, team);
      const tu = gd < 32 ? 2 : line && gd < 48 ? 2 : 1; // 60->48: the frozen-era line needed early starts; a live line (post-repair) can start later and still arrive
      if (tu > u) u = tu as 0 | 1 | 2;
    }
    else {
      const od = Math.hypot(this.ball.pos.x - (PITCH.length - ownGoalX), this.ball.pos.y - PITCH.width / 2);
      if (od < 30 && u < 1) u = 1; // final-third attack: box/support arrivals keep a jog
    }
    // ATTACHMENT CLASS: an opponent standing at (or beside) my destination
    // IS the situation supplying urgency — a shaded/goal-side station only
    // works ATTAINED, and walking it lags the man it shades (measured: fwd
    // pressure 28->17 when shades walked). Marks/shades keep their legs.
    if (u < 2 && target) {
      for (const o of this.bodies) {
        if (o.team === team || this.keepers.has(o.id)) continue;
        if (Math.hypot(o.pos.x - target.x, o.pos.y - target.y) <= 3.5) { u = 2; break; }
      }
    }
    // stamina: high engines volunteer the jog sooner (no-op at 13)
    const will = ((body.attributes.stamina ?? 13) - 13) * 0.4;
    // RETUNED against the REPAIRED population (the original bands were
    // calibrated when 25-34% of defenders were dark — some "rest" was
    // stranded bodies wearing the costume of restraint). Deadbands up:
    // the cost-to-leave binds hardest where stations are stable (CB/FB),
    // which is exactly where the spread compressed — a distribution
    // shift, not a uniform damp. Eligibility untouched by construction.
    const dead = u === 2 ? 2.1 : u === 1 ? 3.4 : 4.2;
    if (d <= dead) return { go: false, regime: 'walk' };
    // THE SCARCITY CAP (the run-oversupply inversion, 4th and FINAL
    // touch of the runTo flattener): a station correction NEVER RUNS at
    // u1 — it glides at jog whatever the distance — and u2's jog band
    // widens 8 -> 12. Above 4 m/s now belongs to the situational
    // classes (darts, chases, presses, transitions), so a departure is
    // a DEPARTURE again (simultaneity p50 was 5 vs real 0-2; 5,678
    // sustained runs per team-90 vs real 400-800, the bulk station
    // repositioning). If this cap does not move simultaneity, the
    // high-speed motion lives elsewhere — that is a finding, not a
    // license to tighten a fifth time.
    if (u === 0) return { go: true, regime: d <= 20 - will ? 'walk' : 'glide' };
    if (u === 1) return { go: true, regime: d <= 11 - will ? 'walk' : 'glide' };
    return { go: true, regime: d <= 3.5 ? 'walk' : d <= 12 ? 'glide' : 'run' };
  }

  private resolveClaims(from: Vec2): void {
    if (this.ball.z > BALL.claimMaxZ || this.ball.phase === 'dead') return;
    if (this.restartLock && this.tick >= this.restartLock.until) this.restartLock = null;
    // closest approach of a body to the ball's swept path — in the BODY'S
    // frame: subtract his own displacement so two fast movers crossing
    // cannot tunnel through each other's reach between samples
    const segNearest = (b: BodyState): { d: number; at: Vec2 } => {
      const prev = this.prevPos.get(b.id) ?? b.pos;
      const bdx = b.pos.x - prev.x;
      const bdy = b.pos.y - prev.y;
      const fx = from.x - bdx;
      const fy = from.y - bdy;
      const dx = this.ball.pos.x - fx;
      const dy = this.ball.pos.y - fy;
      const len2 = dx * dx + dy * dy;
      const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1,
        ((b.pos.x - fx) * dx + (b.pos.y - fy) * dy) / len2));
      const at = { x: fx + dx * t, y: fy + dy * t };
      return { d: Math.hypot(b.pos.x - at.x, b.pos.y - at.y), at };
    };
    // a coupled ball is pinchable only MID-TOUCH, and the pinch is an ARRIVAL
    // RACE for the touch: the stealer must be in reach AND meaningfully
    // closer to the ball than its carrier (a tight touch is protected by
    // proximity; body-shielding arrives at L3). A glued ball cannot be
    // claimed — dispossessing it is an L3 tackle.
    const carrier = this.ball.carrierId ? this.byId.get(this.ball.carrierId) : undefined;
    let carrierGap = Infinity;
    if (carrier) {
      carrierGap = Math.hypot(this.ball.pos.x - carrier.pos.x, this.ball.pos.y - carrier.pos.y);
      if (carrierGap <= BALL.controlRadiusM) return;
    }
    let best: { body: BodyState; d: number; at: Vec2; dEff: number } | null = null;
    let blockBest: { body: BodyState; d: number; at: Vec2 } | null = null;
    for (const b of this.bodies) {
      if (b.id === this.ball.carrierId) continue; // the carrier re-couples, he does not "claim"
      if (this.sentOff.has(b.id)) continue; // off the pitch, out of the game
      if (this.restartTaker && b.id !== this.restartTaker) continue; // the taker's ball
      if (this.restartTaker && this.tick < this.restartSetupUntil) continue; // teams still setting
      if (b.id === this.ball.kickerId && this.tick < this.ball.kickerLockUntilTick) continue;
      // a RESTART is the awarded team's put-back: the other side stands
      // off until the lock expires (L8-minimal)
      if (this.restartLock && this.tick < this.restartLock.until && b.team !== this.restartLock.team) continue;
      // a pass in FLIGHT is protected: while it is fresh (the kicker's lock
      // window), a teammate who is NOT the intended receiver stands off and
      // lets it reach its target — otherwise two stacked teammates in the
      // lane trade a ball meant for a THIRD man (the level-audit corner flap:
      // left passes to mid, the stacked right intercepts, repeat). Opponents
      // still intercept freely; past the window an unmet ball is collectable.
      if (this.intendedReceiverId && b.id !== this.intendedReceiverId &&
        this.tick < this.ball.kickerLockUntilTick) {
        const intended = this.byId.get(this.intendedReceiverId);
        if (intended && b.team === intended.team) continue;
        // the same fresh window gates the OPPONENT the other way: a ball
        // released 0.1 s ago beats human reaction — he cannot READ and
        // CONTROL it (the reach-discriminator: 73% of all cut passes died
        // within 4 m of the boot, the "interceptor" standing p50 0.8 m from
        // the origin, pocketing the release at zero reaction through the
        // 0.9 m sweep). At best the ball strikes his FRAME and ricochets —
        // a ground block, resolved below. His stab reach is the tighter
        // groundBlockRadiusM; wider than that the ball simply goes by. A
        // genuine downfield lane cut is untouched: flight past the window
        // claims exactly as before. (Temporal gate only, no chaseBall
        // exemption — a counterpresser IS on chaseBall, and his chase of
        // the carrier grants no read on the ball's new path.) Three-way
        // symmetry on one window: kicker can't retouch, teammates stand
        // off, opponents block-not-control.
        if (!carrier && intended && b.team !== intended.team) {
          const { d, at } = segNearest(b);
          if (d <= BALL.groundBlockRadiusM && (!blockBest || d < blockBest.d)) blockBest = { body: b, d, at };
          continue;
        }
      }
      // you never steal the ball off your OWN teammate's feet: only an
      // opponent pinches a carrier's live touch. Without this two stacked
      // teammates trade the carrier's popped touch back and forth every tick
      // — the possession ping-pong the level audit measured (a genuinely
      // loose ball, carrierId null, is unaffected: teammates DO collect it).
      if (carrier && b.team === carrier.team) continue;
      // (the pinch stays UNGATED: it is the rider's natural punishment of a
      // long touch, not a lunge — engage-gating it made heavy feet's 2 m
      // touches SAFE and inverted the skill split, while never helping close
      // control, whose losses are collisions, not pinches. Measured both ways.)
      const { d, at } = segNearest(b);
      // THE ARRIVAL DUEL, made expressive (uncoupled balls only — the
      // pinch keeps its tuned margins): candidates extend into the
      // STRETCH band (0.9→1.25 m, degraded contact), and ranking runs on
      // EFFECTIVE distance — agility (the lunge) and tackling (the read)
      // buy up to ±0.12 m. Possession selection finally reads the men.
      const stretchElig = !carrier && this.brains.size >= 12;
      if (d > (stretchElig ? BALL.controlRadiusM + BALL.claimStretchM : BALL.controlRadiusM)) continue;
      if (carrier && d >= carrierGap - BALL.pinchMarginM) continue; // the carrier wins his own touch
      // the carrier's body shields the touch: no pinch without a clear line
      if (carrier) {
        const sx = at.x - b.pos.x;
        const sy = at.y - b.pos.y;
        const len2 = sx * sx + sy * sy;
        const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1,
          ((carrier.pos.x - b.pos.x) * sx + (carrier.pos.y - b.pos.y) * sy) / len2));
        const cx = b.pos.x + sx * t;
        const cy = b.pos.y + sy * t;
        if (Math.hypot(carrier.pos.x - cx, carrier.pos.y - cy) < shieldRadiusM(carrier.attributes)) continue;
      }
      const reachSkill = stretchElig
        ? Math.max(-0.12, Math.min(0.12, ((b.attributes.agility ?? 13) - 13) * 0.02 + ((b.attributes.tackling ?? 13) - 13) * 0.01))
        : 0;
      const dEff = d - reachSkill;
      // near-ties are a genuine 50/50 — a keyed coin, not an id string
      const tie = best !== null && Math.abs(dEff - best.dEff) < 0.06;
      const winTie = tie && this.rng.chance(0.5, this.tick, b.id, 'claim-tie');
      if (!best || (!tie && dEff < best.dEff) || winTie) {
        best = { body: b, d, at, dEff };
      }
    }
    // the GROUND BLOCK fires if no one claims — or if the blocker stands
    // EARLIER along the flight than the claimer (the ball reaches his frame
    // first; a 3 m give-and-go can put both in the same tick's sweep)
    if (blockBest && (!best ||
      Math.hypot(blockBest.at.x - from.x, blockBest.at.y - from.y) <
      Math.hypot(best.at.x - from.x, best.at.y - from.y))) {
      const bb = blockBest.body;
      const speed = Math.hypot(this.ball.vel.x, this.ball.vel.y);
      // same ricochet the airborne block uses: roughly AWAY from his own
      // goal (the clearance direction, never back at the kicker), pace
      // scrubbed, a low hop off the shins
      const ownGoal = goalCenter(bb.team);
      const ang = Math.atan2(bb.pos.y - ownGoal.y, bb.pos.x - ownGoal.x) +
        this.rng.gauss(0, 0.9, this.tick, bb.id, 'block');
      const sp = speed * BALL.blockDeflectKeep;
      this.ball.pos = { x: blockBest.at.x, y: blockBest.at.y };
      this.ball.vel = { x: Math.cos(ang) * sp, y: Math.sin(ang) * sp };
      this.ball.vz = sp * 0.3;
      this.ball.phase = 'airborne';
      this.ball.carrierId = null;
      this.ball.kickerId = bb.id;
      this.ball.kickerLockUntilTick = this.tick + 4;
      this.ball.spin = 0;
      this.actionLabels.set(bb.id, 'block');
      return;
    }
    if (!best) return;
    // the claim is a FIRST TOUCH at the meeting point (L3): control quality
    // vs ball speed/height/pressure — a great touch kills a driven ball
    // dead; a poor one under pressure pops loose, still contested
    // difficulty rides the CLOSING speed: a ball cushioned while running
    // with it is easy; charging into a drive is hard (the moving-receive
    // judgment note)
    const relVx = this.ball.vel.x - best.body.vel.x;
    const relVy = this.ball.vel.y - best.body.vel.y;
    const ballSpeed = Math.hypot(relVx, relVy);
    const rawSpeed = Math.hypot(this.ball.vel.x, this.ball.vel.y);
    const arrivalDir = rawSpeed > 0.1 ? Math.atan2(this.ball.vel.y, this.ball.vel.x) : best.body.facing;
    const pressured = this.bodies.some((o) =>
      o.team !== best.body.team &&
      Math.hypot(o.pos.x - best.body.pos.x, o.pos.y - best.body.pos.y) <= TECH.touchPressureRangeM);
    // the awkward-ball tax: only the INTENDED man pays for the kicker's
    // spray — he anticipated the AIMED line; anyone else (defender,
    // stray teammate) reads the ball as it actually travels
    const spray = best.body.id === this.intendedReceiverId ? this.ball.sprayM ?? 0 : 0;
    const stretch = Math.max(0, best.d - BALL.controlRadiusM);
    const touch = resolveFirstTouch(
      this.rng, this.tick, best.body.id, best.body.attributes, arrivalDir, ballSpeed, this.ball.z, pressured,
      best.body.speed, spray, stretch,
    );
    this.ball.pos = { x: best.at.x, y: best.at.y };
    this.ball.vz = 0;
    this.ball.z = 0;
    if (touch.pop) {
      // the ball squirts — no possession awarded; the pop is itself loose
      this.ball.carrierId = null;
      this.ball.phase = 'rolling';
      this.ball.vel = touch.vel;
      // the fumbler cannot instantly re-claim the same squirt (his touch IS
      // the miss); the kicker-lock mechanism expresses it
      this.ball.kickerId = best.body.id;
      this.ball.kickerLockUntilTick = this.tick + 8;
      return;
    }
    // a PINCH that steals from a live carrier arms the same refractory lock
    // the won tackle and the fumbled pop use: without it the just-
    // dispossessed man (still standing on the ball) re-pinches next tick and
    // the steal is undone — level touch duels oscillated carrier↔pincher
    // every 1–2 ticks (the level-audit finding). Loose-ball claims (no prior
    // carrier) and re-claims by the same body do not lock.
    const stolenFrom = carrier && carrier.id !== best.body.id ? carrier.id : null;
    this.ball.carrierId = best.body.id;
    this.ball.phase = 'carried';
    if (stolenFrom) {
      this.ball.kickerId = stolenFrom;
      this.ball.kickerLockUntilTick = this.tick + BALL.kickerLockTicks;
    }
    // chaseBall races complete NOW so the winner's NEXT command informs the
    // directional touch below — but only for the WINNING side. A chaser whose
    // OPPONENT came up with the ball is not done: his chase becomes the press
    // (standing down for seven seconds after a defender's sweep was the
    // judged give-up)
    this.completeChases(best.body.team);
    // the DIRECTIONAL first touch: a moving receiver sets the ball into his
    // route in stride — a dead-stop trap made him overrun his own ball and
    // circle back for it (the judged 360). Standing receivers kill it dead.
    const rb = best.body;
    if (rb.speed > BALL.standingSpeedMps + 0.4) {
      const dest = currentTarget(rb);
      const travel = dest
        ? Math.atan2(dest.y - rb.pos.y, dest.x - rb.pos.x)
        : Math.atan2(rb.vel.y, rb.vel.x);
      // a racing claim can resolve with the ball BEHIND the runner (his
      // sweep carried him past it) — an in-stride touch must OVERTAKE him,
      // not trail him like a shadow he can never reach: aim at a lead point
      // ahead of the RUNNER and weight the push to get there
      // control TO THE BOOT, ahead: the contact point can be at the heels
      // or beside mid-stride — the touch always originates just in front
      // (a trailing or lateral origin reads as "controlled behind him")
      this.ball.pos = {
        x: rb.pos.x + Math.cos(travel) * 0.35,
        y: rb.pos.y + Math.sin(travel) * 0.35,
      };
      const dir = dest
        ? Math.atan2(dest.y - this.ball.pos.y, dest.x - this.ball.pos.x)
        : Math.atan2(rb.vel.y, rb.vel.x);
      // a CONTESTED scramble claim (opponent in duel range) is a CONTROL
      // touch, never a stride-weight knock — a sprinting duel winner was
      // launching the ball 15–20 m (the judged duel launches)
      const scrapped = this.bodies.some((o) =>
        o.team !== rb.team && Math.hypot(o.pos.x - rb.pos.x, o.pos.y - rb.pos.y) < 3);
      // weight rides the gait: a RUNNER'S continuation touch is a CARRY
      // touch (a proper stride ahead — the cushion weight died at his feet
      // and checked the run); a stepping receiver still cushions
      let push: number;
      if (!scrapped && rb.speed > 3.5) {
        const vmax = topSpeedMps(rb.attributes.pace);
        push = rb.speed * (
          BALL.touchPushBase +
          BALL.touchPushSpeedGain * (rb.speed / vmax) +
          BALL.touchPushControlGain * (1 - rb.attributes.dribbling / 20)
        );
      } else {
        push = rb.speed * (
          TECH.directionalTouchBase +
          TECH.directionalTouchControlGain * (1 - rb.attributes.firstTouch / 20)
        );
      }
      const cap = this.dribbleArriveCap(rb);
      if (cap !== undefined) push = Math.min(push, cap);
      if (scrapped) push = Math.min(push, 3.0); // keep it in the duel
      this.ball.vel = { x: Math.cos(dir) * push, y: Math.sin(dir) * push };
    } else {
      this.ball.vel = { x: 0, y: 0 };
    }
  }

  /** every chaseBall command completes — the race is over (the winner now
   * carries; losers pull their next command) */
  /** L4 — the carrier's continuous evaluation (decide.ts is pure; this is
   * the harness: cadence, execution, and the receive reflex). Bodies without
   * a brain never enter here — scripts own them entirely. */
  private decidePhase(): void {
    if (this.brains.size === 0) return;
    // telemetry: carry segments — from a brain's claim to release/strip/dead
    if (this.telemetry) {
      const c = this.ball.carrierId;
      if (this.openCarry) {
        // a segment SURVIVES the dribble's own touch-and-collect cycle
        // (carrierId flickers null between touches — closing there read
        // open-field retention at 0.24, a pure taxonomy artifact): close
        // only on the carrier's own kick, another body's claim, or death
        const oc = this.openCarry;
        const prev = this.byId.get(oc.carrier);
        const now = c ? this.byId.get(c) : undefined;
        let outcome: string | null = null;
        if (this.openPass && this.openPass.kicker === oc.carrier) outcome = 'released';
        else if (c && c !== oc.carrier) outcome = now && prev && now.team === prev.team ? 'teammate' : 'stripped';
        else if (this.ball.phase === 'dead') outcome = 'dead';
        if (outcome) {
          const pb = this.byId.get(oc.carrier);
          const endU = pb ? pb.pos.x * attackSign(pb.team) : oc.startU;
          this.telemetry({ t: 'carry', dur: this.tick - oc.tick, density: oc.density, outcome, adv: endU - oc.startU });
          this.openCarry = null;
        }
      }
      if (!this.openCarry && c && this.brains.has(c)) {
        const cb0 = this.byId.get(c)!;
        let nOpp = 0;
        for (const b of this.bodies) {
          if (b.team !== cb0.team && Math.hypot(b.pos.x - cb0.pos.x, b.pos.y - cb0.pos.y) < 12) nOpp++;
        }
        this.openCarry = { tick: this.tick, carrier: c, density: Math.min(1, nOpp / 3), startU: cb0.pos.x * attackSign(cb0.team) };
      }
    }
    // telemetry: resolve the open pass when anyone claims or the ball dies
    if (this.openPass && this.telemetry) {
      const c = this.ball.carrierId;
      if (c) {
        const cb3 = this.byId.get(c);
        const kb = this.byId.get(this.openPass.kicker);
        const outcome = c === this.openPass.receiver ? 'complete'
          : cb3 && kb && cb3.team === kb.team ? 'teammate' : 'cut';
        this.telemetry({ t: 'pass', ...this.openPass, outcome, dt: this.tick - this.openPass.tick });
        this.openPass = null;
      } else if (this.ball.phase === 'dead') {
        this.telemetry({ t: 'pass', ...this.openPass, outcome: 'dead', dt: this.tick - this.openPass.tick });
        this.openPass = null;
      }
    }
    // the STEP-IN resolves when the flight ends — however it ended
    if (this.steppingIds.size && (this.ball.carrierId !== null ||
      this.intendedReceiverId === null || this.ball.phase === 'dead')) {
      const cbNow = this.ball.carrierId ? this.byId.get(this.ball.carrierId) : undefined;
      for (const sid of this.steppingIds) {
        const sb = this.byId.get(sid);
        if (!sb) continue;
        if (cbNow && cbNow.team !== sb.team &&
          Math.hypot(cbNow.pos.x - sb.pos.x, cbNow.pos.y - sb.pos.y) < 6) {
          // he arrived — the contest continues as a press (the duel
          // machine rides pressingIds; election can demote him later)
          this.pressingIds.add(sid);
        } else if (sb.command.type === 'chaseBall') {
          // the flight is gone and he isn't on the man — re-enter the
          // block (hold matches every idle-defense gate next reconsider)
          this.assign(sb, { type: 'hold' });
        }
      }
      this.steppingIds.clear();
    }
    // the receive reflex ends when ANYONE ends up with the ball
    if (this.intendedReceiverId && this.ball.carrierId !== null) this.intendedReceiverId = null;
    for (const id of this.brains) {
      const body = this.byId.get(id)!;
      // a PENDING free kick (incl. penalty) belongs to the CEREMONY: the
      // taker's own L4 brain was shooting penalties inside decidePhase
      // before the menu ever saw him as carrier (witnessed: menu never
      // ran in the window; kicker=taker, label empty). Quick kicks are
      // NOT this path — they happen after the menu resolves act='short'
      // and clears the restart; a kick WHILE PENDING is always the
      // defect. The menu owns every pending free-kick ball.
      if (this.restartTaker === id && this.restartType === 'free-kick' && this.ball.carrierId === id) continue;
      if (this.ball.carrierId !== id) {
        this.intents.delete(id);
        if (this.intendedReceiverId === id) {
          // UNIVERSAL RE-ELECTION (builder principle: always weighing the
          // best option, even mid-action): a receiver whose ball is
          // clearly LOST — an opponent beats him to every meet by a real
          // margin — releases the reflex instead of jogging after a lost
          // cause, and re-enters the live game next tick.
          // ground balls only: interceptPoint's tMeet is z-blind, and a
          // man standing UNDER a flighted ball "beats" a receiver it will
          // sail clean over (three aerial pins measured it)
          if (this.tick % DECIDE.reconsiderTicks === 0 && this.ball.z < 0.5 && Math.abs(this.ball.vz) < 2) {
            const mine = this.interceptPoint(body);
            let bestOpp = Infinity;
            for (const o of this.bodies) {
              // only opponents actually CHASING count — the model rates a
              // STANDING man as if he would race optimally, and statues
              // near the landing "beat" receivers they never move for
              if (o.team === body.team || o.command.type !== 'chaseBall') continue;
              bestOpp = Math.min(bestOpp, this.interceptPoint(o).tMeet);
            }
            if (bestOpp + 0.25 < mine.tMeet) {
              this.intendedReceiverId = null;
              this.assign(body, { type: 'hold' });
              this.actionLabels.set(id, 'release');
              continue;
            }
          }
          if (this.runningLine.has(id)) this.bendReceive.add(id);
          this.runningLine.delete(id);
          this.runPhase.delete(id);
          // go meet your pass (chase semantics take it from here: contested
          // flights are raced, quiet ones are received)
          if (body.command.type !== 'chaseBall') this.assign(body, { type: 'chaseBall', regime: 'run' });
          this.actionLabels.set(id, 'receive');
          // scan the field DURING the flight: where does the next ball go?
          // (decide() ignores ball state, so the receiver can evaluate as
          // if he already had it at his feet)
          if (this.tick % DECIDE.reconsiderTicks === 0) {
            const ahead = decide({
              carrier: body,
              bodies: this.perceivedBodies(id),
              ball: this.ball,
              instructions: this.instructions.get(id) ?? {},
              current: null,
              homes: this.homes,
              bounds: this.bounds,
              keepers: this.keepers,
              staggered: this.staggeredSet(),
            });
            const aim = ahead.kind === 'pass' || ahead.kind === 'shoot' || ahead.kind === 'clear' || ahead.kind === 'knock'
              ? Math.atan2(ahead.dest.y - body.pos.y, ahead.dest.x - body.pos.x)
              : ahead.kind === 'carry'
                ? Math.atan2(ahead.target.y - body.pos.y, ahead.target.x - body.pos.x)
                : undefined;
            if (aim !== undefined) this.receiveOpenDir.set(id, aim);
          }
        } else {
          this.receiveOpenDir.delete(id);
          // L5b RUN first, L5a SUPPORT second: an IDLE brain whose team
          // has the ball either attacks the space in behind (riding the
          // last defender's line until the ball is played) or drops to
          // offer an angle. Never overrides a scripted route.
          // "team in possession" includes the ball IN FLIGHT to a teammate
          // — the one-two giver darts DURING his pass's flight, or the
          // wall's instant return beats the run into existence
          const carrierBody = this.ball.carrierId
            ? this.byId.get(this.ball.carrierId)
            : (this.intendedReceiverId && this.intendedReceiverId !== id
              ? this.byId.get(this.intendedReceiverId)
              : undefined);
          if (carrierBody && carrierBody.team === body.team && carrierBody.id !== id &&
            (body.command.type === 'hold' || this.runningLine.has(id) || this.attackIdle.has(id)) &&
            this.tick % DECIDE.reconsiderTicks === 0 &&
            this.tick > (this.scriptedUntil.get(id) ?? -1)) {
            const objective = (this.instructions.get(id)?.objective) ?? 'score';
            // THE LOCAL GAME, attack side (the m11 pilot verdict: every
            // idle attacker ran support/run logic at once — the swarm —
            // and no structured outlet ever stood anywhere): only the TWO
            // nearest teammates play the local support/run game; everyone
            // else holds his FORMATION STATION, block-shifted toward the
            // ball. Drill casts have <=2 idle mates, so the small scenes
            // are untouched.
            let closerMates = 0;
            const myDCar = Math.hypot(carrierBody.pos.x - body.pos.x, carrierBody.pos.y - body.pos.y);
            for (const bid of this.brains) {
              if (bid === id || bid === carrierBody.id) continue;
              const b2 = this.byId.get(bid)!;
              if (b2.team !== body.team) continue;
              if (Math.hypot(carrierBody.pos.x - b2.pos.x, carrierBody.pos.y - b2.pos.y) < myDCar) closerMates++;
            }
            // BOX OCCUPATION (the crossing game's missing half — the
            // refinement round): with my carrier WIDE and ADVANCED, the
            // advanced central attacker does not come short for feet — he
            // HOLDS the box at the spot zone, attacking the delivery.
            // Support logic walked him out every time and no honest cast
            // could produce a cross.
            const boxSign = attackSign(body.team);
            const boxGoalX = boxSign > 0 ? PITCH.length : 0;
            // the SWEATY RUN (builder: 'a square pass to open man in the
            // box to eliminate the goalkeeper completely'): box occupation
            // also arms for a CENTRAL advanced carrier — the cutback and
            // the square ball need bodies IN the box, not just at crosses
            const carrierGoalDist = boxSign > 0 ? PITCH.length - carrierBody.pos.x : carrierBody.pos.x;
            const boxOccupy = objective === 'score' &&
              (Math.abs(carrierBody.pos.y - PITCH.width / 2) >= DECIDE.crossWideM || carrierGoalDist <= 22) &&
              carrierGoalDist <= DECIDE.crossAdvanceM &&
              (boxSign > 0 ? PITCH.length - body.pos.x : body.pos.x) <= 24 &&
              Math.abs(body.pos.y - PITCH.width / 2) < DECIDE.crossWideM;
            // the TWO most advanced teammates keep the RUN GAME even
            // beyond the support rank (the judged lack of attacking
            // options: two supporters + seven statues had no in-behind
            // runs, no dummies) — runPlan itself still gates on room
            let moreAdvanced = 0;
            const advSign = attackSign(body.team);
            for (const bid of this.brains) {
              if (bid === id || bid === carrierBody.id) continue;
              const b2 = this.byId.get(bid)!;
              if (b2.team !== body.team) continue;
              if (advSign * (b2.pos.x - body.pos.x) > 0) moreAdvanced++;
            }
            // THREE runners keep the run game (builder: 'attacking runs
            // are still lacking' at two — a real attack sends both
            // strikers AND an arriving midfielder/winger); in the FINAL
            // THIRD the LATE ARRIVAL joins them — a fourth man level or
            // up to 18 m behind the carrier attacking the line from deep
            const carrierProg2 = advSign > 0 ? carrierBody.pos.x : PITCH.length - carrierBody.pos.x;
            // width-holders are exempt — the chalk-line wingback overlaps
            // on his flank; electing him into a CENTRAL late arrival was
            // eroding the width identity round by round (47 -> 33 -> 21 m)
            const lateArrival = carrierProg2 > 50 && moreAdvanced < 4 &&
              advSign * (body.pos.x - carrierBody.pos.x) > -(10 + 24 * adhere(this.instructions.get(id)?.roam ?? 0.5, 0.5, body.attributes.tactical ?? 11)) &&
              this.instructions.get(id)?.holdWidth !== true;
            const advancedRunner = (advSign * (body.pos.x - carrierBody.pos.x) > 2 && moreAdvanced < 3) || lateArrival;
            // THREE supporters (builder: 'increase the short passing and
            // midfielder runs/support when attacking') — the third man is
            // what turns a wall into a triangle with an exit
            const atStation = closerMates >= 3 && !boxOccupy && !advancedRunner;
            let claimedYs: number[] | undefined;
            if (!boxOccupy && !atStation && objective === 'score') {
              claimedYs = [];
              for (const rid of this.runningLine) {
                if (rid === id) continue;
                const rb2 = this.byId.get(rid);
                if (!rb2 || rb2.team !== body.team) continue;
                const rst = this.runPhase.get(rid);
                claimedYs.push(rst ? (rst.phase === 'dart' ? rst.dartY : (rst.laneY ?? rst.dartY)) : rb2.pos.y);
              }
            }
            const gaveT = this.lastGiveTick.get(id);
            const plan = !boxOccupy && !atStation && objective === 'score' ? runPlan(body, carrierBody, this.perceivedBodies(id), this.keepers, claimedYs) : null;
            if (atStation) {
              this.endDartCooldown(id);
              this.runPhase.delete(id);
              this.runningLine.delete(id);
              const home = this.homes.get(id) ?? body.pos;
              // the RECYCLE OUTLET (the EAFC mesh's constant third body):
              // the CLOSEST stationer stands behind the ball at ~10 m —
              // the safe under-ball option every reference frame shows
              let st;
              if (closerMates === 4) {
                const gSign = attackSign(body.team);
                st = {
                  x: Math.max(2, Math.min(PITCH.length - 2, carrierBody.pos.x - gSign * 9)),
                  y: Math.max(2, Math.min(PITCH.width - 2, carrierBody.pos.y + (home.y >= carrierBody.pos.y ? 4 : -4))),
                };
                this.actionLabels.set(id, 'outlet');
              } else {
                // REST-DEFENSE (builder: 'cb players pushing too high' —
                // measured level with or past the deepest opponent in
                // 17/31 attacking samples): back-line stations stay
                // goal-side of the highest opposing outfielder
                const gainedAt = this.lostPossessionAt.get(body.team === 'home' ? 'away' : 'home') ?? -999;
                let cPress = Infinity;
                for (const o of this.bodies) {
                  if (o.team === body.team) continue;
                  cPress = Math.min(cPress, Math.hypot(o.pos.x - carrierBody.pos.x, o.pos.y - carrierBody.pos.y));
                }
                const settled = this.tick - gainedAt > 25 && cPress > 4;
                const instr = this.instructions.get(id) ?? {};
                const sgnB = attackSign(body.team);
                const joinEff = adhere(instr.joinAttack ?? 0, 0, body.attributes.tactical ?? 11);
                const restBound = this.backLineHome(id, body.team) && joinEff < 0.6;
                const oppU = restBound ? this.oppDeepestU(body.team) : undefined;
                // threat 1 at our box edge, fading to 0.3 by halfway
                const oppProg = oppU === undefined ? 1 : oppU + (sgnB > 0 ? 0 : PITCH.length);
                const oppThreat = Math.max(0.3, Math.min(1, 1 - (oppProg - 15) / 35));
                st = blockStation(home, this.teamCentroid(body.team), this.ball.pos, true, sgnB,
                  instr.lineHeight ?? 0.5, this.teamBrainCount(body.team) + 1,
                  oppU, settled, oppThreat, instr.holdWidth === true, -0.5,
                  adhere(instr.compactness ?? 0.5, 0.5, body.attributes.tactical ?? 11));
                // CB STEPS TO CDM (builder): in BUILD-UP a centre-back
                // pushes into the pivot — station shifts forward toward
                // the DM line and toward center. Only in our own half
                // (build-up), tactical-adhered, back-line only.
                const stepEff = this.backLineHome(id, body.team)
                  ? adhere(instr.stepUp ?? 0, 0, body.attributes.tactical ?? 11) : 0;
                const buildup = (sgnB > 0 ? this.ball.pos.x : PITCH.length - this.ball.pos.x) < 45;
                if (stepEff > 0 && buildup) st = pivotShift(st, sgnB, stepEff * 14, stepEff * 0.7);
                // INVERTED FULLBACK (builder): a wide back tucks INSIDE
                // in possession (into the pivot half-space) rather than
                // overlapping — inward pull, not forward. underlap>0.6 on
                // a back-line WIDE player reads as the invert instruction.
                const isWideBack = this.backLineHome(id, body.team) &&
                  Math.abs((this.baseHomes.get(id)?.y ?? 34) - PITCH.width / 2) > 12;
                const invEff = isWideBack
                  ? Math.max(0, adhere(instr.underlap ?? 0.5, 0.5, body.attributes.tactical ?? 11) - 0.6) / 0.4 : 0;
                if (invEff > 0) st = pivotShift(st, sgnB, invEff * 6, invEff * 0.6);
              }
              const dSt = Math.hypot(st.x - body.pos.x, st.y - body.pos.y);
              this.attackIdle.add(id);
              // THE MESH-SUPPORT DUTY: a candidate to occupy the 6-16m ring
              // glides IN (never through the deadband machinery — that is
              // the exemption), briefly, then returns to station discipline.
              let meshT: Vec2 | null = null;
              if (this.brains.size >= 12 && this.ball.carrierId && carrierBody &&
                carrierBody.team === body.team && !this.keepers.has(id) &&
                this.instructions.get(id)?.holdWidth !== true) {
                const active = this.meshDuty.get(id);
                const dCar = Math.hypot(carrierBody.pos.x - body.pos.x, carrierBody.pos.y - body.pos.y);
                // INTERCEPT, NOT TAIL (the attribution probe's half-(b):
                // mesh 1-2 at carry start decays to 0 by +40 while the
                // carrier advances 13-30m — a glide filler chasing the
                // carrier's CURRENT position loses the arrival race by
                // construction). The ring anchors to the carrier's
                // PROJECTED position (1.5s lead, bounded 10m) — the same
                // principle as chaseBall's intercept point. Regime,
                // duration, cooldown, concurrency all unchanged.
                const meshRing = (): Vec2 => {
                  const px = carrierBody.pos.x + Math.max(-10, Math.min(10, carrierBody.vel.x * 1.5));
                  const py = carrierBody.pos.y + Math.max(-10, Math.min(10, carrierBody.vel.y * 1.5));
                  const dx = body.pos.x - px;
                  const dy = body.pos.y - py;
                  const dP = Math.max(0.1, Math.hypot(dx, dy));
                  return { x: px + (dx / dP) * 11, y: py + (dy / dP) * 11 };
                };
                if (active !== undefined && this.tick < active && dCar > 9) {
                  meshT = meshRing();
                } else if (active === undefined && dCar > 16 && dCar <= 21 &&
                  this.tick >= (this.meshRest.get(id) ?? 0)) { // iter 2 (band 23/cooldown 60) went BACKWARD — movers expired mid-journey; iter-1 bound restored
                  let concurrent = 0;
                  for (const [mid, mu] of this.meshDuty) {
                    const mb = this.byId.get(mid);
                    if (mb && mb.team === body.team && this.tick < mu) concurrent++;
                  }
                  if (concurrent < 2) {
                    this.meshDuty.set(id, this.tick + 25);
                    this.meshRest.set(id, this.tick + 85);
                    meshT = meshRing();
                  }
                }
                if (active !== undefined && this.tick >= active) this.meshDuty.delete(id);
              }
              if (meshT) {
                this.assign(body, {
                  type: 'moveTo',
                  target: { x: Math.max(2, Math.min(PITCH.length - 2, meshT.x)), y: Math.max(2, Math.min(PITCH.width - 2, meshT.y)) },
                  regime: 'glide',
                });
                this.actionLabels.set(id, 'mesh');
                continue;
              }
              const mvSt = this.stationMove(body, dSt);
              if (mvSt.go) {
                this.assign(body, { type: 'moveTo', target: st, regime: mvSt.regime });
                this.actionLabels.set(id, 'station');
              } else if (body.command.type !== 'hold') {
                this.assign(body, { type: 'hold' });
              }
            } else if (boxOccupy) {
              this.endDartCooldown(id);
              this.runPhase.delete(id);
              this.runningLine.delete(id);
              // MULTI-MAN box occupation (the EAFC 71:10 frame: a box
              // attack packs 4-6 bodies at near post / spot / far post —
              // ours sent one): up to three qualifying attackers take
              // SLOTS, ranked by advancement; the fourth-plus stations.
              let aheadOfMe = 0;
              for (const bid of this.brains) {
                if (bid === id || bid === carrierBody.id) continue;
                const b2 = this.byId.get(bid)!;
                if (b2.team !== body.team) continue;
                const qualifies = (boxSign > 0 ? PITCH.length - b2.pos.x : b2.pos.x) <= 24 &&
                  Math.abs(b2.pos.y - PITCH.width / 2) < DECIDE.crossWideM;
                if (qualifies && boxSign * (b2.pos.x - body.pos.x) > 0) aheadOfMe++;
              }
              const slots = [
                { x: boxGoalX - boxSign * 12, y: PITCH.width / 2 + (body.pos.y >= PITCH.width / 2 ? 2.5 : -2.5) },
                { x: boxGoalX - boxSign * 7, y: PITCH.width / 2 - 6 },
                { x: boxGoalX - boxSign * 7, y: PITCH.width / 2 + 6 },
              ];
              const station = { ...slots[Math.min(aheadOfMe, 2)] };
              // ONSIDE clamp (the offside law era): a box slot beyond the
              // second-last defender parks its man permanently flagged —
              // unpassable, and a whistle the moment the cross comes. He
              // holds the line's shoulder and attacks the slot late.
              // ...AND THE BALL CLAUSE (the wing-phase deadlock's cut):
              // offside requires being beyond the second-last defender
              // AND the ball — the adjudication (updateOffside) and the
              // pricing (offsideBy) both carry the clause; this clamp
              // alone omitted it, so with a teammate coupled DEEP AND
              // WIDE (the crossFeed situation) the box stayed legally
              // occupiable yet unoccupied (WAC box p50 0, crosses from
              // 39 WAC episodes: 0). A runner behind the BALL is onside
              // anywhere: the shoulder-hold survives for early balls
              // (ball behind the line leaves the clamp unchanged); the
              // deep wide carry RELEASES the box, committed on the
              // situation, not the delivery.
              if (this.brains.size >= 12) {
                const oppUs2 = this.bodies.filter((b) => b.team !== body.team)
                  .map((b) => b.pos.x * boxSign).sort((a, b) => b - a);
                const lineU2 = oppUs2[1];
                const ballU2 = this.ball.pos.x * boxSign;
                const onsideU = Math.max(lineU2 ?? -Infinity, ballU2) - 1;
                if (Number.isFinite(onsideU) && station.x * boxSign > onsideU) {
                  station.x = onsideU * boxSign;
                }
              }
              const dSt = Math.hypot(station.x - body.pos.x, station.y - body.pos.y);
              const mvBx = this.stationMove(body, dSt);
              if (mvBx.go) {
                this.assign(body, { type: 'moveTo', target: station, regime: mvBx.regime });
              } else if (body.command.type !== 'hold') {
                this.assign(body, { type: 'hold' });
              }
              this.actionLabels.set(id, 'box');
              this.attackClaims.get(body.team)!.push(station);
              this.attackIdle.add(id);
            } else if (plan) {
              // the RUN CYCLE: approach → RIDE the line (reload, jog) →
              // DART (sprint diagonally across the blind side into the
              // adjacent seam — pace is built BEFORE the ball is played;
              // the release meets the dart, not the other way around) →
              // if no ball comes, drop back to ride and go again
              const sign = body.team === 'home' ? 1 : -1;
              // the runner HOVERS a few meters OFF the line and attacks it
              // in bursts — riding glued to the line left a straight dart
              // nowhere to go (instant termination, zero pace, no breach:
              // the judged stall). The reload depth is what makes pace at
              // the breach possible.
              const hoverX = sign > 0
                ? Math.min(plan.target.x, plan.lineX - 5)
                : Math.max(plan.target.x, plan.lineX + 5);
              // THE BENT RUN (builder: 'attackers always sprint through
              // lines to decoy, attract, or have enough speed'): the dart
              // sprints TO the line and RIDES ALONG IT at full pace —
              // never crossing early (an early breach is a tag, and the
              // old +2 m target taught the run game timidity). The BREACH
              // is the receive reflex's job the moment the thread is in
              // flight — by then crossing is legal, and the runner hits
              // it already at top speed. The decoy value is free: a man
              // sprinting the line drags its defenders whether or not
              // the ball ever comes. (Still THROUGH-aimed relative to
              // his approach — a target AT his feet arrive-brakes.)
              // ...and the bend exists BECAUSE of the offside law — in a
              // drill (no law) the through-line dart IS the right run,
              // and bending it broke two drill pins instantly
              const ballComing = this.intendedReceiverId === id;
              // THE CROSS-ATTACK DART (the box-occupancy fix, bound to the
              // wide-ball situation only): an unfed dart's destination was
              // THE LINE (+2) — only a fed dart went beyond, so the box
              // stayed empty (91% zero-occupancy at wide-ball ticks) while
              // the cross needs its target IN the box before it is struck.
              // With a teammate coupled WIDE-ADVANCED (the cross gates) and
              // a central lane, the dart attacks the DELIVERY ZONE unfed.
              const crossFeed = this.brains.size >= 12 && carrierBody && carrierBody.id !== id &&
                !this.keepers.has(carrierBody.id) &&
                Math.abs(carrierBody.pos.y - PITCH.width / 2) >= 13 &&
                (sign > 0 ? PITCH.length - carrierBody.pos.x : carrierBody.pos.x) <= 32 &&
                Math.abs(plan.target.y - PITCH.width / 2) < GOAL.boxHalfWidthM;
              const bent = this.brains.size >= 12 && !ballComing && !crossFeed;
              const beyond = ballComing ? 10 : crossFeed ? 6 : 2;
              // THE THREAT RUN (the second watch: "no line-breaking runs...
              // as if scared of being offside" — literally true: the bent
              // dart rode AT the line, never beyond). The dart phase now
              // BREAKS the line by 3 m — unfed and mostly unfeedable there
              // (offsideBy prices the flagged ball away) — and the phase
              // end IS the check-back. The line, which holds level with the
              // deepest attacker (lineTarget = oppDeepU + trapUp), drops
              // with him: the space the run buys is between the lines, and
              // it is bought by the WORLD moving, not by a reweighted board.
              // THE COMMITTED DART (the deadlock's cut, half 1): with a
              // coupled carrier the dart targets REAL depth — runPlan's
              // own goalline-8 point, overshot by 6 so it never
              // arrive-brakes (the knock-past lesson). It no longer ends
              // on line-approach: it ends on BALL-ARRIVAL or BALL-DEAD.
              // Offside-at-death is the dummy run, a positive.
              const committed = this.brains.size >= 12 && this.ball.carrierId !== null &&
                carrierBody && carrierBody.id !== id;
              const dartX = committed && !ballComing
                ? plan.target.x + sign * 6
                : !bent
                  ? (sign > 0 ? plan.lineX + beyond : plan.lineX - beyond)
                  : (sign > 0 ? plan.lineX + 3 : plan.lineX - 3);
              const atHover = Math.abs(body.pos.x - hoverX) < 1.6;
              let st = this.runPhase.get(id);
              if (!st) {
                const gave = this.lastGiveTick.get(id);
                const oneTwo = gave !== undefined && this.tick - gave <= 12;
                st = { phase: oneTwo ? 'dart' : 'ride', since: this.tick, dartY: plan.dartY, lineX: plan.lineX, laneY: plan.target.y };
                this.runPhase.set(id, st);
              }
              st.lineX = plan.lineX;
              st.laneY = plan.target.y; // the LIVE lane — claims went stale
              // at the last dart's y while riders converged on a fresh seam
              const straight = Math.abs(st.dartY - body.pos.y) < 2;
              const atDartEnd = straight
                ? (sign > 0 ? body.pos.x >= plan.lineX - 0.2 : body.pos.x <= plan.lineX + 0.2)
                : Math.abs(body.pos.y - st.dartY) < 1.2;
              // LAUNCH TRIGGER (the probe's refinement: 59% of darts timed
              // out UNFED — runs launched at nobody): a dart needs a FEEDER
              // — a coupled carrier in range — not just a timer. The one-two
              // keeps its instant launch (fed by construction).
              const oneTwoNow = gaveT !== undefined && this.tick - gaveT <= 12;
              const rested = this.brains.size < 12 || this.tick >= (this.dartRest.get(id) ?? 0);
              const feeder = this.brains.size < 12 || (this.ball.carrierId !== null && carrierBody &&
                Math.hypot(carrierBody.pos.x - body.pos.x, carrierBody.pos.y - body.pos.y) < 38);
              if (st.phase === 'ride' && atHover && this.tick - st.since >= 7 &&
                ((rested && feeder) || oneTwoNow)) {
                st.phase = 'dart';
                st.since = this.tick;
                st.dartY = plan.dartY;
              } else if (st.phase === 'dart' &&
                (committed
                  ? (this.tick - st.since >= 40 || this.ball.carrierId === id ||
                     this.ball.phase === 'dead' || ballComing === false && this.intendedReceiverId !== null && this.intendedReceiverId !== id)
                  : (this.tick - st.since >= 26 || atDartEnd))) {
                st.phase = 'ride';
                st.since = this.tick;
                // UNFED = the commitment cost falls due: cooldown before the
                // next launch, stamina-scaled (real runs recur ~30-60s; the
                // free reload was 0.7s)
                if (this.brains.size >= 12 && this.intendedReceiverId !== id && this.ball.carrierId !== id) {
                  const cd = 110 - ((body.attributes.stamina ?? 13) - 13) * 6;
                  this.dartRest.set(id, this.tick + Math.max(50, cd));
                }
              }
              this.attackClaims.get(body.team)!.push({ x: dartX, y: st.phase === 'dart' ? st.dartY : plan.target.y });
              if (st.phase === 'dart') {
                // the bent run rides ALONG the line — overshoot the seam
                // laterally so the sprint never arrive-brakes (aiming AT
                // the line braked the runner to a walk on it: the
                // knock-past lesson's FOURTH appearance, and it gutted
                // both line speed and the release gate's up-to-speed
                // check); the phase still ends at the seam itself
                // ...but only a genuinely LATERAL dart overshoots — when
                // the seam is where the runner already stands, an 8 m
                // overshoot sent him sprinting AWAY from the very gap he
                // owned (the tick-178 frame: the striker between the CBs
                // running across the gap instead of attacking it); the
                // straight dart pumps in and out of the line instead
                const lateral = Math.abs(st.dartY - body.pos.y) > 3;
                const overshootY = bent && lateral
                  ? st.dartY + Math.sign(st.dartY - body.pos.y || 1) * 8
                  : st.dartY;
                this.assign(body, {
                  type: 'moveTo',
                  target: { x: dartX, y: Math.max(2, Math.min(PITCH.width - 2, overshootY)) },
                  regime: 'sprint',
                });
                this.actionLabels.set(id, 'dart');
              } else {
                const dHov = Math.hypot(hoverX - body.pos.x, plan.target.y - body.pos.y);
                const mvR = this.stationMove(body, dHov, 1);
                this.assign(body, {
                  type: 'moveTo',
                  target: { x: hoverX, y: plan.target.y },
                  regime: atHover ? (this.brains.size >= 12 ? 'walk' : 'jog') : mvR.regime,
                });
                this.actionLabels.set(id, 'run');
              }
              this.runningLine.add(id);
            } else {
              this.endDartCooldown(id);
              this.runPhase.delete(id);
              this.runningLine.delete(id);
              // support RE-EVALUATES like a station does (the hold gate
              // froze supporters mid-walk on stale targets while play
              // moved on — 'support' fired 70 assignments to station's
              // 1891 in the census, and the triangles never formed)
              const tac = body.attributes.tactical ?? 11;
              const inst = this.instructions.get(id) ?? {};
              const spot = supportSpot(
                body, carrierBody, this.perceivedBodies(id), this.homes.get(id) ?? body.pos, objective,
                adhere(inst.roam ?? 0.5, 0.5, tac),
                this.attackClaims.get(body.team),
                adhere(inst.underlap ?? 0.5, 0.5, tac),
                adhere((inst.overloadSide ?? 0) / 2 + 0.5, 0.5, tac) * 2 - 1,
              );
              this.attackClaims.get(body.team)!.push(spot);
              const d = Math.hypot(spot.x - body.pos.x, spot.y - body.pos.y);
              this.attackIdle.add(id);
              const mvSp = this.stationMove(body, d);
              if (mvSp.go) {
                this.assign(body, { type: 'moveTo', target: spot, regime: mvSp.regime });
                this.actionLabels.set(id, 'support');
              } else if (body.command.type !== 'hold') {
                this.assign(body, { type: 'hold' });
              }
            }
          }
          // UNIVERSAL RE-ELECTION, pursuit side (builder principle): a
          // chasing brain who is NO LONGER his team's claimant — the
          // election moved on, or his own side now has the ball — stops
          // the chase and re-enters the idle game (nothing ever demoted
          // an obsolete chaser before: once in chaseBall, forever in
          // chaseBall). The duel presser (pressingIds) and the live
          // receiver are exempt — those are owned elsewhere.
          if (this.tick % DECIDE.reconsiderTicks === 0 &&
            body.command.type === 'chaseBall' &&
            (!this.pressingIds.has(id) || this.ball.phase === 'dead') &&
            this.intendedReceiverId !== id &&
            this.tick > (this.scriptedUntil.get(id) ?? -1)) {
            // a SCRIPTED chase gets 2 s of grace — drills time runs by
            // sending the chase before the ball is struck (the aerial
            // through-ball runner was demoted mid-preparation)
            const ownBall = carrierBody !== undefined && carrierBody.team === body.team &&
              this.tick - (this.scriptedUntil.get(id) ?? -999) > 20;
            let closerChase = 0;
            if (!ownBall && this.ball.carrierId === null) {
              const myD = Math.hypot(this.ball.pos.x - body.pos.x, this.ball.pos.y - body.pos.y);
              for (const bid of this.brains) {
                if (bid === id) continue;
                const b2 = this.byId.get(bid)!;
                if (b2.team !== body.team) continue;
                if (Math.hypot(this.ball.pos.x - b2.pos.x, this.ball.pos.y - b2.pos.y) < myD) closerChase++;
              }
            }
            if ((ownBall || this.ball.phase === 'dead' ||
              (this.ball.carrierId === null && closerChase >= 2)) &&
              this.restartTaker !== id) {
              // (the taker is never released — his 'closer' mates are
              // barred from the ball, and the demotion left a restart
              // standing unclaimed for 12 s in the census)
              this.assign(body, { type: 'hold' });
              this.pressingIds.delete(id);
              this.actionLabels.set(id, 'release');
            }
          }
          // RESTART CEREMONY, both sides: the taker walks to his ball;
          // opponents near the spot back off (nobody contests a restart)
          if (this.restartTaker === id && this.ball.carrierId === null &&
            this.ball.phase !== 'dead' &&
            this.tick % DECIDE.reconsiderTicks === 0 &&
            this.tick > (this.scriptedUntil.get(id) ?? -1)) {
            if (body.command.type !== 'chaseBall') this.assign(body, { type: 'chaseBall', regime: 'run' });
            this.actionLabels.set(id, 'take');
            continue;
          }
          if (this.restartTaker && this.ball.carrierId === null && this.ball.phase !== 'dead' &&
            this.tick % DECIDE.reconsiderTicks === 0 &&
            this.tick > (this.scriptedUntil.get(id) ?? -1)) {
            const tkB = this.byId.get(this.restartTaker);
            // the WALL takes its post (and re-enters defense via
            // shapeHolding when the ceremony resolves)
            const ws = this.wallSpots.get(id);
            if (ws && tkB && body.team !== tkB.team) {
              const dW = Math.hypot(ws.x - body.pos.x, ws.y - body.pos.y);
              if (dW > 0.6) this.assign(body, { type: 'moveTo', target: ws, regime: dW > 8 ? 'run' : 'jog' });
              else if (body.command.type !== 'hold') this.assign(body, { type: 'hold' });
              this.shapeHolding.add(id);
              this.actionLabels.set(id, 'wall');
              continue;
            }
            // the PENALTY ceremony: everyone but the taker clears the box
            if (this.restartPenalty && tkB && id !== this.restartTaker) {
              const nearHome = this.ball.pos.x < PITCH.length / 2;
              const inBox = (nearHome ? body.pos.x < GOAL.boxDepthM + 1 : body.pos.x > PITCH.length - GOAL.boxDepthM - 1) &&
                Math.abs(body.pos.y - PITCH.width / 2) < GOAL.boxHalfWidthM + 1;
              if (inBox) {
                const outX = nearHome ? GOAL.boxDepthM + 2.5 : PITCH.length - GOAL.boxDepthM - 2.5;
                this.assign(body, { type: 'moveTo', target: { x: outX, y: Math.max(6, Math.min(PITCH.width - 6, body.pos.y)) }, regime: 'jog' });
                this.actionLabels.set(id, 'clear-box');
                continue;
              }
            }
            // the ATTACK sets its box before a delivery restart: the three
            // most advanced teammates take the slots while the taker waits
            if (tkB && body.team === tkB.team && id !== this.restartTaker &&
              (this.restartType === 'corner' ||
                (this.restartType === 'free-kick' && !this.restartPenalty &&
                  Math.hypot(goalCenter(tkB.team).x - this.ball.pos.x, goalCenter(tkB.team).y - this.ball.pos.y) <= 40))) {
              const bSign = attackSign(body.team);
              const bGoalX = bSign > 0 ? PITCH.length : 0;
              let aheadCt = 0;
              for (const bid2 of this.brains) {
                if (bid2 === id || bid2 === this.restartTaker) continue;
                const b3 = this.byId.get(bid2)!;
                if (b3.team !== body.team) continue;
                if (bSign * (b3.pos.x - body.pos.x) > 0) aheadCt++;
              }
              if (aheadCt < 3) {
                const slots2 = [
                  { x: bGoalX - bSign * 11, y: PITCH.width / 2 },
                  { x: bGoalX - bSign * 7, y: PITCH.width / 2 - 6 },
                  { x: bGoalX - bSign * 7, y: PITCH.width / 2 + 6 },
                ];
                const st2 = { ...slots2[aheadCt] };
                // onside at free kicks (corners are exempt by law)
                if (this.restartType === 'free-kick') {
                  const oppU3 = this.bodies.filter((b3) => b3.team !== body.team && !this.sentOff.has(b3.id))
                    .map((b3) => b3.pos.x * bSign).sort((a2, b4) => b4 - a2);
                  const line3 = oppU3[1];
                  if (line3 !== undefined && st2.x * bSign > line3 - 1) st2.x = (line3 - 1) * bSign;
                }
                const dSt2 = Math.hypot(st2.x - body.pos.x, st2.y - body.pos.y);
                const mvB2 = this.stationMove(body, dSt2);
                if (mvB2.go) this.assign(body, { type: 'moveTo', target: st2, regime: mvB2.regime });
                else if (body.command.type !== 'hold') this.assign(body, { type: 'hold' });
                this.attackIdle.add(id);
                this.actionLabels.set(id, 'box');
                continue;
              }
            }
            if (tkB && body.team !== tkB.team) {
              const dRb = Math.hypot(this.ball.pos.x - body.pos.x, this.ball.pos.y - body.pos.y);
              if (dRb < 9) {
                const ang = Math.atan2(body.pos.y - this.ball.pos.y, body.pos.x - this.ball.pos.x);
                const back = {
                  x: Math.max(2, Math.min(PITCH.length - 2, this.ball.pos.x + Math.cos(ang) * 10.5)),
                  y: Math.max(2, Math.min(PITCH.width - 2, this.ball.pos.y + Math.sin(ang) * 10.5)),
                };
                this.assign(body, { type: 'moveTo', target: back, regime: 'jog' });
                this.actionLabels.set(id, 'retreat');
                continue;
              }
            }
          }
          // KEEPER STANDOFF (builder: 'players gathering around GK, they
          // should stay away, sort of repelled'): a keeper HOLDING the
          // ball in his hands is untouchable — pressing him is wasted
          // motion and looked like a scrum. Opponents inside 7 m ring
          // OUT to the edge and hold; one man may shadow the release
          // from 7 m but no closer. Also applies while a GOAL-KICK taker
          // (a keeper) has not yet kicked.
          if (this.brains.size >= 12 && this.tick % DECIDE.reconsiderTicks === 0 &&
            this.tick > (this.scriptedUntil.get(id) ?? -1)) {
            const heldKeeper = this.keeperHolding ? this.byId.get(this.keeperHolding) : undefined;
            const gkTaker = (this.restartType === 'goal-kick' && this.restartTaker)
              ? this.byId.get(this.restartTaker) : undefined;
            const shield = heldKeeper ?? gkTaker;
            // the whole BOX is off-limits during a pending goal kick
            if (this.goalKickPending && this.goalKickPending !== body.team) {
              const nearHome = (this.goalKickPending === 'home');
              const inBox = (nearHome ? body.pos.x < GOAL.boxDepthM + 1 : body.pos.x > PITCH.length - GOAL.boxDepthM - 1) &&
                Math.abs(body.pos.y - PITCH.width / 2) < GOAL.boxHalfWidthM + 1;
              if (inBox) {
                const edge = { x: nearHome ? GOAL.boxDepthM + 2.5 : PITCH.length - GOAL.boxDepthM - 2.5, y: Math.max(6, Math.min(PITCH.width - 6, body.pos.y)) };
                const dE = Math.hypot(edge.x - body.pos.x, edge.y - body.pos.y);
                if (dE > 1) this.assign(body, { type: 'moveTo', target: edge, regime: 'run' });
                else if (body.command.type !== 'hold') this.assign(body, { type: 'hold' });
                this.pressingIds.delete(id);
                this.shapeHolding.add(id);
                this.actionLabels.set(id, 'box-out');
                continue;
              }
            }
            if (shield && shield.team !== body.team) {
              const dK = Math.hypot(shield.pos.x - body.pos.x, shield.pos.y - body.pos.y);
              if (dK < 7) {
                const ang = Math.atan2(body.pos.y - shield.pos.y, body.pos.x - shield.pos.x) ||
                  (attackSign(body.team) > 0 ? Math.PI : 0);
                const ring = {
                  x: Math.max(2, Math.min(PITCH.length - 2, shield.pos.x + Math.cos(ang) * 7.5)),
                  y: Math.max(2, Math.min(PITCH.width - 2, shield.pos.y + Math.sin(ang) * 7.5)),
                };
                const dRing = Math.hypot(ring.x - body.pos.x, ring.y - body.pos.y);
                if (dRing > 1) this.assign(body, { type: 'moveTo', target: ring, regime: 'jog' });
                else if (body.command.type !== 'hold') this.assign(body, { type: 'hold' });
                this.pressingIds.delete(id);
                this.shapeHolding.add(id); // re-enters the defending chain when the ring lifts
                this.actionLabels.set(id, 'standoff');
                continue;
              }
            }
          }
          // L5d COUNTERPRESS (before everything): the 5–8 s transition
          // instinct — chase the ball you just lost (loose OR opponent-
          // carried), overriding stale attack commands; organized defense
          // below still requires idleness
          {
            const lostAt = this.lostPossessionAt.get(body.team) ?? -999;
            const oppHasIt = carrierBody !== undefined && carrierBody.team !== body.team;
            // a DEAD ball is not a loose ball — two players ground at an
            // out-of-play ball against the boundary clamp for 12+ ticks
            // (the interpenetration pin caught the pile-up)
            const takerB2 = this.restartTaker ? this.byId.get(this.restartTaker) : undefined;
            const looseBall = this.ball.carrierId === null && this.intendedReceiverId === null &&
              this.ball.phase !== 'dead' && !(takerB2 && takerB2.team === body.team);
            // counterpress is INNATE — even 'keep' brains hunt the ball
            // they just lost (it is literally the rondo's rule); the keep
            // gate below only blocks ORGANIZED defense
            const myBallDist = Math.hypot(this.ball.pos.x - body.pos.x, this.ball.pos.y - body.pos.y);
            // GEGENPRESS (builder): the counterpress instruction scales
            // the 5-second-rule window, its radius, and how many hunt —
            // tactical-adhered (a disciplined presser executes the plan)
            const cpI = adhere(this.instructions.get(id)?.counterpress ?? 0.5, 0.5, body.attributes.tactical ?? 11);
            const cpWindow = 40 + Math.round(cpI * 60); // 40..100 ticks
            const cpRadius = 10 + cpI * 12; // 10..22 m
            if (this.tick - lostAt <= cpWindow && (oppHasIt || looseBall) &&
              this.tick % DECIDE.reconsiderTicks === 0 &&
              this.tick > (this.scriptedUntil.get(id) ?? -1) &&
              myBallDist < cpRadius &&
              // a restart is not a transition — the counterpress instinct
              // ignored the claim lock and hunted the other team's ball
              !(this.restartLock && this.tick < this.restartLock.until && body.team !== this.restartLock.team)) {
              // counterpress is ELECTED too: the nearest man (or anyone
              // right on the ball) hunts; the rest keep balance — the
              // swarm re-created the double-chase the shadow exists to fix
              const teamBrains = [...this.brains].filter((bid) => {
                const b2 = this.byId.get(bid)!;
                return b2.team === body.team && this.tick > (this.scriptedUntil.get(bid) ?? -1);
              });

              // the PURSUIT CAP (the m11 swarm: seven chasers at once):
              // the two nearest hunt; everyone else keeps his structure.
              // Ranked by INTERCEPT TIME — on a rolling ball, distance to
              // the current spot elects the wrong man (the tick-802 race)
              // a BACK-LINE defender counterpresses only when CLEARLY
              // first (+0.5 s handicap): the election was position-blind
              // and a CB who happened to be near the flip point hunted
              // into the opponent corner 40 m from his line partner (the
              // tick-293 spacing frame) while midfielders stood by
              // a back-line defender counterpresses only when clearly
              // first (+0.5 s handicap): the line holds, mids press
              const myMeet = this.interceptPoint(body).tMeet +
                (this.backLineHome(id, body.team) ? 0.5 : 0);
              let closerCp = 0;
              for (const bid of teamBrains) {
                if (bid === id) continue;
                const b2 = this.byId.get(bid)!;
                if (this.interceptPoint(b2).tMeet < myMeet) closerCp++;
              }
              // vs a CARRIED ball, ONE man commits (the elected press is
              // the second layer — two counterpressors + a presser was
              // the judged double-commit); loose balls keep the pair
              if ((oppHasIt ? closerCp < (cpI > 0.7 ? 2 : 1) : closerCp < 2) || myBallDist < 3) {
                if (body.command.type !== 'chaseBall') this.assign(body, { type: 'chaseBall', regime: 'sprint' });
                this.pressingIds.add(id); // a pressing state — demotable
                this.actionLabels.set(id, 'counterpress');
                continue;
              }
            }
          }
          // L5c/L5d DEFENDING: an idle brain whose OPPONENT has the ball
          // runs the defensive chain — COUNTERPRESS (innate, the 5–8 s
          // transition window) > elected PRESS (instructed, one first
          // defender) > SHADOW (the second man sits on the escape lane) >
          // SHAPE (the line). Contact stays L3's contain/tackle machinery.
          if (carrierBody && carrierBody.team !== body.team &&
            (this.instructions.get(id)?.objective) !== 'keep' &&
            (body.command.type === 'hold' || this.shapeHolding.has(id) || this.pressingIds.has(id) ||
              this.runningLine.has(id)) &&
            this.tick % DECIDE.reconsiderTicks === 0 &&
            this.tick > (this.scriptedUntil.get(id) ?? -1)) {
            const lostAt = this.lostPossessionAt.get(body.team) ?? -999;
            let cpCloser = 0;
            const myBd = Math.hypot(this.ball.pos.x - body.pos.x, this.ball.pos.y - body.pos.y);
            for (const bid of this.brains) {
              if (bid === id) continue;
              const b2 = this.byId.get(bid)!;
              if (b2.team !== body.team) continue;
              if (Math.hypot(this.ball.pos.x - b2.pos.x, this.ball.pos.y - b2.pos.y) < myBd) cpCloser++;
            }
            // capped like the transition path (the m11 swarm): two hunt
            const inCounterpress = this.tick - lostAt <= 60 && myBd < 15 && cpCloser < 1;
            // the DEFENSIVE BRAIN (decide.ts): the sim gathers the unit,
            // the brain runs the hierarchy, the sim EXECUTES the intent
            // (and the duel machine rides what press decides)
            const unit = [...this.brains].filter((bid) => {
              const b2 = this.byId.get(bid)!;
              return b2.team === body.team && this.tick > (this.scriptedUntil.get(bid) ?? -1) &&
                (this.instructions.get(bid)?.objective) !== 'keep';
            }).map((bid) => this.byId.get(bid)!);
            this.runningLine.delete(id);
            this.runPhase.delete(id);
            const di = decideDefense({
              shadeLockGet: (d0: string) => this.shadeLock.get(d0),
              shadeLockSet: (d0: string, th: string | null) => { if (th === null) this.shadeLock.delete(d0); else this.shadeLock.set(d0, th); },
              defender: body, carrier: carrierBody, bodies: this.activeBodies(), ball: this.ball,
              instructions: this.instructions.get(id) ?? {}, unit,
              pressingIds: this.pressingIds, inCounterpress,
              justReceived: this.tick - this.carrierSince <= 8, homes: this.homes,
              keepers: this.keepers,
            });
            if (di.kind === 'press') {
              if (di.approach) {
                this.assign(body, { type: 'moveTo', target: di.approach, regime: 'sprint' });
              } else if (body.command.type !== 'chaseBall') {
                this.assign(body, { type: 'chaseBall', regime: 'sprint' });
              }
              this.pressingIds.add(id);
              this.shapeHolding.delete(id);
              this.actionLabels.set(id, di.label);
            } else if (di.kind === 'delay') {
              this.pressingIds.delete(id);
              const dh = Math.hypot(di.hold.x - body.pos.x, di.hold.y - body.pos.y);
              if (dh > 1.2) {
                this.assign(body, { type: 'moveTo', target: di.hold, regime: dh > 7 ? 'run' : 'jog' });
                this.shapeHolding.add(id);
              } else if (body.command.type !== 'hold') {
                this.assign(body, { type: 'hold' });
              }
              this.actionLabels.set(id, 'delay');
            } else {
              this.pressingIds.delete(id);
              const label = di.kind === 'cover' ? 'cover' : di.kind === 'mark' ? 'mark' : di.kind === 'interceptLane' ? 'shadow' : 'shape';
              // DEFENSE-SIDE PERCEPTION (the determinism-preserving design):
              // the duty board ALLOCATES on truth (every defender computes
              // the same board — coached organization), but a mark is
              // EXECUTED against where this defender BELIEVES his man is —
              // the target drifts by his perception error, and a dart on
              // his blind side is followed only after the cone or the next
              // scan catches it. "He lost his runner" is now real.
              if (di.kind === 'mark' && di.mkId && this.brains.size >= 12) {
                const truthMan = this.byId.get(di.mkId);
                const sn = this.perception.get(id)?.get(di.mkId);
                if (truthMan && sn && sn.tick < this.tick - 2) {
                  // capped: a marker's JOB is his man — even blind-sided
                  // he re-finds him within a beat (an unbounded drift
                  // dissolved the back-five chain, wb-2 3.5/5)
                  const dtP = Math.min(0.8, (this.tick - sn.tick) * DT);
                  let ex = sn.x + sn.vx * dtP - truthMan.pos.x;
                  let ey = sn.y + sn.vy * dtP - truthMan.pos.y;
                  const em = Math.hypot(ex, ey);
                  if (em > 3.5) { ex *= 3.5 / em; ey *= 3.5 / em; }
                  di.target = { x: di.target.x + ex, y: di.target.y + ey };
                }
              }
              const d = Math.hypot(di.target.x - body.pos.x, di.target.y - body.pos.y);
              const shapeCalm = di.kind === 'holdShape' && !di.urgent;
              const positional = di.kind === 'cover' || di.kind === 'interceptLane' ||
                (di.kind === 'mark' && !di.urgent);
              const mvHs = shapeCalm ? this.stationMove(body, d, 0, di.target)
                : positional ? this.stationMove(body, d, 1, di.target) : null;
              if (mvHs ? mvHs.go : d > 1.2) {
                // an URGENT mark (his man darting goalward) tracks at pace
                // from the anticipatory station — jogging the chase was the
                // judged too-late-by-momentum
                const regime = mvHs ? mvHs.regime
                  : (di.kind === 'mark' || di.kind === 'holdShape') && di.urgent ? 'sprint' : d > 8 ? 'run' : 'jog';
                this.assign(body, { type: 'moveTo', target: di.target, regime });
                this.shapeHolding.add(id);
                this.actionLabels.set(id, label);
              } else if (this.shapeHolding.has(id) && body.command.type !== 'hold') {
                this.assign(body, { type: 'hold' });
              }
            }
          } else if (carrierBody && carrierBody.team === body.team) {
            // TRANSITION RE-ENTRY (the tick-291 frame: five men at their
            // defensive homes 40 m behind their own possession): an
            // ex-defender mid-moveTo matched no attack gate until his
            // stale walk ARRIVED — flag him idle so the attack game
            // picks him up next reconsider
            if (this.shapeHolding.delete(id)) this.attackIdle.add(id);
            this.pressingIds.delete(id);
          }
          // LIFECYCLE REPAIR (the loop's cut, one line): the bare delete
          // ejected defenders from eligibility at every opponent-coupling
          // and stranded them on stale transit moveTo for p50 3.4s / p95
          // 20s episodes (25-34% of defending time dark). MIGRATE instead
          // — the mirror of the shapeHolding->attackIdle line above; the
          // body stays re-decidable through the transition.
          if (carrierBody && carrierBody.team !== body.team) {
            if (this.attackIdle.delete(id) && this.brains.size >= 12) this.shapeHolding.add(id);
          }
          // THE STEP-IN (the debt round): an opponent pass IN FLIGHT was
          // uncontestable — intendedReceiverId excludes it from every loose-
          // ball race, so the receive reflex ran unopposed while the goal-
          // side marker (often CLOSER to the arrival point than the darting
          // runner) escorted air toward a station. The model prices cuts;
          // the executor never sent one. Now the flight is a duty: the ONE
          // defender whose intercept beats the receiver's attacks the
          // ball's line. Ground balls only — interceptPoint's tMeet is
          // z-blind (the receiver-release lesson, three aerial pins).
          // NOTE the gate is on the REAL carrier, not carrierBody — that
          // variable proxies the intended receiver during flights, which
          // is exactly why the defending chain above keeps escorting: it
          // marks THROUGH the flight. The step-in runs after and outranks
          // its fresh assignment (the ball's line beats the man's line).
          if (this.ball.carrierId === null && this.ball.phase !== 'dead' &&
            this.intendedReceiverId !== null &&
            this.ball.z < 0.5 && Math.abs(this.ball.vz) < 2 &&
            (body.command.type === 'hold' || this.attackIdle.has(id) || this.shapeHolding.has(id) ||
              this.runningLine.has(id)) &&
            this.tick % DECIDE.reconsiderTicks === 0 &&
            this.tick > (this.scriptedUntil.get(id) ?? -1) &&
            !this.pressingIds.has(id) && !this.keepers.has(id)) {
            const recv = this.byId.get(this.intendedReceiverId);
            if (recv && recv.team !== body.team) {
              const mine = this.interceptPoint(body);
              const recvT = this.interceptPoint(recv).tMeet;
              // arriving WITH the receiver contests (claims/tackles
              // resolve the meeting), and arriving a quarter-second behind
              // the touch is still ON the man for the immediate tackle —
              // the wb-0 race measured the tie at 2.6 s, which the first
              // cut (margin 0.1, cap 2.5) excluded on both ends
              if (mine.tMeet <= recvT + 0.35 && mine.tMeet < 3.5) {
                // one stepper per team — the best of the ELIGIBLE unit.
                // Eligible means passing the same state gate as me: the
                // first cut counted every non-pressing teammate, so a man
                // with a better intercept time who was mid-errand (a
                // sprint command from another duty — he never runs this
                // branch) collected the deferral and NOBODY stepped in
                // (the tick-282 frame: a-cm2 jogging beside the ball's
                // path while the receiver doubled back uncontested).
                let bestMate = Infinity;
                for (const bid of this.brains) {
                  if (bid === id) continue;
                  const b2 = this.byId.get(bid)!;
                  if (b2.team !== body.team || this.keepers.has(bid)) continue;
                  if (this.pressingIds.has(bid)) continue;
                  if (!(b2.command.type === 'hold' || this.attackIdle.has(bid) ||
                    this.shapeHolding.has(bid) || this.runningLine.has(bid))) continue;
                  if (this.tick <= (this.scriptedUntil.get(bid) ?? -1)) continue;
                  bestMate = Math.min(bestMate, this.interceptPoint(b2).tMeet);
                }
                if (mine.tMeet <= bestMate) {
                  this.shapeHolding.delete(id);
                  this.attackIdle.delete(id);
                  this.runningLine.delete(id);
                  this.runPhase.delete(id);
                  this.steppingIds.add(id);
                  this.assign(body, { type: 'chaseBall', regime: 'sprint' });
                  this.actionLabels.set(id, 'step-in');
                  continue;
                }
              }
            }
          }
          // NO POSSESSION, NO PAUSE (the judged freeze): with the ball
          // loose and unclaimed there is no carrier context, so neither
          // idle branch ever ran — 18 non-racing players stood on stale
          // commands. Both teams now hold their block-shifted stations
          // through the scramble.
          if (!carrierBody && this.ball.phase !== 'dead' &&
            (body.command.type === 'hold' || this.attackIdle.has(id) || this.shapeHolding.has(id) ||
              this.runningLine.has(id)) &&
            this.tick % DECIDE.reconsiderTicks === 0 &&
            this.tick > (this.scriptedUntil.get(id) ?? -1) &&
            this.homes.has(id)) {
            const home = this.homes.get(id)!;
            // KICKOFF RESET: both teams return to their formation homes
            // while the taker walks to the centre — the ceremony every
            // real match starts (and restarts) with
            const looseTrap = this.bodies.some((b2) => b2.team === body.team &&
              Math.hypot(b2.pos.x - this.ball.pos.x, b2.pos.y - this.ball.pos.y) < 3) ? 1.2 : -0.5;
            const kb0 = this.baseHomes.get(id) ?? home;
            const defendingNc = this.lastPossessTeam !== null && this.lastPossessTeam !== body.team;
            const sgnNc = attackSign(body.team);
            const gdNc = Math.hypot(this.ball.pos.x - (sgnNc > 0 ? 0 : PITCH.length), this.ball.pos.y - PITCH.width / 2);
            let st = this.restartType === 'kickoff'
              ? { x: kb0.x, y: kb0.y }
              : blockStation(home, this.teamCentroid(body.team), this.ball.pos, false, sgnNc,
                0.5, this.teamBrainCount(body.team) + 1,
                this.teamBrainCount(body.team) >= 8 && this.backLineHome(id, body.team) ? this.oppDeepestU(body.team) : undefined,
                true, 1, false, looseTrap, 0.5,
                defendingNc && this.teamBrainCount(body.team) >= 8 && gdNc > 70);
            // THE TRAPS POSTURE, AT THE STATION MASS (fork (a) — the
            // overlay, never a rewrite): this branch stations the block
            // during every transfer, which is where the posture was
            // structurally absent (the 1-2 body slice finding). Same
            // bodies, same blockStation, same effort pricing — stationed
            // attachment-aware. Line members shade Y ONLY (the line keeps
            // its x by construction — the integrity pins' guarantee).
            if (defendingNc && this.restartType !== 'kickoff' && this.teamBrainCount(body.team) >= 8 && !this.keepers.has(id)) {
              const isLine = this.backLineHome(id, body.team);
              const pool = this.bodies.filter((b2) => b2.team === body.team && b2.id !== id &&
                !this.keepers.has(b2.id) && this.backLineHome(b2.id, body.team) === isLine && this.brains.has(b2.id));
              const shaded = zoneEngageShade(st, body, this.bodies, pool, this.keepers,
                this.ball.carrierId ?? undefined, this.ball.pos, this.intendedReceiverId ?? undefined,
                (d0) => this.shadeLock.get(d0),
                (d0, th) => { if (th === null) this.shadeLock.delete(d0); else this.shadeLock.set(d0, th); });
              if (isLine) st = { x: st.x, y: shaded.y }; else st = shaded;
            }
            const dSt = Math.hypot(st.x - body.pos.x, st.y - body.pos.y);
            this.attackIdle.add(id);
            const mvNc = this.stationMove(body, dSt, 0, st);
            if (mvNc.go) {
              this.assign(body, { type: 'moveTo', target: st, regime: mvNc.regime });
              this.actionLabels.set(id, 'station');
            } else if (body.command.type !== 'hold') {
              this.assign(body, { type: 'hold' });
            }
          }
          // a STRAY ball (loose, dying, unclaimed, nobody sent to it) is
          // RACED by each team's nearest brain — deflected passes died
          // untouched with players standing over them (the audit), and at
          // match spacing the old 8 m radius DEADLOCKED an entire 11v11
          // around a neutral kickoff ball for 18+ seconds (the m11 pilot's
          // first finding): a neutral ball is always somebody's to go for.
          // ANY unowned live ball is raced — the dying-ball gate (vel < 3)
          // left a cut pass rolling fast with its receiver released and
          // NOBODY entitled to chase (the builder's twice-hit gap: the
          // tick-499 'no one is going after the ball' frame); the
          // one-per-team intercept-time election already prevents swarms
          // (fast-ball chases at match scale only — scripted drill kicks
          // carry no intendedReceiverId, and the drills' story balls were
          // being run down mid-flight by helpful bystanders)
          if ((body.command.type === 'hold' || this.attackIdle.has(id)) && this.ball.carrierId === null &&
            this.ball.phase !== 'dead' && this.intendedReceiverId === null &&
            (this.brains.size >= 12 || Math.hypot(this.ball.vel.x, this.ball.vel.y) < 3)) {
            const takerB = this.restartTaker ? this.byId.get(this.restartTaker) : undefined;
            if ((this.restartLock && this.tick < this.restartLock.until && body.team !== this.restartLock.team) ||
              (takerB && takerB.team === body.team)) {
              // not our restart — or the KEEPER's: hold shape while it is put back in
            } else {
            // elected by INTERCEPT TIME, not distance to the current spot
            // (the tick-802 frame: the man beside a rolling ball's future
            // path lost the race election to a mate nearer where the ball
            // WAS, and stood watching him arrive second)
            const nearestOfTeam = [...this.brains].reduce((best, bid) => {
              const b = this.byId.get(bid)!;
              if (b.team !== body.team) return best;
              const bt = this.interceptPoint(b).tMeet;
              return bt < best.t ? { id: bid, t: bt } : best;
            }, { id: '', t: Infinity });
            if (nearestOfTeam.id === id) {
              const bd = Math.hypot(this.ball.pos.x - body.pos.x, this.ball.pos.y - body.pos.y);
              this.assign(body, { type: 'chaseBall', regime: bd > 10 ? 'sprint' : 'run' });
              this.actionLabels.set(id, 'collect');
            }
            }
          }
        }
        continue;
      }
      this.receiveOpenDir.delete(id);
      this.bendReceive.delete(id); // carrier now — the run is received
      let intent = this.intents.get(id) ?? null;
      // a feint/burst in flight is a COMMITTED move — no re-pricing of
      // the geometry the fake itself just changed (the EV was killing
      // every feint half-made); only the approach is abortable
      const beatCommitted = this.beatExec?.carrierId === id && this.beatExec.phase !== 'approach';
      if (!intent || (this.tick % DECIDE.reconsiderTicks === 0 && !beatCommitted)) {
        intent = decide({
          ...(this.boardTap ? { board: (rid: string, u: number, pC?: number, kind?: string) => this.boardTap!(id, this.tick, rid, u, pC, kind) } : {}),
          carrier: body,
          heldTicks: this.tick - this.carrierSince,
          // the world AS HE LAST SAW IT — an unseen opponent can cut the
          // pass this prices (the perception tier)
          bodies: this.perceivedBodies(id),
          ball: this.ball,
          instructions: this.instructions.get(id) ?? {},
          current: intent,
          homes: this.homes,
          bounds: this.bounds,
          runners: this.runningLine,
          committedRunners: this.brains.size >= 12 ? new Set([...this.runPhase].filter(([, s2]) => s2.phase === 'dart').map(([id2]) => id2)) : undefined,
          runTargets: this.runTargetsFor(body.team),
          keepers: this.keepers,
          staggered: this.staggeredSet(),
          waitingRunners: new Set([...this.runningLine].filter((rid) => {
            const rp = this.runPhase.get(rid);
            const rb = this.byId.get(rid)!;
            if (!rp) return true;
            // the thread goes when the runner is ABOUT TO BREACH: darting,
            // at pace, and within a stride of the line (the judged one-two
            // spec — not merely "moving somewhere")
            const rsign = rb.team === 'home' ? 1 : -1;
            const dLine = rsign > 0 ? rp.lineX - rb.pos.x : rb.pos.x - rp.lineX;
            return rp.phase !== 'dart' || rb.speed < 3 || dLine > 4.5;
          })),
        });
        this.intents.set(id, intent);
      }
      // a stale beatExec outlived its intent and its APPROACH THROTTLE
      // kept braking the carrier at 4.2 for the rest of the run (the
      // sluggish post-beat carry, found instrumenting the channel)
      if (this.beatExec?.carrierId === id && intent.kind !== 'beat') this.beatExec = null;
      switch (intent.kind) {
        case 'carry':
          this.pendingKicks.delete(id);
          if (this.tick % DECIDE.reconsiderTicks === 0 || body.command.type !== 'moveTo') {
            this.assign(body, { type: 'moveTo', target: intent.target, regime: intent.regime });
          }
          this.actionLabels.set(id, 'carry');
          break;
        case 'shield':
          this.pendingKicks.delete(id);
          if (body.command.type !== 'hold') this.assign(body, { type: 'hold' });
          this.actionLabels.set(id, 'shield');
          break;
        case 'beat': {
          this.actionLabels.set(id, 'beat');
          const gdirB = Math.atan2(goalCenter(body.team).y - body.pos.y, goalCenter(body.team).x - body.pos.x);
          const ex0 = this.beatExec?.carrierId === id ? this.beatExec : null;
          let fmB: BodyState | undefined = ex0 ? this.byId.get(ex0.fmId) : undefined;
          if (!fmB) {
            // the man to beat is the RIDER — the defender whose duel
            // machine runs against me (jockey/track/engage; his hold IS
            // the closable 2-2.6 m). The goalward cone alone locked onto
            // the RECEDING COVER — 6 m off by construction, never
            // closable to the feint trigger — while the rider at 2 m sat
            // outside the cone (the verified approach-only defect).
            let rdB = 8.0;
            for (const [rid, rst] of this.duels) {
              // only a PLANTED man is not worth beating (run past him);
              // a recovering rider at 2 m is still the man to beat —
              // excluding recover re-selected the receding cover
              if (rst.state === 'staggered') continue;
              const rb = this.byId.get(rid);
              if (!rb || rb.team === body.team) continue;
              const d0 = Math.hypot(rb.pos.x - body.pos.x, rb.pos.y - body.pos.y);
              if (d0 < rdB) { rdB = d0; fmB = rb; }
            }
          }
          if (!fmB) {
            let fdB = 8.0;
            for (const o of this.bodies) {
              if (o.team === body.team) continue;
              const d0 = Math.hypot(o.pos.x - body.pos.x, o.pos.y - body.pos.y);
              if (d0 > 8.0) continue;
              const a0 = Math.abs((((Math.atan2(o.pos.y - body.pos.y, o.pos.x - body.pos.x) - gdirB) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
              if (a0 > Math.PI / 3) continue;
              if (d0 < fdB) { fdB = d0; fmB = o; }
            }
          }
          if (!fmB || this.ball.carrierId !== id) {
            this.beatExec = null;
            this.intents.delete(id);
            break;
          }
          if (!ex0) this.beatExec = { carrierId: id, fmId: fmB.id, phase: 'approach', side: intent.side, until: 0 };
          const st = this.beatExec!;
          const dFm = Math.hypot(fmB.pos.x - body.pos.x, fmB.pos.y - body.pos.y);
          if (dFm > 9) { // the duel dissolved — hand back to the EV
            this.beatExec = null;
            this.intents.delete(id);
            break;
          }
          const perpB = gdirB + Math.PI / 2;
          if (st.phase === 'approach') {
            // throttled, straight AT the rider — arrive at the arc in control
            const cur = body.command.type === 'moveTo' ? body.command.target : null;
            if (!cur || Math.hypot(cur.x - fmB.pos.x, cur.y - fmB.pos.y) > 0.5) {
              this.assign(body, { type: 'moveTo', target: { x: fmB.pos.x, y: fmB.pos.y }, regime: 'run' });
            }
            // the STALL break: a conceding rider (jockey cap 4.5) can
            // out-backpedal the throttled approach (4.2) forever — the
            // 3.1 m arc never arrives. Real take-ons end the standoff
            // from just outside the tackle arc: gap under 5.5 and no
            // longer closing → the move is NOW.
            const closingRate = (st.lastD ?? dFm) - dFm;
            st.lastD = dFm;
            if (dFm < 5.5 && closingRate < 0.06) st.stall = (st.stall ?? 0) + 1;
            else st.stall = 0;
            if (dFm <= 3.1 || (st.stall ?? 0) >= 4) { st.phase = 'feint'; st.until = this.tick + 4; }
          }
          if (st.phase === 'feint') {
            // the step to the FAKE side (opposite the burst) — his smoothed
            // read follows it; the lag is the lane
            const fx = body.pos.x + Math.cos(gdirB) * 0.8 + Math.cos(perpB) * -st.side * 1.7;
            const fy = body.pos.y + Math.sin(gdirB) * 0.8 + Math.sin(perpB) * -st.side * 1.7;
            const cur = body.command.type === 'moveTo' ? body.command.target : null;
            if (!cur || Math.hypot(cur.x - fx, cur.y - fy) > 0.6) {
              this.assign(body, { type: 'moveTo', target: { x: fx, y: fy }, regime: 'run' });
            }
            if (this.tick >= st.until) st.phase = 'burst';
          }
          if (st.phase === 'burst') {
            // the knock through the REAL side, geometry read at burst time —
            // the pending-kick machinery strikes it on the next touch and the
            // knock flag turns the follow-through into the sprint
            const past = {
              x: fmB.pos.x + Math.cos(gdirB) * 2.4 + Math.cos(perpB) * st.side * 1.9,
              y: fmB.pos.y + Math.sin(gdirB) * 2.4 + Math.sin(perpB) * st.side * 1.9,
            };
            const dP = Math.hypot(past.x - body.pos.x, past.y - body.pos.y);
            this.pendingKicks.set(id, {
              dest: past,
              speedMps: Math.max(7, Math.min(15, rollLaunchForArrival(1.2, dP + 3))),
              knock: true,
            });
            if (body.command.type !== 'chaseBall') this.assign(body, { type: 'chaseBall', regime: 'sprint' });
            this.beatExec = null;
            this.intents.delete(id);
          }
          break;
        }
        case 'pass':
        case 'shoot':
        case 'knock':
        case 'clear': {
          // THE LABEL MARKS THE ACT, NOT THE INTENT: emitted here it
          // survived the reach/alignment check, so a body who intended to
          // shoot but was out of reach kept a `shoot` label while the CARRY
          // TOUCH did the kicking (19% of 'shots' were dribble touches).
          const reach = Math.hypot(this.ball.pos.x - body.pos.x, this.ball.pos.y - body.pos.y);
          const strikeDir = Math.atan2(intent.dest.y - body.pos.y, intent.dest.x - body.pos.x);
          const strikeMis = Math.abs(((strikeDir - body.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
          if (reach <= TECH.kickReachM && strikeMis > DECIDE.strikeTurnThresholdRad) {
            // TURN, then strike — a misaligned kick is a backheel; the real
            // action is rotate-and-play, and the turn's delay is its honest
            // cost (defenders keep closing while the body comes around)
            if (body.command.type !== 'hold') this.assign(body, { type: 'hold' });
            body.command = { type: 'hold', facing: strikeDir };
          } else if (reach <= TECH.kickReachM && this.tick - this.carrierSince < 2) {
            // the SETTLE touch (the refinement round's t0 instant strike):
            // a possession just GAINED — spawn or turnover — takes a beat
            // before an intent strike (same-team combinations keep their
            // tempo: carrierSince only resets on the team changing). The
            // builder watched a t0 screamer from a player who visibly
            // never had the ball.
            if (body.command.type !== 'hold') this.assign(body, { type: 'hold' });
            body.command = { type: 'hold', facing: strikeDir };
          } else if (reach <= TECH.kickReachM && intent.kind === 'pass' && intent.pC !== undefined &&
            !intent.loftDeg && !intent.spin &&
            passCompletion(body.pos, intent.dest, intent.speedMps,
              this.bodies.filter((o) => o.team !== body.team),
              Math.hypot(intent.dest.x - body.pos.x, intent.dest.y - body.pos.y),
              this.byId.get(intent.receiverId), body.attributes.passing) <
              Math.min(0.15, intent.pC * 0.45)) {
            // the STRIKE-ABORT (the refinement round): the lane is priced
            // at DECISION time and struck ~0.3 s later — a shadow can
            // converge in between (the LB cutting the 'clear' thread 7/8).
            // A lane that has COLLAPSED since pricing (not merely a bad
            // lane knowingly chosen — that would abort-loop) pulls the
            // pass; the player checks out and re-decides.
            this.intents.delete(id);
            this.actionLabels.set(id, 'check');
            if (body.command.type !== 'hold') this.assign(body, { type: 'hold' });
          } else if (reach <= TECH.kickReachM) {
            // the strike itself is L3's: noisy by the kicker's feet
            const noisy = noisyKick(this.rng, this.tick, id, body.attributes, intent.dest, this.ball.pos, intent.speedMps, body.facing);
            kickBall(this.ball, noisy.target, noisy.speedMps, intent.kind === 'pass' || intent.kind === 'shoot' ? (intent.loftDeg ?? 0) : 0, id, this.tick, intent.kind === 'pass' || intent.kind === 'shoot' ? (intent.spin ?? 0) : 0);
            this.ball.sprayM = Math.hypot(noisy.target.x - intent.dest.x, noisy.target.y - intent.dest.y);
            this.actionLabels.set(id, intent.kind === 'pass' ? `pass→${intent.receiverId}` : intent.kind);
            if (intent.kind === 'pass') {
              this.intendedReceiverId = intent.receiverId;
              this.lastGiveTick.set(id, this.tick);
              if (this.telemetry) {
                this.openPass = {
                  tick: this.tick, pC: intent.pC,
                  dist: Math.hypot(intent.dest.x - body.pos.x, intent.dest.y - body.pos.y),
                  loft: intent.loftDeg ?? 0, spin: intent.spin ?? 0,
                  // attack-axis progression: forward / square / back shares
                  // are a calibration axis (the conservation-EV round)
                  du: (intent.dest.x - body.pos.x) * attackSign(body.team),
                  kicker: id, receiver: intent.receiverId,
                };
              }
            }
            this.intents.delete(id);
            this.pendingKicks.delete(id);
            // the KNOCK's second half is the GO — sprint after your own push
            // (the kick freed the ball from carry speed; now win the race)
            this.assign(body, intent.kind === 'knock' ? { type: 'chaseBall', regime: 'sprint' } : { type: 'hold' });
          } else {
            // mid-touch: release ON THE NEXT TOUCH (coupleCarry fires it) —
            // and close the gap meanwhile
            this.pendingKicks.set(id, {
              dest: intent.dest,
              speedMps: intent.speedMps,
              ...((intent.kind === 'pass' || intent.kind === 'shoot') && intent.loftDeg ? { loftDeg: intent.loftDeg } : {}),
              ...(intent.kind === 'pass' && intent.spin ? { spin: intent.spin } : {}),
              ...(intent.kind === 'pass' ? { receiverId: intent.receiverId } : {}),
              ...(intent.kind === 'knock' ? { knock: true } : {}),
              // the ACT's identity, carried so the queue release can REPORT
              // what it was: that path emitted no label at all, so whole
              // drills of genuine strikes went uncounted while
              // intent-labelled dribble touches were counted as shots
              kind: intent.kind,
            });
            if (body.command.type !== 'chaseBall') {
              this.assign(body, { type: 'chaseBall', regime: 'run' });
            }
          }
          break;
        }
      }
    }
  }

  private completeChases(winningTeam: 'home' | 'away'): void {
    for (const b of this.bodies) {
      if (b.command.type === 'chaseBall' && b.team === winningTeam) {
        b.command = { type: 'hold' };
        b.arrived = true;
        b.arrivedAtTick = this.tick;
        const next = this.queues.get(b.id)!.shift();
        if (next) this.assign(b, next);
      }
    }
  }

  /** earliest point on the ball's predicted path this body can reach — the
   * anticipation runners actually use. Coarse deterministic search: clone-
   * step the real ball physics ahead and take the first reachable horizon. */
  /** the earliest point on the ball's predicted path this body can meet.
   * withMargin: prefer a point he reaches COMFORTABLY early (≥0.55 s) — a
   * receiver sets up on the line and takes the arriving ball; the marginal
   * meet (tStar ≈ his arrival) makes him carry his momentum THROUGH the
   * line and stern-chase the ball he just missed. Fetching your own touch
   * never margins (a dribbler does not stop ahead of his ball and wait). */
  /** the earliest point on the ball's predicted path this body can meet,
   * and when the ball gets there. The APPROACH is time-matched by the
   * caller: run at the ball's meeting point at the speed that arrives WITH
   * it — toward the ball always, through it never. */
  /** Where a chaser should run. Two-phase, like a real receiver:
   *  1. OFF the ball's line → attack the nearest point of the path (this is
   *     visually "moving toward the ball" — the earliest-meet target alone
   *     produces a parallel converging drift that reads as running away);
   *  2. ON the line → the earliest meeting point, approached at the speed
   *     that arrives WITH the ball. */
  /** the in-stride meet: where the ball's predicted path comes onto the
   * body's CONTINUED run (current velocity held) — or null if running
   * through does not meet the ball and the receive must be timed */
  private inStrideMeet(body: BodyState): Vec2 | null {
    if (body.speed < 3.5) return null;
    // a PASS in flight only — a slow or sitting ball must be braked into
    // (the collect), not charged at full stride (the original overrun bug)
    if (Math.hypot(this.ball.vel.x, this.ball.vel.y) < 4) return null;
    const ux = body.vel.x / body.speed;
    const uy = body.vel.y / body.speed;
    let bestGap = Infinity;
    let bestT = 0;
    for (let t = 0.2; t <= 3.0; t += 0.2) {
      const bp = predictBall(this.ball, t);
      const g = Math.hypot(bp.x - (body.pos.x + ux * body.speed * t), bp.y - (body.pos.y + uy * body.speed * t));
      if (g < bestGap) {
        bestGap = g;
        bestT = t;
      }
    }
    if (bestGap > 1.0) return null;
    const bp = predictBall(this.ball, bestT);
    return { x: bp.x, y: bp.y };
  }

  /** the bend-receive meet: the earliest point on the ball's predicted
   * path the runner reaches AT PACE with a forward-ish bend (≤1.2 rad of
   * his current heading) — or null if the ball truly requires turning back */
  private bendMeet(body: BodyState): Vec2 | null {
    if (body.speed < 3) return null;
    if (Math.hypot(this.ball.vel.x, this.ball.vel.y) < 3) return null;
    const hd = Math.atan2(body.vel.y, body.vel.x);
    for (let t = 0.2; t <= 3.0; t += 0.2) {
      const bp = predictBall(this.ball, t);
      const d = Math.hypot(bp.x - body.pos.x, bp.y - body.pos.y);
      if (d > body.speed * t + 0.9) continue; // cannot make it at pace
      const dir = Math.atan2(bp.y - body.pos.y, bp.x - body.pos.x);
      const bend = Math.abs(((dir - hd + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (d > 0.6 && bend > 1.2) continue; // that would be a turn-back
      return bp;
    }
    return null;
  }

  /** PERCEPTION (the scanning tier): each brain keeps a last-seen
   * snapshot of every OPPONENT. Fresh when the man is inside the vision
   * cone (facing ± ~100°) or the peripheral bubble (9 m); a SCAN — the
   * head-turn every real player cycles — refreshes everything, on a
   * period set by awareness (the mind attribute): aw 20 ≈ 0.8 s, aw 5 ≈
   * 2.8 s. Deeper players see more for FREE: the play is in front of
   * them, so the cone covers it — the builder's field-of-view intuition
   * falls out of the geometry. Teammates and the ball stay truth
   * (voices, familiarity, and everyone tracks the ball); the DEFENSIVE
   * board stays truth too — the duty board's shared determinism requires
   * identical inputs (each defender simulates the others' claims), so
   * organized defense reads as coached communication. Perception gates
   * the ATTACKING decisions: what you haven't seen can cut your pass. */
  /** THE OFFSIDE LAW (match scale): at every kick, teammates beyond the
   * second-last opponent, in the opponent half, ahead of the ball are
   * TAGGED; if a tagged man is the first of his team to take the ball,
   * the whistle goes — dead ball, free kick to the defenders at the
   * spot. Tags clear when the other team touches or the ball dies. */
  /** THE FOUL LAW (match scale, riding the tackle machinery): every
   * tackle roll first risks an illegal contact — priced up when the
   * challenge comes FROM BEHIND, when it is a LUNGE, and when the feet
   * are clumsy (low tackling). A foul is a dead ball and a free kick to
   * the fouled team at the spot (the pendingFreeKick plumbing), plus
   * the card ledger: a harsh foul (behind + lunge) risks a straight
   * yellow, the third personal foul earns one, the second yellow is
   * red — the man is SENT OFF (out of the brains, parked at his own
   * corner, invisible to every decision). Keepers cap at yellow (no
   * replacement machinery). Penalties are the recorded next step —
   * a box foul currently awards the free kick at the spot. */
  private readonly foulCounts = new Map<string, number>();
  private readonly yellows = new Set<string>();
  private readonly sentOff = new Set<string>();

  private readonly offsideTagged = new Set<string>();
  private offsideKickTeam: 'home' | 'away' | null = null;
  private pendingFreeKick: { team: 'home' | 'away'; spot: Vec2 } | null = null;
  /** RESTART CEREMONIES: every restart has a designated taker and a
   * type; the ball is claimable by the TAKER ALONE (real football never
   * gives the opponent your throw-in — the census caught an away
   * striker taking home's free kick at their own box), opponents
   * retreat from the spot, kickoffs reset both teams to their homes,
   * and throw-ins are thrown (two-handed, offside-exempt per the law). */
  private restartType: 'kickoff' | 'throw-in' | 'corner' | 'goal-kick' | 'free-kick' | null = null;
  /** the referee's word for the workbench header */
  private bannerText: string | null = null;
  /** teams SET THEMSELVES before a restart is taken (builder): claims
   * are frozen for a beat after placement while both sides organize */
  private restartSetupUntil = -1;
  private restartPenalty = false;
  /** the defending team of a goal kick not yet taken — opponents may
   * not enter the box until the keeper strikes (builder) */
  private goalKickPending: 'home' | 'away' | null = null;
  /** HALVES: which half we are in, and the queued half-start kickoff
   * (the opening ceremony and the second-half handover to away) */
  half = 1;
  private pendingKickoffTeam: 'home' | 'away' | null = null;
  private halfTick = -1;
  /** THE WALL: at a shooting-range free kick the defense posts 2-4 men
   * on the ball-goal line at 9.15 m — the body-block physics then does
   * the rest (low drives die in the wall; the taker must go over it) */
  private readonly wallSpots = new Map<string, Vec2>();
  private offsideExemptTick = -1;

  private updateOffside(): void {
    if (this.brains.size < 12) return;
    // the whistle: a tagged man took the ball
    const cb = this.ball.carrierId ? this.byId.get(this.ball.carrierId) : undefined;
    if (cb && this.offsideKickTeam) {
      if (cb.team !== this.offsideKickTeam) {
        this.offsideTagged.clear();
        this.offsideKickTeam = null;
      } else if (this.offsideTagged.has(cb.id) && this.ball.phase !== 'dead') {
        this.ball.phase = 'dead';
        this.ball.carrierId = null;
        this.ball.vel = { x: 0, y: 0 };
        this.ball.vz = 0;
        this.ball.z = 0;
        this.pendingFreeKick = {
          team: cb.team === 'home' ? 'away' : 'home',
          spot: { x: cb.pos.x, y: cb.pos.y },
        };
        this.actionLabels.set(cb.id, 'offside');
        this.bannerText = 'OFFSIDE';
        this.offsideTagged.clear();
        this.offsideKickTeam = null;
        return;
      }
    }
    // the flag: tag at the moment of every kick
    if (this.ball.lastKickTick === this.tick && this.ball.kickerId &&
      this.tick !== this.offsideExemptTick) {
      const kb = this.byId.get(this.ball.kickerId);
      if (kb) {
        this.offsideTagged.clear();
        this.offsideKickTeam = kb.team;
        const sgn = attackSign(kb.team);
        const oppUs = this.bodies.filter((b) => b.team !== kb.team && !this.sentOff.has(b.id))
          .map((b) => b.pos.x * sgn).sort((a, b) => b - a);
        const secondLastU = oppUs[1] ?? Infinity;
        const ballU = this.ball.pos.x * sgn;
        for (const m of this.bodies) {
          if (m.team !== kb.team || m.id === kb.id) continue;
          const mu = m.pos.x * sgn;
          const inOppHalf = sgn > 0 ? m.pos.x > PITCH.length / 2 : m.pos.x < PITCH.length / 2;
          if (inOppHalf && mu > secondLastU && mu > ballU) this.offsideTagged.add(m.id);
        }
      }
    }
    if (this.ball.phase === 'dead' && !this.pendingFreeKick) {
      this.offsideTagged.clear();
      this.offsideKickTeam = null;
    }
  }

  /** attack targets claimed THIS tick (run lanes, support spots, box
   * slots) — the cross-system half of the claims channel: sequential
   * processing means later brains see earlier claims, deterministic */
  private readonly attackClaims = new Map<'home' | 'away', Vec2[]>([['home', []], ['away', []]]);

  private readonly perception = new Map<string, Map<string, { x: number; y: number; vx: number; vy: number; tick: number }>>();

  /** RESTART STAGING (builder: 'players should be able to teleport to
   * positions... before restart'): ceremony-critical roles are PLACED
   * at the whistle — the taker behind his ball, the wall on its line,
   * box crowds in their slots, penalty areas cleared, kickoff formations
   * at their homes — instead of walking cross-pitch while the game
   * waits. Everyone else keeps moving naturally. */
  private teleport(b: BodyState, to: Vec2): void {
    // never land ON someone — the interpenetration invariant holds even
    // through staging
    let tx = Math.max(1, Math.min(PITCH.length - 1, to.x));
    let ty = Math.max(1, Math.min(PITCH.width - 1, to.y));
    // a RETREAT LINE stages many bodies onto one 1-D line (x pinned, own y
    // kept): pushing away from clash A lands inside clash B and the loop
    // ping-pongs along the line — so past a few tries the push SPIRALS
    // (angle walks, radius grows) until it escapes the crowd
    for (let tries = 0; tries < 12; tries++) {
      const clash = this.bodies.find((o) => o.id !== b.id &&
        Math.hypot(o.pos.x - tx, o.pos.y - ty) < 0.75);
      if (!clash) break;
      const ang = (Math.atan2(ty - clash.pos.y, tx - clash.pos.x) || (tries * 1.1)) +
        (tries > 3 ? (tries - 3) * 0.9 : 0);
      const push = 1.1 + tries * 0.25;
      tx = Math.max(1, Math.min(PITCH.length - 1, clash.pos.x + Math.cos(ang) * push));
      ty = Math.max(1, Math.min(PITCH.width - 1, clash.pos.y + Math.sin(ang) * push));
    }
    b.pos = { x: tx, y: ty };
    b.vel = { x: 0, y: 0 };
    b.speed = 0;
    this.assign(b, { type: 'hold' });
    this.runningLine.delete(b.id);
    this.runPhase.delete(b.id);
    this.steppingIds.delete(b.id);
    this.duels.delete(b.id);
    this.pressingIds.delete(b.id);
  }

  private stageRestart(award: 'home' | 'away', spot: Vec2): void {
    const tk = this.restartTaker ? this.byId.get(this.restartTaker) : undefined;
    if (this.restartType === 'kickoff') {
      for (const b of this.bodies) {
        if (this.sentOff.has(b.id)) continue;
        const home = this.baseHomes.get(b.id) ?? this.homes.get(b.id);
        if (home) this.teleport(b, home);
      }
      // the KICKOFF LAW (builder): no opponent inside the centre circle
      // or past halfway — homes are own-half by construction, but a home
      // near the circle edge gets pushed clear
      for (const b of this.bodies) {
        if (b.team === award || this.sentOff.has(b.id)) continue;
        const dC = Math.hypot(b.pos.x - spot.x, b.pos.y - spot.y);
        if (dC < 10.2) {
          // push toward his own half until clear of the circle
          const ownDir = -attackSign(b.team);
          const dy = b.pos.y - spot.y;
          const dxNeed = Math.sqrt(Math.max(1, 10.5 * 10.5 - dy * dy));
          this.teleport(b, { x: spot.x + ownDir * dxNeed, y: b.pos.y });
        }
      }
      if (tk) this.teleport(tk, { x: spot.x - attackSign(award) * 1.2, y: spot.y });
      return;
    }
    if (tk) {
      const sgn = attackSign(award);
      this.teleport(tk, { x: spot.x - sgn * 1.4, y: spot.y });
    }
    for (const [wid, ws] of this.wallSpots) {
      const wb = this.byId.get(wid);
      if (wb) this.teleport(wb, ws);
    }
    if (this.restartPenalty) {
      const nearHome = spot.x < PITCH.length / 2;
      for (const b of this.bodies) {
        if (b.id === this.restartTaker || this.keepers.has(b.id) || this.sentOff.has(b.id)) continue;
        const inBox = (nearHome ? b.pos.x < GOAL.boxDepthM + 1 : b.pos.x > PITCH.length - GOAL.boxDepthM - 1) &&
          Math.abs(b.pos.y - PITCH.width / 2) < GOAL.boxHalfWidthM + 1;
        if (inBox) {
          this.teleport(b, {
            x: nearHome ? GOAL.boxDepthM + 2.5 : PITCH.length - GOAL.boxDepthM - 2.5,
            y: Math.max(6, Math.min(PITCH.width - 6, b.pos.y)),
          });
        }
      }
    }
    // GOAL-KICK RULE (builder): no opponent inside the box while it is
    // taken — staged straight out to the edge
    if (this.restartType === 'goal-kick') {
      const nearHome = spot.x < PITCH.length / 2;
      for (const b of this.bodies) {
        if (b.team === award || this.sentOff.has(b.id)) continue;
        const inBox = (nearHome ? b.pos.x < GOAL.boxDepthM + 1 : b.pos.x > PITCH.length - GOAL.boxDepthM - 1) &&
          Math.abs(b.pos.y - PITCH.width / 2) < GOAL.boxHalfWidthM + 1;
        if (inBox) {
          this.teleport(b, {
            x: nearHome ? GOAL.boxDepthM + 3 : PITCH.length - GOAL.boxDepthM - 3,
            y: Math.max(6, Math.min(PITCH.width - 6, b.pos.y)),
          });
        }
      }
    }
    if (this.restartType === 'corner' ||
      (this.restartType === 'free-kick' && !this.restartPenalty && tk &&
        Math.hypot(goalCenter(award).x - spot.x, goalCenter(award).y - spot.y) <= 40)) {
      const sgn = attackSign(award);
      const gX = sgn > 0 ? PITCH.length : 0;
      const atk = [...this.brains]
        .map((bid) => this.byId.get(bid)!)
        .filter((b) => b.team === award && b.id !== this.restartTaker && !this.sentOff.has(b.id))
        .sort((a, b) => sgn * (b.pos.x - a.pos.x))
        .slice(0, 3);
      const slots = [
        { x: gX - sgn * 11, y: PITCH.width / 2 },
        { x: gX - sgn * 7, y: PITCH.width / 2 - 6 },
        { x: gX - sgn * 7, y: PITCH.width / 2 + 6 },
      ];
      atk.forEach((b, i) => this.teleport(b, slots[i]));
    }
  }

  /** THE RESTART LAWS (until-the-ball-is-in-play enforcement): staging
   * clears zones ONCE; bodies then walked straight back in and the first
   * Bar-4 watch saw a goal-kick box full of opponents. This runs EVERY
   * dead tick while a restart is pending — a violator is projected to
   * the zone boundary (position only; his command survives, so he simply
   * stands at the line like a real wall). Laws covered: goal kick
   * (opponents outside the PA), corner (9.15 m), free kick (9.15 m —
   * the wall already stood there; now everyone must), throw-in (2 m),
   * penalty (everyone but taker and keepers out of the PA and the arc). */
  private enforceRestartLaw(): void {
    const rt = this.restartType;
    const award = this.restartLock?.team;
    if (!rt || rt === 'kickoff' || !award || this.brains.size < 12) return;
    const spot = this.ball.pos;
    // BOUNDED nudge, never a snap: the law now enforces through live
    // phases (the carried goal-kick ball) and a position jump violates
    // the continuity/interpenetration invariants — a violator WALKS out
    // at a legal per-tick step and the separation pass keeps him clean.
    const step = 0.85;
    const nudge = (b: BodyState, tx: number, ty: number): void => {
      const cx = Math.max(1, Math.min(PITCH.length - 1, tx));
      const cy = Math.max(1, Math.min(PITCH.width - 1, ty));
      if (this.ball.phase === 'dead') {
        // dead ball: bounded position step (the staging convention)
        const dx = cx - b.pos.x;
        const dy = cy - b.pos.y;
        const d = Math.hypot(dx, dy);
        const k2 = d > step ? step / d : 1;
        b.pos = { x: b.pos.x + dx * k2, y: b.pos.y + dy * k2 };
      } else {
        // live phases (the carried goal-kick ball): the law speaks
        // through the COMMAND — the violator walks out on his own
        // physics; no position writes, no continuity debt
        this.assign(b, { type: 'moveTo', target: { x: cx, y: cy }, regime: 'jog' });
      }
    };
    const radial = (b: BodyState, minD: number): void => {
      const d = Math.hypot(b.pos.x - spot.x, b.pos.y - spot.y);
      if (d >= minD) return;
      const ux = d > 0.01 ? (b.pos.x - spot.x) / d : 1;
      const uy = d > 0.01 ? (b.pos.y - spot.y) / d : 0;
      nudge(b, spot.x + ux * minD, spot.y + uy * minD);
    };
    const outOfBox = (b: BodyState, nearHome: boolean): void => {
      const inBox = (nearHome ? b.pos.x < GOAL.boxDepthM + 0.5 : b.pos.x > PITCH.length - GOAL.boxDepthM - 0.5) &&
        Math.abs(b.pos.y - PITCH.width / 2) < GOAL.boxHalfWidthM + 0.5;
      if (!inBox) return;
      // nearest exit: the box's x-plane or y-plane, whichever is closer
      const xExit = nearHome ? GOAL.boxDepthM + 0.8 : PITCH.length - GOAL.boxDepthM - 0.8;
      const yExit = b.pos.y >= PITCH.width / 2
        ? PITCH.width / 2 + GOAL.boxHalfWidthM + 0.8
        : PITCH.width / 2 - GOAL.boxHalfWidthM - 0.8;
      const dx = Math.abs(b.pos.x - xExit);
      const dy = Math.abs(b.pos.y - yExit);
      if (dx <= dy) nudge(b, xExit, b.pos.y);
      else nudge(b, b.pos.x, Math.max(1, Math.min(PITCH.width - 1, yExit)));
    };
    if (this.restartPenalty) {
      const nearHome = spot.x < PITCH.length / 2;
      for (const b of this.bodies) {
        if (b.id === this.restartTaker || this.keepers.has(b.id) || this.sentOff.has(b.id)) continue;
        outOfBox(b, nearHome);
        radial(b, 9.15); // the arc
      }
      return;
    }
    for (const b of this.bodies) {
      if (b.team === award || this.sentOff.has(b.id)) continue;
      if (rt === 'goal-kick') outOfBox(b, spot.x < PITCH.length / 2);
      else if (rt === 'corner' || rt === 'free-kick') radial(b, 9.15);
      else if (rt === 'throw-in') radial(b, 2.0);
    }
  }

  /** red card: out of every decision system, parked at his own corner */
  private sendOff(id: string): void {
    this.sentOff.add(id);
    this.brains.delete(id);
    this.pressingIds.delete(id);
    this.shapeHolding.delete(id);
    this.attackIdle.delete(id);
    this.runningLine.delete(id);
    this.runPhase.delete(id);
    this.steppingIds.delete(id);
    const b = this.byId.get(id);
    if (b) {
      const sgn = attackSign(b.team);
      this.assign(b, { type: 'moveTo', target: { x: sgn > 0 ? 3 : PITCH.length - 3, y: 3 }, regime: 'jog' });
    }
  }

  /** the pitch as decisions see it — the sent-off man does not exist */
  private activeBodies(): BodyState[] {
    return this.sentOff.size ? this.bodies.filter((b) => !this.sentOff.has(b.id)) : (this.bodies as BodyState[]);
  }

  private scanPeriod(b: BodyState): number {
    return Math.max(8, Math.round(34 - 1.3 * (b.attributes.awareness ?? 11)));
  }

  private updatePerception(): void {
    // MATCH-SCALE ONLY (the big-cast precedent: far-tuck, compactness):
    // drills are unit tests of decision SEMANTICS under truth — the
    // risk-dial pin flipped 16/16 on a knife-edge 2.6 m perception
    // error that means nothing at 5 bodies and everything at 22
    if (this.brains.size < 12) return;
    for (const id of this.brains) {
      const me = this.byId.get(id)!;
      let seen = this.perception.get(id);
      if (!seen) { seen = new Map(); this.perception.set(id, seen); }
      // the MAN ON THE BALL scans near-continuously (every real coaching
      // manual's first demand — and the risk-dial pin measured it: a
      // carrier on the ordinary cycle mispriced the through lane 16/16)
      const onBall = this.ball.carrierId === id || this.intendedReceiverId === id;
      const period = onBall ? 4 : this.scanPeriod(me);
      let hash = 0;
      for (let i = 0; i < id.length; i++) hash += id.charCodeAt(i);
      const scanning = this.tick % period === hash % period;
      const fx = Math.cos(me.facing);
      const fy = Math.sin(me.facing);
      for (const b of this.bodies) {
        if (b.team === me.team) continue;
        const dx = b.pos.x - me.pos.x;
        const dy = b.pos.y - me.pos.y;
        const d = Math.hypot(dx, dy);
        const inCone = d > 0.01 && (fx * dx + fy * dy) / d > -0.17; // ~±100°
        if (scanning || d < 9 || inCone || b.id === this.ball.carrierId) {
          seen.set(b.id, { x: b.pos.x, y: b.pos.y, vx: b.vel.x, vy: b.vel.y, tick: this.tick });
        } else if (!seen.has(b.id)) {
          // never seen at all: kickoff knowledge (line-ups are public)
          seen.set(b.id, { x: b.pos.x, y: b.pos.y, vx: b.vel.x, vy: b.vel.y, tick: this.tick });
        }
      }
    }
  }

  /** the world as THIS brain last saw it: opponents at their last-seen
   * positions, teammates and self at truth */
  private perceivedBodies(id: string): BodyState[] {
    const me = this.byId.get(id);
    const seen = this.perception.get(id);
    if (!me || !seen || this.brains.size < 12) return this.activeBodies();
    return this.activeBodies().map((b) => {
      if (b.team === me.team) return b;
      const sn = seen.get(b.id);
      if (!sn || sn.tick >= this.tick - 2) return b;
      // DEAD RECKONING: players extrapolate the motion they SAW — a
      // frozen last-seen position read a closing defender meters behind
      // his true spot and the lane priced open (the risk-dial pin,
      // 16/16 systematic). Blind-sidedness is now what it really is:
      // vulnerability to movement that CHANGED since the last look.
      const dtS = Math.min(1.5, (this.tick - sn.tick) * DT);
      return {
        ...b,
        pos: { x: sn.x + sn.vx * dtS, y: sn.y + sn.vy * dtS },
        vel: { x: sn.vx, y: sn.vy },
      } as BodyState;
    });
  }

  /** each running teammate's planned breach lane, for the thread */
  private runTargetsFor(team: 'home' | 'away'): Map<string, Vec2> {
    const m = new Map<string, Vec2>();
    for (const rid of this.runningLine) {
      const rb = this.byId.get(rid);
      const st = this.runPhase.get(rid);
      if (!rb || rb.team !== team || !st) continue;
      m.set(rid, { x: st.lineX, y: st.dartY });
    }
    return m;
  }

  /** deepest opposing outfielder's u-coordinate (this team's attack sign) */
  private oppDeepestU(team: 'home' | 'away'): number {
    const sgn = attackSign(team);
    let u = Infinity;
    for (const b of this.bodies) {
      if (b.team === team || this.keepers.has(b.id) || this.sentOff.has(b.id)) continue;
      u = Math.min(u, b.pos.x * sgn);
    }
    return u;
  }

  /** is this player's HOME in the team's deepest outfield band (the back
   * line, formation-agnostic: within 6 m of the deepest outfield home)? */
  private backLineHome(id: string, team: 'home' | 'away'): boolean {
    const home = this.homes.get(id);
    if (!home || this.keepers.has(id)) return false;
    const sgn = attackSign(team);
    let deepest = Infinity;
    for (const [hid, h] of this.homes) {
      const b = this.byId.get(hid);
      if (!b || b.team !== team || this.keepers.has(hid)) continue;
      deepest = Math.min(deepest, h.x * sgn);
    }
    return home.x * sgn <= deepest + 6;
  }

  private interceptPoint(body: BodyState): {
    pNear: Vec2; tNear: number; lineDist: number; pMeet: Vec2; tMeet: number;
  } {
    const regime = body.command.type === 'chaseBall' ? body.command.regime : 'run';
    const vcap = Math.max(regimeCapMps(body.attributes.pace, regime), 0.5);
    let meet: { p: Vec2; tStar: number } | null = null;
    let near: { p: Vec2; d: number; t: number } | null = null;
    const airborne = this.ball.phase === 'airborne';
    // near EITHER goal a body ATTACKS an aerial ball at head height (a header —
    // a cross to a striker, a defender under a lob) rather than waiting for the
    // ground drop; in open play he lets it drop and controls it. So the ceiling
    // on a "receive" point is the header band near a goal, knee height else.
    const nearGoal = Math.min(body.pos.x, PITCH.length - body.pos.x) < 20;
    const zCap = nearGoal ? BALL.headMaxZ : BALL.claimMaxZ;
    if (airborne) {
      // the FIRST point at catchable height and DESCENDING — the drop for a
      // loft, immediately for a flat cross that never climbs above zCap. Taken
      // EARLIEST at every physics tick: a fast descent crosses the 0.5 m window
      // in ONE tick and by the next it has bounced (vz>0), so the old
      // coarse+nearest scan skipped the real drop and targeted the post-bounce
      // ROLL — walking the receiver clean past it to the sideline. ONE clone
      // stepped incrementally (a fresh predictBallState per sample re-simulates
      // the whole flight each time; DT is the true resolution anyway).
      const c: BallState = {
        pos: { ...this.ball.pos }, z: this.ball.z, vel: { ...this.ball.vel }, vz: this.ball.vz,
        spin: this.ball.spin, phase: 'airborne', carrierId: null, kickerId: null,
        kickerLockUntilTick: 0, touchParity: false,
      };
      let prevZ = c.z;
      for (let i = 1; i <= 60; i++) {
        stepBall(c);
        // catchable height AND coming down to him: descending (flat cross that
        // never climbs above zCap) OR just crossed DOWN through zCap (a steep
        // drop the sample catches only after it has bounced, vz>0)
        if (c.z <= zCap && (c.vz <= 0.2 || prevZ > zCap)) {
          const p = { x: c.pos.x, y: c.pos.y };
          const t = i * DT;
          const d = Math.hypot(p.x - body.pos.x, p.y - body.pos.y);
          near = { p, d, t };
          meet = { p, tStar: t }; // he runs to the drop whether or not he'll beat it
          break;
        }
        prevZ = c.z;
      }
    } else {
      for (let t = 0.2; t <= 6.0; t += 0.2) {
        const s = predictBallState(this.ball, t);
        const p = s.pos;
        const d = Math.hypot(p.x - body.pos.x, p.y - body.pos.y);
        if (!near || d < near.d) near = { p, d, t };
        if (!meet && 0.3 + d / vcap <= t) meet = { p, tStar: t };
      }
    }
    const far = predictBall(this.ball, 6);
    return {
      pNear: near?.p ?? far,
      tNear: near?.t ?? 6,
      lineDist: near?.d ?? 99,
      pMeet: meet?.p ?? far,
      tMeet: meet?.tStar ?? 6,
    };
  }

  private assign(body: BodyState, command: MovementCommand): void {
    // THE RESTART LAW AT THE COMMAND CHOKEPOINT (watch-8 finding B,
    // iteration 2): while a goal kick pends, an opponent's moveTo may
    // not TARGET the box — the law's jog-out and the brains' station
    // commands were alternating (1,302 re-entries across 42 windows;
    // the box cleared by drift, legality reached only in flickers).
    // Same lesson as the compactness law: bind the chain where every
    // command flows, not one stage of it.
    if (this.restartLock && command.type === 'moveTo' &&
      (this.restartType === 'goal-kick'
        ? body.team !== this.restartLock.team
        : this.restartType === 'free-kick' && this.restartPenalty &&
          body.id !== this.restartTaker && !this.keepers.has(body.id))) {
      // goal kick: opponents out of the box; penalty: EVERYONE except
      // the taker and the keepers (the same command war, second class —
      // the cap expired at 14s because brains re-targeted the box)
      const nearHome = this.ball.pos.x < PITCH.length / 2;
      const t2 = command.target;
      const inBox = (nearHome ? t2.x < GOAL.boxDepthM + 1.5 : t2.x > PITCH.length - GOAL.boxDepthM - 1.5) &&
        Math.abs(t2.y - PITCH.width / 2) < GOAL.boxHalfWidthM + 1.5;
      if (inBox) {
        const xOut = nearHome ? GOAL.boxDepthM + 2 : PITCH.length - GOAL.boxDepthM - 2;
        command = { ...command, target: { x: xOut, y: t2.y } };
      }
    }
    this.receiveOnLine.delete(body.id);
    body.command = command;
    body.pathIndex = 0;
    body.arrived = command.type === 'hold' && command.facing === undefined && body.speed <= 0.02;
    body.arrivedAtTick = body.arrived ? this.tick : -1;
  }

  private snapshot(): Frame {
    const bodies: FrameBody[] = this.bodies.map((b) => {
      const target = this.liveTargets.get(b.id) ?? currentTarget(b);
      const fb: FrameBody = {
        id: b.id,
        team: b.team,
        x: b.pos.x,
        y: b.pos.y,
        vx: b.vel.x,
        vy: b.vel.y,
        facing: b.facing,
        regime: b.regime,
        stance: b.stance,
      };
      if (target) {
        fb.tx = target.x;
        fb.ty = target.y;
      }
      const action = this.actionLabels.get(b.id);
      if (action) fb.action = action;
      return fb;
    });
    return {
      tick: this.tick,
      t: this.tick * DT,
      bodies,
      ...(this.bannerText ? { banner: this.bannerText } : {}),
      ball: {
        x: this.ball.pos.x,
        y: this.ball.pos.y,
        z: this.ball.z,
        phase: this.ball.phase,
        carrierId: this.ball.carrierId,
      },
    };
  }
}

/** Run a scenario start-to-finish; the full-rate frame list is the result. */
export function runScenario(def: ScenarioDef, seed = 'workbench'): Frame[] {
  const sim = new Sim(def, seed);
  const frames: Frame[] = [];
  for (let i = 0; i < def.durationTicks; i++) frames.push(sim.step());
  return frames;
}
