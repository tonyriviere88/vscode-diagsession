import { JmcRules } from '../shared/jmc';
import type { JmcSettings, LineHits, RawProfile } from '../shared/protocol';

/** What part of the capture the views look at. */
export interface Filter {
  t0: number;
  t1: number;
  /** Thread indexes to keep, or null for all threads. */
  threads: Set<number> | null;
  /** Collapse runs of external frames into one "[External Code]" frame (VS "Show External Code" off). */
  hideExternal: boolean;
}

/** Filtered samples, aggregated by (thread, stack). */
export interface Selection {
  groups: Int32Array;
  stacks: Int32Array;
  weights: Float64Array;
  count: number;
  /** Number of samples in the selection. */
  total: number;
  /** Time of the first and last selected sample (ms). */
  first: number;
  last: number;
}

export class TreeNode {
  self = 0;
  total = 0;
  children: TreeNode[] = [];
  childMap: Map<number, TreeNode> | null = new Map();
  expanded = false;
  hot = false;
  constructor(
    readonly func: number,
    readonly parent: TreeNode | null,
    readonly depth: number,
  ) {}

  child(func: number): TreeNode {
    let c = this.childMap!.get(func);
    if (!c) {
      c = new TreeNode(func, this, this.depth + 1);
      this.childMap!.set(func, c);
      this.children.push(c);
    }
    return c;
  }
}

export interface FuncStat {
  func: number;
  self: number;
  total: number;
}

export interface ModuleStat {
  module: number;
  self: number;
  total: number;
  funcs: number;
}

export interface ThreadStat {
  thread: number;
  samples: number;
  first: number;
  last: number;
}

/** The calls at one stack depth of a thread, in time order: each span is a run of samples with the same frames. */
export interface CallSpans {
  start: number[];
  /** One sample interval after the span's last sample, or the next sample when that comes sooner. */
  end: number[];
  func: number[];
  samples: number[];
}

/** When a thread ran: runs of samples, in time order. */
export interface Activity {
  start: number[];
  end: number[];
}

export interface CallerCallee {
  func: number;
  self: number;
  total: number;
  callers: FuncStat[];
  callees: FuncStat[];
}

/** OS frames every thread starts with; the thread's own entry point is the first frame after them. */
const THREAD_THUNKS = new Set([
  'RtlUserThreadStart',
  '_RtlUserThreadStart',
  'BaseThreadInitThunk',
  'KiStartUserThread',
  'KiStartSystemThread',
  'PspSystemThreadStartup',
  'KiStartUserThreadReturn',
]);

/** Entry points only the main thread runs: the CRT startup and the program's main. */
const MAIN_ENTRY = /^(?:w?mainCRTStartup|w?WinMainCRTStartup|__scrt_common_main(?:_seh)?|invoke_main|w?main|w?WinMain)(?:\(.*\))?$/;

/** A thread unsampled for more than this many intervals was not running: a pause in its activity. */
const GAP_SAMPLES = 4;

export class Profile {
  readonly raw: RawProfile;
  readonly nFuncs: number;
  /** Synthetic functions appended after the real ones. */
  readonly NO_STACK: number;
  readonly ROOT: number;
  readonly THREAD_BASE: number;
  /** EXTERNAL_BASE + f: a collapsed run of external frames, entered through function f. */
  readonly EXTERNAL_BASE: number;

  readonly stackFunc: Int32Array;
  readonly stackParent: Int32Array;
  readonly funcExternal: Uint8Array;
  readonly funcNoSymbol: Uint8Array;
  readonly funcNames: string[];
  readonly funcModule: Int32Array;
  readonly sampleMs: number;
  readonly duration: number;
  readonly threadLabels: string[];
  readonly threadStarts: string[];
  /** Index of the process's main thread, -1 when it cannot be told. */
  readonly mainThread: number;

