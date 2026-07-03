import type { MatchEvent } from '@fm/engine/types';

export const minuteOf = (t: number): number => Math.max(1, Math.ceil(t / 60));

/** Readable one-liners from the event stream — the v0 "timeline" (no rendering). */
export function eventLines(events: MatchEvent[], names: Record<string, string>): string[] {
  const name = (id?: string): string => (id && names[id]) || 'Unknown';
  const lines: string[] = [];
  for (const e of events) {
    const m = `${minuteOf(e.t)}'`;
    if (e.type === 'goal') {
      const pen = e.meta?.source === 'penalty' ? ' (pen)' : e.meta?.header === 1 ? ' (header)' : '';
      lines.push(`${m} GOAL${pen} — ${name(e.playerId)}`);
    } else if (e.type === 'card') {
      const kind = e.meta?.card === 'red' ? (e.meta?.secondYellow === 1 ? 'RED CARD (2nd yellow)' : 'RED CARD') : 'Yellow card';
      lines.push(`${m} ${kind} — ${name(e.playerId)}`);
    } else if (e.type === 'injury') {
      lines.push(`${m} Injury — ${name(e.playerId)}`);
    }
  }
  return lines;
}

export function fmtRemaining(until: Date, now = new Date()): string {
  let s = Math.max(0, Math.floor((until.getTime() - now.getTime()) / 1000));
  const d = Math.floor(s / 86_400); s -= d * 86_400;
  const h = Math.floor(s / 3_600); s -= h * 3_600;
  const min = Math.floor(s / 60); s -= min * 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${min}m`;
  if (min > 0) return `${min}m ${s}s`;
  return `${s}s`;
}

export const pct = (x: number): string => `${Math.round(x)}%`;
