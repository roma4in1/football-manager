/**
 * struck-ball — free-ball physics (spec §5-L2 acceptance: "a struck ball
 * rolls/flies/bounces believably"). A carrier strikes three sequenced balls:
 * a firm ground pass (watch it decelerate, not glide), a mid-loft chip
 * (flight → bounce → bounce → roll), and a high launch. Judge each life:
 * flight arc, bounce decay, the roll-out.
 */
import type { ScenarioDef } from '../engine2-types.ts';

const attrs = { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 14, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 };

const scenario: ScenarioDef = {
  version: 1,
  name: 'struck-ball',
  description: 'Ground drive (14 m/s), then collect and chip (16 m/s @ 30°), then launch (20 m/s @ 45°). Roll, flight, bounce — judged per life.',
  durationTicks: 400, // 40 s
  bodies: [
    { id: 'striker', team: 'home', pos: { x: 20, y: 34 }, attributes: { ...attrs } },
  ],
  ball: { carrier: 'striker' },
  script: [
    // after each strike, walk to the ball to collect for the next one
    { atTick: 120, bodyId: 'striker', command: { type: 'chaseBall', regime: 'jog' } },
    { atTick: 260, bodyId: 'striker', command: { type: 'chaseBall', regime: 'jog' } },
  ],
  kicks: [
    // 14 m/s rolls out ~58m (x≈78) — a firm drive that stays on the pitch
    { atTick: 15, bodyId: 'striker', kick: { target: { x: 90, y: 34 }, speedMps: 14, loftDeg: 0 } },
    { atTick: 150, bodyId: 'striker', kick: { target: { x: 20, y: 34 }, speedMps: 16, loftDeg: 30 } },
    { atTick: 290, bodyId: 'striker', kick: { target: { x: 80, y: 45 }, speedMps: 20, loftDeg: 45 } },
  ],
};

export default scenario;