  constructor(raw: RawProfile, justMyCode: JmcSettings) {
    this.raw = raw;
    this.nFuncs = raw.funcNames.length;
    this.NO_STACK = this.nFuncs;
    this.ROOT = this.nFuncs + 1;
    this.THREAD_BASE = this.nFuncs + 2;
    this.EXTERNAL_BASE = this.THREAD_BASE + raw.threads.length;
    this.sampleMs = raw.sampleIntervalMs || 1;

    const nStacks = raw.stackParent.length;
    this.stackParent = Int32Array.from(raw.stackParent);
    this.stackFunc = new Int32Array(nStacks);
    for (let s = 0; s < nStacks; s++) this.stackFunc[s] = raw.addrFunc[raw.stackAddr[s]];

    this.funcNames = raw.funcNames.slice();
    this.funcModule = Int32Array.from(raw.funcModule);
    this.funcExternal = new Uint8Array(this.nFuncs);
    this.funcNoSymbol = new Uint8Array(this.nFuncs);
    for (let f = 0; f < this.nFuncs; f++) {
      if (this.funcNames[f] === '?') {
        // The analyzer folds a module's unnamed addresses into one "?" frame.
        const m = raw.modules[this.funcModule[f]];
        this.funcNames[f] = `${m ? m.name : 'unknown'} (no symbols)`;
        this.funcNoSymbol[f] = 1;
      }
    }
    this.setJustMyCode(justMyCode);

    let last = 0;
    for (const t of raw.sampleTime) if (t > last) last = t;
    this.duration = Math.max(raw.traceDurationMs, last);

    // A sample with the deepest stack is the most likely to reach the thread's real entry point.
    const bestSample = new Int32Array(raw.threads.length).fill(-1);
    const bestDepth = new Int32Array(raw.threads.length);
    const mainEntry = new Uint8Array(this.nFuncs);
    for (let f = 0; f < this.nFuncs; f++) if (MAIN_ENTRY.test(this.funcNames[f])) mainEntry[f] = 1;
    const runsMain = new Uint8Array(raw.threads.length);
    for (let i = 0; i < raw.sampleThread.length; i++) {
      const s = raw.sampleStack[i];
      if (s < 0) continue;
      const th = raw.sampleThread[i];
      let d = 0;
      for (let x = s; x >= 0 && d < 400; x = this.stackParent[x]) {
        d++;
        if (mainEntry[this.stackFunc[x]]) runsMain[th] = 1;
      }
      if (d > bestDepth[th]) {
        bestDepth[th] = d;
        bestSample[th] = i;
      }
    }
    this.threadStarts = raw.threads.map((_, i) => (bestSample[i] >= 0 ? this.threadStartFunction(raw.sampleStack[bestSample[i]]) : ''));
    this.threadLabels = raw.threads.map((t, i) => {
      const start = this.threadStarts[i];
      const name = t.name ? `${t.name} ` : '';
      return `${name}(${t.tid})${start ? ' ' + start : ''}`;
    });
    this.mainThread = this.findMainThread(runsMain, bestSample);
  }

  /**
   * The thread that ran the CRT startup or main. Without symbols: the thread entered through the process's own
   * executable, else the first thread of a process started in the trace.
   */
  private findMainThread(runsMain: Uint8Array, bestSample: Int32Array): number {
    const raw = this.raw;
    const threads = raw.threads;
    const earliest = (candidates: boolean[]) => {
      let main = -1;
      for (let t = 0; t < threads.length; t++) {
        if (candidates[t] && (main < 0 || threads[t].startMs < threads[main].startMs)) main = t;
      }
      return main;
    };
    let main = earliest(Array.from(runsMain, (r) => r === 1));
    if (main >= 0) return main;

    const base = (name: string) => name.toLowerCase().replace(/\.exe$/, '');
    const exe = raw.modules.findIndex((m) => base(m.name) === base(raw.process.name));
    if (exe >= 0) {
      const entersExe = threads.map((_, t) => {
        if (bestSample[t] < 0) return false;
        let entry = -1; // the outermost frame outside the system modules
        for (let s = raw.sampleStack[bestSample[t]]; s >= 0; s = this.stackParent[s]) {
          const m = raw.modules[this.funcModule[this.stackFunc[s]]];
          if (!m || !m.system) entry = this.funcModule[this.stackFunc[s]];
        }
        return entry === exe;
      });
      main = earliest(entersExe);
      if (main >= 0) return main;
    }

    if (!(raw.process.startMs > 0)) return -1;
    let first = -1;
    let unique = true;
    for (let t = 0; t < threads.length; t++) {
      if (!(threads[t].startMs > 0)) continue;
      if (first < 0 || threads[t].startMs < threads[first].startMs) {
        first = t;
        unique = true;
      } else if (threads[t].startMs === threads[first].startMs) {
        unique = false;
      }
    }
    // The main thread is created with the process; a thread started later is not it.
    return first >= 0 && unique && threads[first].startMs - raw.process.startMs < 100 ? first : -1;
  }

