/**
 * render.ts — pure canvas drawing for the workbench. Legibility bar: the
 * EA FC 26 2D tactical view (spec §4) — clean pitch, legible oriented
 * markers, obvious state. An instrument, not a product screen.
 */
import { PITCH, type Frame, type FrameBody } from '@fm/engine2/types';

export interface Overlays {
  velocity: boolean;
  targets: boolean;
  labels: boolean;
  hud: boolean;
}

export interface ViewState {
  /** interpolated presentation frame (never sim-side interpolation) */
  prev: Frame;
  next: Frame;
  k: number; // 0..1 between prev and next
  overlays: Overlays;
  selectedId: string | null;
  sourceLabel: string;
  clockT: number; // sim seconds
  tick: number;
}

const COLORS = {
  pitch: '#1c4a30',
  stripe: '#1f5136',
  line: 'rgba(255,255,255,0.55)',
  home: '#f2f4f6',
  away: '#f0b43c',
  facing: '#0d1114',
  selected: '#8f86ff',
  velocity: '#7fd4ff',
  target: 'rgba(255,255,255,0.65)',
  label: 'rgba(255,255,255,0.85)',
  hud: 'rgba(255,255,255,0.75)',
  ball: '#ffffff',
  ballShadow: 'rgba(0,0,0,0.35)',
  carrierRing: '#ffffff',
} as const;

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const lerpAngle = (a: number, b: number, k: number): number => {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * k;
};

interface Blended extends FrameBody {
  bx: number;
  by: number;
  bfacing: number;
}

function blend(view: ViewState): Blended[] {
  const nextById = new Map(view.next.bodies.map((b) => [b.id, b]));
  return view.prev.bodies.map((p) => {
    const n = nextById.get(p.id) ?? p;
    return {
      ...n,
      bx: lerp(p.x, n.x, view.k),
      by: lerp(p.y, n.y, view.k),
      bfacing: lerpAngle(p.facing, n.facing, view.k),
    };
  });
}

