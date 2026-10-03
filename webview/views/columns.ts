import type { AppApi } from '../api';
import type { Column } from '../table';
import { barCell, esc, fmtMs, fmtPct, funcHtml } from '../util';

interface Costed {
  func: number;
  self: number;
  total: number;
}

/** The Total / Self / Module columns shared by the tree and list views; `base` is the 100 % sample count. */
export function costColumns<R extends Costed>(app: AppApi, base: () => number): Column<R>[] {
  const ms = (n: number) => fmtMs(n * app.profile.sampleMs);
  const pct = (n: number) => (100 * n) / Math.max(1, base());
  return [
    {
      id: 'total',
      title: 'Total CPU',
      width: '92px',
      align: 'right',
      html: (r) => esc(ms(r.total)),
      sort: (r) => r.total,
      tooltip: 'CPU time in the function and everything it calls',
    },
    {
      id: 'totalPct',
      title: 'Total %',
      width: '76px',
      align: 'right',
      html: (r) => barCell(pct(r.total), fmtPct(pct(r.total)), 'total'),
      sort: (r) => r.total,
    },
    {
      id: 'self',
      title: 'Self CPU',
      width: '92px',
      align: 'right',
      html: (r) => esc(ms(r.self)),
      sort: (r) => r.self,
      tooltip: 'CPU time in the function body itself',
    },
    {
      id: 'selfPct',
      title: 'Self %',
      width: '76px',
      align: 'right',
      html: (r) => barCell(pct(r.self), fmtPct(pct(r.self)), 'self'),
      sort: (r) => r.self,
    },
    {
      id: 'totalSamples',
      title: 'Total samples',
      width: '96px',
      align: 'right',
      html: (r) => r.total.toLocaleString('en-US'),
      sort: (r) => r.total,
      hiddenByDefault: true,
    },
    {
      id: 'selfSamples',
      title: 'Self samples',
      width: '96px',
      align: 'right',
      html: (r) => r.self.toLocaleString('en-US'),
      sort: (r) => r.self,
      hiddenByDefault: true,
    },
    {
      id: 'module',
      title: 'Module',
      width: 'minmax(90px, 200px)',
      html: (r) => `<span class="module">${esc(app.profile.moduleName(r.func))}</span>`,
      sort: (r) => app.profile.moduleName(r.func).toLowerCase(),
      desc: false,
    },
    {
      id: 'source',
      title: 'Source File',
      width: 'minmax(120px, 260px)',
      html: (r) => {
        const src = app.profile.funcSource(r.func);
        if (!src) return '';
        const base = src.file.replace(/^.*[\\/]/, '');
        return `<span class="module" title="${esc(src.file)}">${esc(base)}:${src.line}</span>`;
      },
      sort: (r) => app.profile.funcSource(r.func)?.file.toLowerCase() ?? '',
      desc: false,
      hiddenByDefault: true,
    },
  ];
}

export function nameColumn<R extends Costed>(app: AppApi): Column<R> {
  return {
    id: 'name',
    title: 'Function Name',
    width: 'minmax(260px, 1fr)',
    html: (r) => nameHtml(app, r.func),
    sort: (r) => app.profile.funcLabel(r.func).toLowerCase(),
    desc: false,
    fixed: true,
  };
}

export function nameHtml(app: AppApi, func: number): string {
  const p = app.profile;
  const cls = p.isSynthetic(func) ? 'fn synthetic' : p.isExternal(func) ? 'fn external' : 'fn';
  return `<span class="${cls}" title="${esc(p.fullName(func))}">${funcHtml(p.funcLabel(func), app.searchRegex())}</span>`;
}
