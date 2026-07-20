/**
 * knock-past — the classic take-a-touch-around move (the L3 judgment ask):
 * the carrier walks the ball up to a parked defender, knocks it PAST his
 * side into space with a deliberate low kick, arcs around the other
 * shoulder, and runs onto his own knock. The defender reacts and chases —
 * the re-collect is a real race, and a knock angled too tight gets swept
 * up by the defender (the honest risk of the move).
 */
import type { ScenarioDef } from '../engine2-types.ts';

const scenario: ScenarioDef = {
  version: 1,
  name: 'knock-past',
  description: 'Carry up to the parked defender, knock the ball past his right into space, arc around his left, run onto it. The defender reacts and races the re-collect.',
  durationTicks: 240, // 24 s
  bodies: [
    { id: 'attacker', team: 'home', pos: { x: 30, y: 34 }, attributes: { pace: 15, acceleration: 15, agility: 14, balance: 14, dribbling: 15, firstTouch: 15, passing: 16, tackling: 12, strength: 12, stamina: 12 } },
    { id: 'defender', team: 'away', pos: { x: 52, y: 34 }, attributes: { pace: 11, acceleration: 11, agility: 12, balance: 12, dribbling: 10, firstTouch: 12, passing: 12, tackling: 14, strength: 13, stamina: 12 } },
  ],
  ball: { carrier: 'attacker' },
  script: [
    // dribble up, then attack the defender's shoulder AT SPRINT — the knock
    // is released mid-stride (a standing knock gives up two seconds; the
    // move is only real with a flying start, against a slow defender)
    { atTick: 8, bodyId: 'attacker', command: { type: 'moveTo', target: { x: 43, y: 34 }, regime: 'run' } },
    // NOTE: pure atTick script — afterPrevious queues are consumed at EVERY
    // arrival, so an early moveTo arrival would eat the queued chases
    { atTick: 46, bodyId: 'attacker', command: { type: 'followPath', points: [{ x: 49, y: 35 }, { x: 54, y: 33 }], regime: 'sprint' } },
    { atTick: 66, bodyId: 'attacker', command: { type: 'chaseBall', regime: 'sprint' } },
    { atTick: 140, bodyId: 'attacker', command: { type: 'chaseBall', regime: 'sprint' } },
    // the flat-footed defender turns and reacts
    { atTick: 64, bodyId: 'defender', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
  kicks: [
    // the knock, released mid-sprint — a carrier's ball is only in kicking
    // reach at touch instants, so three attempts cover the timing (a fired
    // kick releases the ball; later attempts no-op)
    { atTick: 58, bodyId: 'attacker', kick: { target: { x: 64, y: 28.5 }, speedMps: 8, loftDeg: 0 } },
    { atTick: 64, bodyId: 'attacker', kick: { target: { x: 64, y: 28.5 }, speedMps: 8, loftDeg: 0 } },
    { atTick: 70, bodyId: 'attacker', kick: { target: { x: 64, y: 28.5 }, speedMps: 8, loftDeg: 0 } },
  ],
};

export default scenario;