  /**
   * External code: frames of symbol-less modules (with local symbols only, of modules whose PDB was not next to them)
   * and code the Just My Code rules make external: by default system modules, the STL, CRT and Windows SDK. A "user"
   * rule wins over all of them.
   */
  setJustMyCode(jmc: JmcSettings): void {
    const rules = new JmcRules(jmc.config, jmc.workspaceFolder);
    const local = this.raw.localSymbols;
    for (let f = 0; f < this.nFuncs; f++) {
      const m = this.raw.modules[this.funcModule[f]];
      const kind = rules.classify({
        fn: this.funcNoSymbol[f] ? undefined : this.funcNames[f],
        module: m?.name,
        file: this.funcSource(f)?.file,
      });
      const external =
        kind === 'external' || !m || !m.symbols || (local && !m.local) || (rules.inheritDefaults && m.system);
      this.funcExternal[f] = kind !== 'user' && external ? 1 : 0;
    }
  }

  get threadCount(): number {
    return this.raw.threads.length;
  }

  funcLabel(f: number): string {
    if (f < this.nFuncs) return this.funcNames[f];
    if (f === this.NO_STACK) return '[No stack]';
    if (f >= this.EXTERNAL_BASE) return `[External Code] ${this.funcLabel(f - this.EXTERNAL_BASE)}`;
    if (f === this.ROOT) return `${this.raw.process.name} (PID ${this.raw.process.pid})`;
    const t = this.raw.threads[f - this.THREAD_BASE];
    return t ? `Thread ${this.threadLabels[f - this.THREAD_BASE]}` : '?';
  }

  private funcSrc: ({ file: string; line: number } | null)[] | null = null;

  /** Where a function is defined: the lowest sampled line of its most common file (null without line info). */
  funcSource(f: number): { file: string; line: number } | null {
    if (!this.funcSrc) {
      const raw = this.raw;
      const best = new Map<number, Map<number, number>>(); // func -> file -> min line
      for (let a = 0; a < raw.addrFunc.length; a++) {
        const file = raw.addrFile[a];
        if (file < 0) continue;
        const fn = raw.addrFunc[a];
        let files = best.get(fn);
        if (!files) best.set(fn, (files = new Map()));
        const line = raw.addrLine[a];
        const cur = files.get(file);
        if (cur === undefined || (line > 0 && line < cur)) files.set(file, line);
      }
      this.funcSrc = new Array(this.nFuncs).fill(null);
      for (const [fn, files] of best) {
        const [file, line] = [...files.entries()][0];
        this.funcSrc[fn] = { file: raw.files[file], line };
      }
    }
    return f < this.nFuncs ? this.funcSrc[f] : null;
  }

  /** Module index of a function (for a collapsed run, of its entry point), -1 for none. */
  moduleOf(f: number): number {
    if (f >= this.EXTERNAL_BASE) return this.moduleOf(f - this.EXTERNAL_BASE);
    return f < this.nFuncs ? this.funcModule[f] : -1;
  }

  moduleName(f: number): string {
    if (f >= this.EXTERNAL_BASE) return this.moduleName(f - this.EXTERNAL_BASE);
    if (f >= this.nFuncs) return '';
    const m = this.raw.modules[this.funcModule[f]];
    return m ? m.name : '';
  }

  /** "module!function", the qualified name used in exports and search. */
  fullName(f: number): string {
    if (f < this.nFuncs && this.funcNoSymbol[f]) return this.funcNames[f];
    if (f >= this.EXTERNAL_BASE) return `[External Code] ${this.fullName(f - this.EXTERNAL_BASE)}`;
    const m = this.moduleName(f);
    return m ? `${m}!${this.funcLabel(f)}` : this.funcLabel(f);
  }

  private byFullName: Map<string, number> | null = null;

  /** A real function by its `fullName`, or -1: finds a function again in a rebuilt profile. */
  funcNamed(name: string): number {
    if (!this.byFullName) {
      this.byFullName = new Map();
      for (let f = 0; f < this.nFuncs; f++) this.byFullName.set(this.fullName(f), f);
    }
    return this.byFullName.get(name) ?? -1;
  }

  /** A module's unnamed addresses (for a collapsed run, entered through one). */
  lacksSymbols(f: number): boolean {
    if (f >= this.EXTERNAL_BASE) return this.lacksSymbols(f - this.EXTERNAL_BASE);
    return f < this.nFuncs && this.funcNoSymbol[f] === 1;
  }

