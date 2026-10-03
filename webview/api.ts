import type { Filter, Profile, Selection, TreeNode } from './model';

export interface View {
  readonly id: string;
  readonly title: string;
  readonly element: HTMLElement;
  /** Recompute after the filter or search changed; only called while the view is visible. */
  refresh(): void;
  /** Search box text changed (views that use it). */
  onSearch?(re: RegExp | null, next: boolean): void;
  /** Search box placeholder while this view is active. */
  readonly searchHint?: string;
  /** What the view shows (mode, expanded nodes, zoom...), kept when a re-analysis rebuilds the report. */
  saveState?(): unknown;
  /** Called on the rebuilt view, before its first refresh, with what `saveState` returned. */
  restoreState?(state: any): void;
}

export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
}

/** What views need from the application shell. */
export interface AppApi {
  readonly profile: Profile;
  readonly filter: Filter;
  /** Filtered samples, aggregated; cached until the filter changes. */
  selection(groupByThread?: boolean): Selection;
  searchRegex(): RegExp | null;
  openSource(func: number): void;
  showCallerCallee(func: number): void;
  showInCallTree(func: number): void;
  showInFlameGraph(func: number): void;
  setThreads(threads: Set<number> | null): void;
  showMenu(ev: MouseEvent, items: MenuItem[]): void;
  functionMenu(ev: MouseEvent, func: number, node?: TreeNode): void;
  copy(text: string): void;
  reanalyze(opts: { pid?: number; msSymbols?: boolean }): void;
  /** Re-runs the analysis with the PDB of a module searched everywhere (null when it already has symbols). */
  loadSymbolsItem(module: number): MenuItem | null;
  toast(text: string): void;
}
