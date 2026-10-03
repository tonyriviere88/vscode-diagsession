import type { RawProfile } from '../shared/protocol';

/** What `DiagSessionAnalyzer --patch` writes: the names and source lines of the addresses of some modules. */
export interface SymbolPatch {
  version: number;
  pid: number;
  /** Address count of the profile the patch was computed for: the indexes below only fit a profile with as many. */
  addrCount: number;
  modules: { path: string; symbols: boolean }[];
  addrs: number[];
  names: string[];
  files: string[];
  /** Index into `files`, or -1. */
  addrFile: number[];
  addrLine: number[];
}

/**
 * Merges a patch into a profile of the same capture and process, in place. Returns false when it does not fit
 * (another process, or a profile built from other samples); the profile is then left untouched.
 */
export function applySymbolPatch(raw: RawProfile, patch: SymbolPatch): boolean {
  if (patch.pid !== raw.process.pid || patch.addrCount !== raw.addrFunc.length) return false;

  const funcIds = new Map<string, number>();
  raw.funcNames.forEach((name, f) => funcIds.set(raw.funcModule[f] + '|' + name, f));
  const fileIds = new Map<string, number>();
  raw.files.forEach((file, i) => fileIds.set(file.toLowerCase(), i));
  const fileId = (file: string): number => {
    let id = fileIds.get(file.toLowerCase());
    if (id === undefined) {
      id = raw.files.length;
      raw.files.push(file);
      fileIds.set(file.toLowerCase(), id);
    }
    return id;
  };

  for (let k = 0; k < patch.addrs.length; k++) {
    const a = patch.addrs[k];
    // The address keeps its module; only its function (and line) changes. New functions are appended, so the ids
    // of the existing ones stay valid. The module's old "?" frame is left without addresses.
    const module = raw.funcModule[raw.addrFunc[a]];
    const key = module + '|' + patch.names[k];
    let f = funcIds.get(key);
    if (f === undefined) {
      f = raw.funcNames.length;
      raw.funcNames.push(patch.names[k]);
      raw.funcModule.push(module);
      funcIds.set(key, f);
    }
    raw.addrFunc[a] = f;
    const file = patch.addrFile[k];
    raw.addrFile[a] = file >= 0 ? fileId(patch.files[file]) : -1;
    raw.addrLine[a] = patch.addrLine[k];
  }

  for (const pm of patch.modules) {
    const m = raw.modules.find((x) => x.path.toLowerCase() === pm.path.toLowerCase());
    if (m && pm.symbols) m.symbols = true;
  }
  return true;
}
