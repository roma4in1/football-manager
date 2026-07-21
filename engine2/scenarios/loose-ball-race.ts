/**
 * loose-ball-race — possession contests as arrival races (spec §5-L2
 * acceptance: "two players racing to a loose ball resolves by physics").
 * A ball is rolled into space between two chasers: the nearer-but-slower
 * body vs the farther-but-faster one, twice with the geometry flipped so
 * each profile wins one race. The claim must fall out of L1 kinematics +
 * ball physics — nothing scripted about the outcome.
 */
import type { ScenarioDef } from '../engine2-types.ts';

const slow = { pace: 10, acceleration: 11, agility: 12, balance: 12, dribbling: 12, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 };
const fast = { pace: 18, acceleration: 15, agility: 12, balance: 12, dribbling: 12, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 };

const scenario: ScenarioDef = {
  version: 1,
  name: 'loose-ball-race',
  description: 'A feeder rolls the ball out; near-slow vs far-fast race it. Race 1: ball drops near the slow body (he wins). Race 2 (t=15s): re-fed long — the fast body eats the gap and wins.',
  durationTicks: 300, // 30 s
  bodies: [
    { id: 'feeder', team: 'home', pos: { x: 15, y: 34 }, attributes: { ...slow } },
    { id: 'near-slow', team: 'home', pos: { x: 42, y: 44 }, attributes: { ...slow } },
    { id: 'far-fast', team: 'away', pos: { x: 58, y: 44 }, attributes: { ...fast } },
  ],
  ball: { carrier: 'feeder' },
  script: [
    // race 1: ball dies around x≈45, 10m from near-slow, 15m from far-fast
    { atTick: 12, bodyId: 'near-slow', command: { type: 'chaseBall', regime: 'sprint' } },
    { atTick: 12, bodyId: 'far-fast', command: { type: 'chaseBall', regime: 'sprint' } },
    // reset for race 2: both retreat to marks while the feeder collects.
    // far-fast stands down EARLY — a chaser whose opponent claimed now keeps
    // hunting (the press), and this drill is about races, not duels
    { atTick: 48, bodyId: 'far-fast', command: { type: 'moveTo', target: { x: 60, y: 26 }, regime: 'run' } },
    { atTick: 120, bodyId: 'near-slow', command: { type: 'moveTo', target: { x: 47, y: 18 }, regime: 'run' } },
    { atTick: 120, bodyId: 'feeder', command: { type: 'chaseBall', regime: 'run' } },
    { afterPrevious: true, bodyId: 'feeder', command: { type: 'moveTo', target: { x: 15, y: 34 }, regime: 'jog' } },
    // race 2: a much longer feed — raw pace closes the 13m spot gap
    { atTick: 210, bodyId: 'near-slow', command: { type: 'chaseBall', regime: 'sprint' } },
    { atTick: 210, bodyId: 'far-fast', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
  kicks: [
    // 8.5 m/s dies ~21m out (x≈36) — short of far-fast's reach, the race is
    // near-slow's 11m vs far-fast's 24m
    { atTick: 10, bodyId: 'feeder', kick: { target: { x: 46, y: 34 }, speedMps: 8.5, loftDeg: 0 } },
    // the winner lays it back for the reset (no-ops if the race went the
    // other way — a drill, not an outcome script)
    { atTick: 110, bodyId: 'near-slow', kick: { target: { x: 17, y: 34 }, speedMps: 9, loftDeg: 0 } },
    // 13.5 m/s: far-fast INTERCEPTS mid-line (the anticipation racing this
    // drill is about) with a controllable closing speed — a 16 m/s drive
    // popped off his boot and turned the race into a scramble lottery
    { atTick: 208, bodyId: 'feeder', kick: { target: { x: 88, y: 34 }, speedMps: 13.5, loftDeg: 0 } },
  ],
};

export default scenario;