  isSynthetic(f: number): boolean {
    return f >= this.nFuncs;
  }

  isExternal(f: number): boolean {
    return f < this.nFuncs ? this.funcExternal[f] === 1 : f >= this.EXTERNAL_BASE;
  }

  /** First frame of a thread's stacks that is not OS plumbing (RtlUserThreadStart, BaseThreadInitThunk...). */
  private threadStartFunction(stack: number): string {
    const chain: number[] = [];
    for (let s = stack; s >= 0; s = this.stackParent[s]) chain.push(this.stackFunc[s]);
    chain.reverse();
    for (const f of chain) {
      if (THREAD_THUNKS.has(this.funcLabel(f))) continue;
      return this.fullName(f);
    }
    return chain.length ? this.fullName(chain[chain.length - 1]) : '';
  }

  // ---------------------------------------------------------------- selection

  select(filter: Filter, groupByThread = false): Selection {
    const raw = this.raw;
    const nStacks = this.stackParent.length + 1;
    const map = new Map<number, number>();
    let total = 0;
    let first = Infinity;
    let last = -Infinity;
    const { t0, t1, threads } = filter;
    for (let i = 0; i < raw.sampleTime.length; i++) {
      const t = raw.sampleTime[i];
      if (t < t0 || t > t1) continue;
      const th = raw.sampleThread[i];
      if (threads && !threads.has(th)) continue;
      const key = (groupByThread ? th + 1 : 0) * nStacks + raw.sampleStack[i] + 1;
      map.set(key, (map.get(key) ?? 0) + 1);
      total++;
      if (t < first) first = t;
      if (t > last) last = t;
    }
    const count = map.size;
    const groups = new Int32Array(count);
    const stacks = new Int32Array(count);
    const weights = new Float64Array(count);
    let i = 0;
    for (const [key, w] of map) {
      groups[i] = Math.floor(key / nStacks) - 1;
      stacks[i] = (key % nStacks) - 1;
      weights[i] = w;
      i++;
    }
    return { groups, stacks, weights, count, total, first, last };
  }

  /** Functions of a stack, leaf first, with external runs optionally collapsed. */
  private frames(stack: number, hideExternal: boolean, out: number[]): number[] {
    out.length = 0;
    if (stack < 0) {
      out.push(this.NO_STACK);
      return out;
    }
    for (let s = stack; s >= 0; s = this.stackParent[s]) {
      const f = this.stackFunc[s];
      const prev = out.length ? out[out.length - 1] : -1;
      if (hideExternal && this.funcExternal[f]) {
        // Leaf first: each frame of a run is further out, so the last one seen is the run's entry point.
        if (prev >= this.EXTERNAL_BASE) out[out.length - 1] = this.EXTERNAL_BASE + f;
        else out.push(this.EXTERNAL_BASE + f);
        continue;
      }
      if (prev === f && this.funcNoSymbol[f] === 1) continue;
      out.push(f);
    }
    return out;
  }

  // ---------------------------------------------------------------- call trees

  topDown(sel: Selection, hideExternal: boolean): TreeNode {
    const root = new TreeNode(this.ROOT, null, 0);
    const groupNodes = new Map<number, TreeNode>();
    const groupNode = (g: number) => {
      if (g < 0) return root;
      let n = groupNodes.get(g);
      if (!n) groupNodes.set(g, (n = root.child(this.THREAD_BASE + g)));
      return n;
    };
    // Memoize stack -> node per group: stacks share prefixes, so each stack is resolved once.
    const memo = new Map<number, TreeNode>();
    const nStacks = this.stackParent.length;
    const chain: number[] = [];
    const nodeFor = (g: number, stack: number): TreeNode => {
      const base = (g + 1) * nStacks;
      if (stack < 0) return groupNode(g).child(this.NO_STACK);
      const hit = memo.get(base + stack);
      if (hit) return hit;
      chain.length = 0;
      let s = stack;
      while (s >= 0 && !memo.has(base + s)) {
        chain.push(s);
        s = this.stackParent[s];
      }
      let node = s >= 0 ? memo.get(base + s)! : groupNode(g);
      for (let i = chain.length - 1; i >= 0; i--) {
        const cs = chain[i];
        let f = this.stackFunc[cs];
        // Runs of external code or of one module's unnamed addresses fold into a single frame. Root first, an
        // external run is named after the frame it was entered through.
        let fold: boolean;
        if (hideExternal && this.funcExternal[f]) {
          fold = node.func >= this.EXTERNAL_BASE;
          f = this.EXTERNAL_BASE + f;
        } else {
          fold = f === node.func && this.funcNoSymbol[f] === 1;
        }
        if (!fold) node = node.child(f);
        memo.set(base + cs, node);
      }
      return node;
    };
    for (let i = 0; i < sel.count; i++) nodeFor(sel.groups[i], sel.stacks[i]).self += sel.weights[i];
    finishTree(root);
    return root;
  }

