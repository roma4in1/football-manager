/**
 * TeamShapePitch — the team tab's live pitch: the ELEVEN, shaped by the
 * team sliders, morphing as you drag them.
 *
 * Not an illustration: the dots run the ENGINE's own anchor deformation
 * (agent-positioning.ts via AGENT_CAL) — lineHeight shifts the block,
 * width scales the lateral spread, compactness squeezes toward the team
 * centroid. Shown as the out-of-possession defensive block (that is where
 * all three shape sliders bite; in possession only width applies). Ghost
 * dots mark the raw anchors so a slider's displacement is legible.
 *
 * Press/tempo don't move a standing shape — the press chases the ball —
 * so they render as derived facts (chasers + range) under the pitch.
 */

import { AGENT_CAL, PITCH_LENGTH, PITCH_WIDTH } from '@fm/engine/agent-model';
import type { TeamInstructions, Vec2 } from '@fm/engine/types';
import type { PitchPlayer } from './PitchEditor.tsx';

const GROUP_VAR: Record<string, string> = { G: 'var(--pos-gk)', D: 'var(--pos-df)', M: 'var(--pos-mf)', F: 'var(--pos-fw)' };
const hueOf = (position: string) => GROUP_VAR[position[0]] ?? 'var(--pos-mf)';
const initials = (name: string) => name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

const W = PITCH_LENGTH;
const H = PITCH_WIDTH;

/** The engine's static shaping of one anchor (out of possession, level score). */
function shape(anchor: Vec2, team: TeamInstructions, centroidX: number): Vec2 {
  const base: Vec2 = {
    x: anchor.x + (team.lineHeight - 0.5) * AGENT_CAL.lineHeightShiftM,
    y: H / 2 + (anchor.y - H / 2) * (AGENT_CAL.widthSpreadBase + AGENT_CAL.widthSpreadGain * team.width),
  };
  // compactness = a weighted pull toward the block's centroid x (engine
  // blends attractors by weight against anchorPull)
  const w = AGENT_CAL.compactnessPull * team.compactness;
  return {
    x: Math.max(1, Math.min(W - 1, (base.x * AGENT_CAL.anchorPull + centroidX * w) / (AGENT_CAL.anchorPull + w))),
    y: Math.max(1, Math.min(H - 1, base.y)),
  };
}

export function TeamShapePitch({ players, team }: { players: PitchPlayer[]; team: TeamInstructions }) {
  const isGk = (p: PitchPlayer) => p.position.startsWith('G');
  const anchorOf = (p: PitchPlayer): Vec2 => p.tactic.anchors.defensiveBlock;

  const outfield = players.filter((p) => !isGk(p));
  // centroid of the lineHeight-shifted block (pre-squeeze), like the engine's
  // running centroid settles
  const centroidX =
    outfield.reduce((s, p) => s + anchorOf(p).x + (team.lineHeight - 0.5) * AGENT_CAL.lineHeightShiftM, 0) /
    Math.max(1, outfield.length);

  const dots = players.map((p) => {
    const raw = anchorOf(p);
    const at = isGk(p) ? { x: AGENT_CAL.gkBoxX, y: H / 2 } : shape(raw, team, centroidX);
    return { p, raw, at };
  });

  const nPressers = Math.max(1, Math.round(AGENT_CAL.pressersCount * (0.5 + team.pressTrigger)));
  const chaseRange = Math.round(
    AGENT_CAL.pressMaxDistM * (AGENT_CAL.pressRangeBase + AGENT_CAL.pressRangeGain * team.pressTrigger),
  );

  return (
    <div className="team-shape">
      <svg className="pitch" viewBox={`0 0 ${W} ${H}`}>
        <rect x="0" y="0" width={W} height={H} fill="#f0f6f1" />
        <g stroke="#c9dccd" strokeWidth="0.35" fill="none">
          <rect x="0.3" y="0.3" width={W - 0.6} height={H - 0.6} />
          <line x1={W / 2} y1="0.3" x2={W / 2} y2={H - 0.3} />
          <circle cx={W / 2} cy={H / 2} r="9.15" />
          <rect x="0.3" y={H / 2 - 20.16} width="16.5" height="40.32" />
          <rect x={W - 16.8} y={H / 2 - 20.16} width="16.5" height="40.32" />
        </g>
        <text x={W - 2} y={H / 2} fontSize="2.6" fill="#9db7a2" textAnchor="end">attack →</text>

        {/* ghosts: the raw anchors — displacement makes the slider visible */}
        {dots.filter(({ p }) => !isGk(p)).map(({ p, raw }) => (
          <circle key={`g-${p.tactic.playerId}`} cx={raw.x} cy={raw.y} r="1.6"
                  fill={hueOf(p.position)} opacity="0.18" />
        ))}

        {/* the shaped eleven */}
        {dots.map(({ p, at }) => (
          <g key={p.tactic.playerId}>
            <circle cx={at.x} cy={at.y} r="2.5" fill={hueOf(p.position)} stroke="#fff" strokeWidth="0.35" />
            <text x={at.x} y={at.y + 0.75} fontSize="1.9" fill="#fff" textAnchor="middle" fontWeight="700">
              {initials(p.name)}
            </text>
          </g>
        ))}
      </svg>
      <p className="muted team-shape-caption">
        Defensive block shown — line height, width and compactness reshape it live (ghosts = raw anchors).
        The press doesn't hold shape: at this trigger, <strong>{nPressers}</strong> chaser{nPressers > 1 ? 's' : ''} hunt
        the ball from up to <strong>{chaseRange}m</strong>. Tempo drives decisions, not positions.
      </p>
    </div>
  );
}
