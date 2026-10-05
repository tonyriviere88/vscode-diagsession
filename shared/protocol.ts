// Types shared by the extension host and the webview.

import type { JmcConfig } from './jmc';

/** The JSON written by DiagSessionAnalyzer (see analyzer/Program.cs). Arrays are columnar to keep it compact. */
export interface RawProfile {
  version: number;
  source: string;
  traceStartUtc: string;
  traceDurationMs: number;
  sampleIntervalMs: number;
  cpuCount: number;
  symbolPath: string;
  msSymbols: boolean;
  /** Only the PDBs next to their binary were loaded (plus the modules asked for); those modules are the user's code. */
  localSymbols: boolean;
  analysisSeconds: number;
  process: { pid: number; name: string; commandLine: string; startMs: number; endMs: number };
  processes: { pid: number; name: string; samples: number }[];
  /** `local`: the symbols came from a PDB next to the binary (local mode only). */
  modules: { name: string; path: string; symbols: boolean; local: boolean; system: boolean }[];
  funcNames: string[];
  funcModule: number[];
  files: string[];
  addrFunc: number[];
  addrFile: number[];
  addrLine: number[];
  stackParent: number[];
  stackAddr: number[];
  threads: { tid: number; name: string; startMs: number; endMs: number }[];
  sampleTime: number[];
  sampleThread: number[];
  sampleStack: number[];
}

export interface LineHits {
  /** 1-based line -> [self samples, total samples] */
  [line: number]: [number, number];
}

/** The Just My Code rules of a report: `.vscode/jmc.json` of its workspace folder. */
export interface JmcSettings {
  config: JmcConfig;
  /** Expands `${workspaceFolder}` in the file rules. */
  workspaceFolder?: string;
}

export type ToWebview =
  | { type: 'progress'; text: string }
  | { type: 'profile'; json: string; fromCache: boolean; justMyCode: JmcSettings; showExternalCode: boolean }
  | { type: 'justMyCode'; jmc: JmcSettings }
  | { type: 'showExternalCode'; show: boolean }
  | { type: 'error'; text: string };

export type FromWebview =
  | { type: 'ready' }
  /** `loadSymbols`: path of a module whose PDB is to be searched everywhere, on top of the ones asked for before. */
  | { type: 'reanalyze'; pid?: number; msSymbols?: boolean; loadSymbols?: string }
  | {
      type: 'openSource';
      file: string;
      line: number;
      hits: LineHits;
      totalSamples: number;
      sampleMs: number;
      label: string;
    }
  | { type: 'copy'; text: string }
  /** The "Show external code" checkbox changed: saved in the settings. */
  | { type: 'setShowExternalCode'; show: boolean };