  /** Inverted tree: roots are the functions where samples landed, children are their callers. */
  bottomUp(sel: Selection, hideExternal: boolean): TreeNode {
    const root = new TreeNode(this.ROOT, null, 0);
    const frames: number[] = [];
    for (let i = 0; i < sel.count; i++) {
      const w = sel.weights[i];
      this.frames(sel.stacks[i], hideExternal, frames);
      if (sel.groups[i] >= 0) frames.push(this.THREAD_BASE + sel.groups[i]);
      let node = root;
      for (let k = 0; k < frames.length; k++) {
        node = node.child(frames[k]);
        node.total += w;
        if (k === 0) node.self += w;
      }
      root.total += w;
    }
    const stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      n.childMap = null;
      n.children.sort((a, b) => b.total - a.total);
      for (const c of n.children) stack.push(c);
    }
    return root;
  }

  // ---------------------------------------------------------------- flat views

  functions(sel: Selection): FuncStat[] {
    const n = this.THREAD_BASE; // real functions, NO_STACK and ROOT
    const self = new Float64Array(n);
    const total = new Float64Array(n);
    const stamp = new Int32Array(n).fill(-1);
    for (let i = 0; i < sel.count; i++) {
      const w = sel.weights[i];
      const stack = sel.stacks[i];
      if (stack < 0) {
        self[this.NO_STACK] += w;
        total[this.NO_STACK] += w;
        continue;
      }
      self[this.stackFunc[stack]] += w;
      for (let s = stack; s >= 0; s = this.stackParent[s]) {
        const f = this.stackFunc[s];
        if (stamp[f] !== i) {
          stamp[f] = i; // count a sample once per function, even through recursion
          total[f] += w;
        }
      }
    }
    const out: FuncStat[] = [];
    for (let f = 0; f < n; f++) if (total[f] > 0) out.push({ func: f, self: self[f], total: total[f] });
    return out;
  }

  modules(sel: Selection): ModuleStat[] {
    const nm = this.raw.modules.length + 1; // last = unknown
    const self = new Float64Array(nm);
    const total = new Float64Array(nm);
    const stamp = new Int32Array(nm).fill(-1);
    const funcs = new Array<Set<number>>(nm);
    const mod = (f: number) => (this.funcModule[f] >= 0 ? this.funcModule[f] : nm - 1);
    for (let i = 0; i < sel.count; i++) {
      const w = sel.weights[i];
      const stack = sel.stacks[i];
      if (stack < 0) continue;
      self[mod(this.stackFunc[stack])] += w;
      for (let s = stack; s >= 0; s = this.stackParent[s]) {
        const f = this.stackFunc[s];
        const m = mod(f);
        (funcs[m] ??= new Set()).add(f);
        if (stamp[m] !== i) {
          stamp[m] = i;
          total[m] += w;
        }
      }
    }
    const out: ModuleStat[] = [];
    for (let m = 0; m < nm; m++) {
      if (total[m] > 0) out.push({ module: m, self: self[m], total: total[m], funcs: funcs[m]?.size ?? 0 });
    }
    return out;
  }

  moduleLabel(m: number): string {
    return this.raw.modules[m]?.name ?? '[unknown]';
  }

  threads(filter: Filter): ThreadStat[] {
    const raw = this.raw;
    const stats = raw.threads.map((_, thread) => ({ thread, samples: 0, first: Infinity, last: -Infinity }));
    for (let i = 0; i < raw.sampleTime.length; i++) {
      const t = raw.sampleTime[i];
      if (t < filter.t0 || t > filter.t1) continue;
      const s = stats[raw.sampleThread[i]];
      s.samples++;
      if (t < s.first) s.first = t;
      if (t > s.last) s.last = t;
    }
    return stats.filter((s) => s.samples > 0);
  }

  /** The threads the filter keeps, the main thread first, then the busiest. */
  threadsByWork(filter: Filter): ThreadStat[] {
    const main = (s: ThreadStat) => (s.thread === this.mainThread ? 1 : 0);
    return this.threads(filter)
      .filter((s) => !filter.threads || filter.threads.has(s.thread))
      .sort((a, b) => main(b) - main(a) || b.samples - a.samples);
  }

  private samplesByThread: Int32Array[] | null = null;

  /** Sample indexes of each thread, in time order. */
  private threadSamples(thread: number): Int32Array {
    if (!this.samplesByThread) {
      const raw = this.raw;
      const counts = new Int32Array(raw.threads.length);
      for (const th of raw.sampleThread) counts[th]++;
      const lists = Array.from(counts, (n) => new Int32Array(n));
      counts.fill(0);
      for (let i = 0; i < raw.sampleThread.length; i++) {
        const th = raw.sampleThread[i];
        lists[th][counts[th]++] = i;
      }
      const time = raw.sampleTime;
      for (const l of lists) {
        let sorted = true;
        for (let k = 1; k < l.length && sorted; k++) sorted = time[l[k - 1]] <= time[l[k]];
        if (!sorted) l.sort((a, b) => time[a] - time[b]);
      }
      this.samplesByThread = lists;
    }
    return this.samplesByThread[thread];
  }

  /** Outermost function of a stack. */
  private stackRoot(stack: number): number {
    let f = -1;
    for (let s = stack; s >= 0; s = this.stackParent[s]) f = this.stackFunc[s];
    return f;
  }

  private rootByThread: Int32Array | null = null;

  /** The outermost function most of a thread's stacks start with (its entry point), -1 without stacks. */
  private threadRoot(thread: number): number {
    if (!this.rootByThread) this.rootByThread = new Int32Array(this.raw.threads.length).fill(-2);
    if (this.rootByThread[thread] === -2) {
      const counts = new Map<number, number>();
      for (const i of this.threadSamples(thread)) {
        const s = this.raw.sampleStack[i];
        if (s < 0) continue;
        const f = this.stackRoot(s);
        counts.set(f, (counts.get(f) ?? 0) + 1);
      }
      let root = -1;
      for (const [f, n] of counts) if (root < 0 || n > counts.get(root)!) root = f;
      this.rootByThread[thread] = root;
    }
    return this.rootByThread[thread];
  }

  /**
   * The calls of a thread over time, per stack depth (root first): consecutive samples with the same frames down to
   * a depth make one span there. An unsampled thread was not running (preempted, waiting): its calls go on across
   * such a pause up to `maxPauseMs` long, when the same frames are on the stack after it; a longer one ends them.
   * A failed stack walk (no stack, or one that does not reach the thread's entry point) says nothing of the calls:
   * it counts as a pause too.
   */
  callSpans(filter: Filter, thread: number, maxPauseMs: number): CallSpans[] {
    const raw = this.raw;
    const ms = this.sampleMs;
    const gap = Math.max(maxPauseMs, GAP_SAMPLES * ms);
    const root = this.threadRoot(thread);
    const rows: CallSpans[] = [];
    const open: number[] = []; // index in rows[d] of the span open at depth d
    const frames: number[] = [];
    let prev = -Infinity;
    const close = (from: number, end: number) => {
      for (let d = from; d < open.length; d++) rows[d].end[open[d]] = end;
      open.length = from;
    };
    for (const i of this.threadSamples(thread)) {
      const t = raw.sampleTime[i];
      if (t < filter.t0 || t > filter.t1) continue;
      const stack = raw.sampleStack[i];
      if (root >= 0 && (stack < 0 || this.stackRoot(stack) !== root)) continue;
      this.frames(stack, filter.hideExternal, frames);
      const n = frames.length;
      let k = 0;
      const running = t - prev <= gap;
      if (running) while (k < open.length && k < n && rows[k].func[open[k]] === frames[n - 1 - k]) k++;
      // Samples come about one interval apart, sometimes sooner: a call ends where the next one starts.
      close(k, running ? Math.min(prev + ms, t) : prev + ms);
      for (let d = 0; d < k; d++) rows[d].samples[open[d]]++;
      for (let d = k; d < n; d++) {
        const r = (rows[d] ??= { start: [], end: [], func: [], samples: [] });
        open.push(r.start.length);
        r.start.push(t);
        r.end.push(t + ms);
        r.func.push(frames[n - 1 - d]);
        r.samples.push(1);
      }
      prev = t;
    }
    close(0, prev + ms);
    return rows;
  }

  /** When a thread ran, cut where it went unsampled for a few intervals. */
  activity(filter: Filter, thread: number): Activity {
    const raw = this.raw;
    const ms = this.sampleMs;
    const gap = GAP_SAMPLES * ms;
    const out: Activity = { start: [], end: [] };
    let prev = -Infinity;
    for (const i of this.threadSamples(thread)) {
      const t = raw.sampleTime[i];
      if (t < filter.t0 || t > filter.t1) continue;
      if (t - prev > gap) {
        out.start.push(t);
        out.end.push(t + ms);
      } else {
        out.end[out.end.length - 1] = t + ms;
      }
      prev = t;
    }
    return out;
  }

  callerCallee(sel: Selection, func: number): CallerCallee {
    const n = this.THREAD_BASE; // real functions, NO_STACK and ROOT
    const callers = new Float64Array(n);
    const callees = new Float64Array(n);
    const calleeSelf = new Float64Array(n);
    const stampA = new Int32Array(n).fill(-1);
    const stampB = new Int32Array(n).fill(-1);
    const frames: number[] = [];
    let self = 0;
    let total = 0;
    for (let i = 0; i < sel.count; i++) {
      const w = sel.weights[i];
      this.frames(sel.stacks[i], false, frames);
      let found = false;
      for (let k = 0; k < frames.length; k++) {
        if (frames[k] !== func) continue;
        if (!found) {
          found = true;
          total += w;
          if (k === 0) self += w;
        }
        const caller = k + 1 < frames.length ? frames[k + 1] : this.ROOT;
        if (stampA[caller] !== i) {
          stampA[caller] = i;
          callers[caller] += w;
        }
        if (k > 0) {
          const callee = frames[k - 1];
          if (stampB[callee] !== i) {
            stampB[callee] = i;
            callees[callee] += w;
            if (k - 1 === 0) calleeSelf[callee] += w;
          }
        }
      }
    }
    const list = (arr: Float64Array, selfArr?: Float64Array) => {
      const out: FuncStat[] = [];
      for (let f = 0; f < n; f++) if (arr[f] > 0) out.push({ func: f, total: arr[f], self: selfArr ? selfArr[f] : 0 });
      return out.sort((a, b) => b.total - a.total);
    };
    return { func, self, total, callers: list(callers), callees: list(callees, calleeSelf) };
  }

  // ---------------------------------------------------------------- source lines

  /** The source file of a function (the one most of its sampled addresses map to), if the PDB had line info. */
  sourceOf(sel: Selection, func: number): { file: number; line: number } | undefined {
    const raw = this.raw;
    const byLine = new Map<number, number>(); // file * 1e7 + line -> weight
    // Addresses of the function, weighted by how often they appear in the selection.
    for (let i = 0; i < sel.count; i++) {
      for (let s = sel.stacks[i]; s >= 0; s = this.stackParent[s]) {
        if (this.stackFunc[s] !== func) continue;
        const a = raw.stackAddr[s];
        if (raw.addrFile[a] < 0) continue;
        const key = raw.addrFile[a] * 1e7 + raw.addrLine[a];
        byLine.set(key, (byLine.get(key) ?? 0) + sel.weights[i]);
      }
    }
    if (byLine.size === 0) {
      // Not in the selection (or only reached from elsewhere): fall back to any address of the function.
      for (let a = 0; a < raw.addrFunc.length; a++) {
        if (raw.addrFunc[a] === func && raw.addrFile[a] >= 0) return { file: raw.addrFile[a], line: raw.addrLine[a] };
      }
      return undefined;
    }
    let best = -1;
    let bestW = -1;
    for (const [k, w] of byLine) {
      if (w > bestW) {
        bestW = w;
        best = k;
      }
    }
    const byFile = new Map<number, number>();
    for (const [k, w] of byLine) byFile.set(Math.floor(k / 1e7), (byFile.get(Math.floor(k / 1e7)) ?? 0) + w);
    let file = Math.floor(best / 1e7);
    let fw = -1;
    for (const [f, w] of byFile) {
      if (w > fw) {
        fw = w;
        file = f;
      }
    }
    // The hottest line of that file within the function.
    let line = 0;
    let lw = -1;
    for (const [k, w] of byLine) {
      if (Math.floor(k / 1e7) === file && w > lw) {
        lw = w;
        line = k % 1e7;
      }
    }
    return { file, line };
  }

  /** Self / total samples per line of one source file. */
  lineHits(sel: Selection, file: number): LineHits {
    const raw = this.raw;
    const hits: LineHits = {};
    const stamp = new Map<number, number>();
    for (let i = 0; i < sel.count; i++) {
      const w = sel.weights[i];
      let leaf = true;
      for (let s = sel.stacks[i]; s >= 0; s = this.stackParent[s], leaf = false) {
        const a = raw.stackAddr[s];
        if (raw.addrFile[a] !== file) continue;
        const line = raw.addrLine[a];
        const h = (hits[line] ??= [0, 0]);
        if (leaf) h[0] += w;
        if (stamp.get(line) !== i) {
          stamp.set(line, i);
          h[1] += w;
        }
      }
    }
    return hits;
  }

  /** CPU usage over time, as a fraction of all cores, for the samples matching a thread filter. */
  timeline(bins: number, threads: Set<number> | null): Float64Array {
    const raw = this.raw;
    const out = new Float64Array(bins);
    const binMs = this.duration / bins;
    for (let i = 0; i < raw.sampleTime.length; i++) {
      if (threads && !threads.has(raw.sampleThread[i])) continue;
      const b = Math.min(bins - 1, Math.floor(raw.sampleTime[i] / binMs));
      out[b]++;
    }
    const scale = this.sampleMs / (binMs * Math.max(1, this.raw.cpuCount));
    for (let b = 0; b < bins; b++) out[b] *= scale;
    return out;
  }
}