export function draw(canvas: HTMLCanvasElement, view: ViewState): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = (cssW * PITCH.width) / PITCH.length;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = `${cssH}px`;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx || cssW === 0) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const S = cssW / PITCH.length;
  const X = (x: number): number => x * S;
  const Y = (y: number): number => y * S;

  // ── pitch ────────────────────────────────────────────────────────────────
  ctx.fillStyle = COLORS.pitch;
  ctx.fillRect(0, 0, cssW, cssH);
  for (let i = 0; i < 7; i++) {
    if (i % 2 === 0) continue;
    ctx.fillStyle = COLORS.stripe;
    ctx.fillRect(X((i * PITCH.length) / 7), 0, X(PITCH.length / 7), cssH);
  }
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(X(0.5), Y(0.5), X(PITCH.length - 1) - X(0.5), Y(PITCH.width - 1) - Y(0.5));
  ctx.beginPath();
  ctx.moveTo(X(PITCH.length / 2), Y(0.5));
  ctx.lineTo(X(PITCH.length / 2), Y(PITCH.width - 0.5));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(X(PITCH.length / 2), Y(PITCH.width / 2), X(9.15), 0, Math.PI * 2);
  ctx.stroke();
  for (const side of [0, 1]) {
    const gx = side === 0 ? 0.5 : PITCH.length - 0.5;
    const dir = side === 0 ? 1 : -1;
    ctx.strokeRect(X(gx), Y(PITCH.width / 2 - 20.16), X(16.5 * dir), Y(40.32));
    ctx.strokeRect(X(gx), Y(PITCH.width / 2 - 9.16), X(5.5 * dir), Y(18.32));
    ctx.beginPath();
    ctx.arc(X(gx + 11 * dir), Y(PITCH.width / 2), 2, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.line;
    ctx.fill();
  }

  const bodies = blend(view);
  const r = Math.max(6, S * 0.9);

  // ── overlays under the bodies ────────────────────────────────────────────
  if (view.overlays.targets) {
    for (const b of bodies) {
      if (b.tx === undefined || b.ty === undefined) continue;
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.moveTo(X(b.bx), Y(b.by));
      ctx.lineTo(X(b.tx), Y(b.ty));
      ctx.strokeStyle = COLORS.target;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(X(b.tx), Y(b.ty), 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ── bodies: oriented markers ─────────────────────────────────────────────
  for (const b of bodies) {
    if (b.id === view.selectedId) {
      ctx.beginPath();
      ctx.arc(X(b.bx), Y(b.by), r + 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.selected;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(X(b.bx), Y(b.by), r, 0, Math.PI * 2);
    ctx.fillStyle = b.team === 'home' ? COLORS.home : COLORS.away;
    ctx.fill();
    // facing notch — orientation always visible
    ctx.beginPath();
    ctx.moveTo(X(b.bx), Y(b.by));
    ctx.lineTo(X(b.bx) + Math.cos(b.bfacing) * r * 0.95, Y(b.by) + Math.sin(b.bfacing) * r * 0.95);
    ctx.strokeStyle = COLORS.facing;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    if (view.overlays.velocity) {
      const vx = lerp(0, b.vx, 1);
      const vy = lerp(0, b.vy, 1);
      if (Math.hypot(vx, vy) > 0.2) {
        ctx.beginPath();
        ctx.moveTo(X(b.bx), Y(b.by));
        ctx.lineTo(X(b.bx + vx * 0.6), Y(b.by + vy * 0.6));
        ctx.strokeStyle = COLORS.velocity;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }
    if (view.overlays.labels) {
      ctx.font = `600 ${Math.max(9, r * 0.9)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.label;
      ctx.fillText(`${b.id} · ${b.regime}`, X(b.bx), Y(b.by) + r + Math.max(10, r));
    }
  }

  // ── the ball: shadow at ground truth, dot lifted+scaled by height (the
  // spec's height cue); a carrier gets a ring so possession is obvious ─────
  {
    const bp = view.prev.ball;
    const bn = view.next.ball;
    const bx = lerp(bp.x, bn.x, view.k);
    const by = lerp(bp.y, bn.y, view.k);
    const bz = lerp(bp.z, bn.z, view.k);
    const br = Math.max(3, r * 0.38) * (1 + Math.min(bz, 8) * 0.10);
    if (bz > 0.15) {
      ctx.beginPath();
      ctx.ellipse(X(bx), Y(by), br * 0.9, br * 0.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.ballShadow;
      ctx.fill();
    }
    const carrier = bn.carrierId ? bodies.find((b) => b.id === bn.carrierId) : undefined;
    if (carrier) {
      ctx.beginPath();
      ctx.arc(X(carrier.bx), Y(carrier.by), r + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.carrierRing;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(X(bx), Y(by) - bz * S * 0.35, br, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.ball;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // ── HUD ──────────────────────────────────────────────────────────────────
  if (view.overlays.hud) {
    ctx.font = '600 12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.hud;
    const b = view.next.ball;
    ctx.fillText(
      `tick ${view.tick}   t ${view.clockT.toFixed(1)}s   ball ${b.phase}${b.carrierId ? `·${b.carrierId}` : ''}   ${view.sourceLabel}`,
      8,
      16,
    );
  }
}

/** nearest body to a canvas click, in meters */
export function hitTest(canvas: HTMLCanvasElement, view: ViewState, clientX: number, clientY: number): string | null {
  const rect = canvas.getBoundingClientRect();
  const S = canvas.clientWidth / PITCH.length;
  const mx = (clientX - rect.left) / S;
  const my = (clientY - rect.top) / S;
  let best: { id: string; d: number } | null = null;
  for (const b of blend(view)) {
    const d = Math.hypot(b.bx - mx, b.by - my);
    if (!best || d < best.d) best = { id: b.id, d };
  }
  return best && best.d < 2.5 ? best.id : null;
}
