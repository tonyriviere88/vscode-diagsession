export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function fmtMs(ms: number): string {
  if (ms >= 10_000) return (ms / 1000).toFixed(2) + ' s';
  return Math.round(ms).toLocaleString('en-US') + ' ms';
}

export function fmtPct(p: number): string {
  if (p <= 0) return '0 %';
  return (p < 10 ? p.toFixed(2) : p.toFixed(1)) + ' %';
}

export function fmtTime(ms: number): string {
  return (ms / 1000).toFixed(ms < 10_000 ? 3 : 2) + ' s';
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A cell with a proportional bar behind the percentage. */
export function barCell(pct: number, text: string, kind: 'total' | 'self' = 'total'): string {
  const w = Math.max(0, Math.min(100, pct));
  return `<div class="bar ${kind}" style="width:${w.toFixed(1)}%"></div><span>${esc(text)}</span>`;
}

/** Splits "ns::Class::method<T>(args)" so the name part can be emphasised. */
export function funcHtml(name: string, search?: RegExp | null): string {
  let html = esc(name);
  if (search) {
    html = esc(name).replace(new RegExp(search.source, search.flags.includes('g') ? search.flags : search.flags + 'g'), (m) =>
      m ? `<mark>${m}</mark>` : m,
    );
  }
  return html;
}

export function searchRegex(text: string): RegExp | null {
  const t = text.trim();
  if (!t) return null;
  return new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}