/** One frame of a saved tree path. */
export interface PathStep {
  /** `fullName`: survives a rebuilt profile, unlike function ids. */
  name: string;
  module: string;
  /** The frame had no symbols: once they are loaded, it is one or more named frames of the same module. */
  loose: boolean;
}

/** A node's path below the root, to find it again in a tree built from another profile (e.g. with more symbols). */
export function nodePath(p: Profile, node: TreeNode): PathStep[] {
  const path: PathStep[] = [];
  for (let n: TreeNode | null = node; n && n.parent; n = n.parent) {
    path.unshift({ name: p.fullName(n.func), module: p.moduleName(n.func), loose: p.lacksSymbols(n.func) });
  }
  return path;
}

/**
 * Follows a path from `nodePath` as far as it matches; `matched` counts the steps found. A step without symbols
 * matches the heaviest frame of its module, and goes on down that module's frames until the next step matches.
 */
export function followPath(p: Profile, root: TreeNode, path: readonly PathStep[]): { node: TreeNode; matched: number } {
  const exact = (n: TreeNode, s: PathStep) => n.children.find((c) => p.fullName(c.func) === s.name);
  const sameModule = (n: TreeNode, s: PathStep) =>
    n.children.reduce<TreeNode | undefined>((best, c) => (p.moduleName(c.func) === s.module && (!best || c.total > best.total) ? c : best), undefined);
  let n = root;
  let matched = 0;
  for (let i = 0; i < path.length; i++) {
    const s = path[i];
    let c = exact(n, s);
    if (!c && s.loose && s.module) {
      c = sameModule(n, s);
      const next = path[i + 1];
      for (let hops = 0; c && next && !exact(c, next) && hops < 64; hops++) {
        const deeper = sameModule(c, s);
        if (!deeper) break;
        c = deeper;
      }
    }
    if (!c) break;
    n = c;
    matched++;
  }
  return { node: n, matched };
}

/** Totals bottom-up, children sorted by total, maps dropped. */
function finishTree(root: TreeNode): void {
  const order: TreeNode[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    order.push(n);
    for (const c of n.children) stack.push(c);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    n.total += n.self;
    if (n.parent) n.parent.total += n.total;
    n.childMap = null;
    n.children.sort((a, b) => b.total - a.total);
  }
}

/** Marks and expands the hot path: follow the heaviest child while it carries most of its parent's time. */
export function markHotPath(root: TreeNode): TreeNode {
  let node = root;
  root.expanded = true;
  const floor = root.total * 0.05;
  while (node.children.length) {
    const c = node.children.reduce((a, b) => (b.total > a.total ? b : a));
    // Stop where the time fans out: no child keeps a quarter of its parent (the top levels always descend, since
    // thread roots and [External Code] split the time between threads).
    if (c.total < floor || (node.depth > 1 && c.total < node.total * 0.25)) break;
    c.hot = true;
    node.expanded = true;
    node = c;
  }
  return node;
}
