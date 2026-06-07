import type { UIMap, UIElement } from './ui-map-types';

const DEFAULT_MAX = 50;

/** Rank: actionable first, then by confidence. */
function rankScore(e: UIElement): number {
  return (e.actionable ? 1000 : 0) + e.confidence * 100;
}

function line(e: UIElement): string {
  const flags: string[] = [];
  if (e.state?.focused) flags.push('focused');
  if (e.clickable) flags.push('clickable');
  if (e.editable) flags.push('editable');
  if (e.state?.enabled === false) flags.push('disabled');
  const [x, y, w, h] = e.bounds;
  const conf = e.confidence.toFixed(2);
  const flagStr = flags.length ? ` {${flags.join(',')}}` : '';
  return `${e.id} [${e.role}] "${e.text ?? ''}" (${conf} ${e.sources.join(',')}) @${x},${y} ${w}x${h}${flagStr}`;
}

export function renderUIMap(map: UIMap, opts: { max?: number } = {}): string {
  const max = opts.max ?? DEFAULT_MAX;
  const ranked = [...map.elements].sort((a, b) => rankScore(b) - rankScore(a));
  const shown = ranked.slice(0, max);
  const body = shown.map(line).join('\n');
  const context = `${map.active_app} — "${map.window_title}" [${map.snapshot_id}] (${map.sources_used.join('+')})`;
  const trunc = ranked.length > max ? `\n… ${max} of ${ranked.length} shown` : '';
  return `${body}${trunc}\n${context}`;
}
