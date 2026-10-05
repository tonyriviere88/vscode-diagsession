// Just My Code rules: the `.vscode/jmc.json` format shared with vscode-windbg (schemas/jmc.schema.json).
//
//   {
//     "inheritDefaults": true,
//     "external": { "symbols": ["boost::*"], "files": ["third_party/*"], "modules": ["Qt6*"] },
//     "user": { "symbols": [], "files": [], "modules": [] }
//   }
//
// "external" marks code as non-user; "user" entries win over "external" ones.

export interface RuleSet {
  symbols?: string[];
  files?: string[];
  modules?: string[];
}

export interface JmcConfig {
  inheritDefaults?: boolean;
  external?: RuleSet;
  user?: RuleSet;
}

/** The built-in external rules (STL, CRT, Windows SDK and system modules), the same as vscode-windbg's. */
export const DEFAULT_EXTERNAL: Required<RuleSet> = {
  symbols: [
    'std',
    'stdext',
    'Concurrency',
    'concurrency',
    'invoke_main',
    'mainCRTStartup',
    'wmainCRTStartup',
    'WinMainCRTStartup',
    'wWinMainCRTStartup',
    '__scrt_*',
    '__acrt_*',
    '__vcrt_*',
    '__security_*',
    '_RTC_*',
    '__GSHandlerCheck*',
    '__CxxFrameHandler*',
    '_CxxThrowException',
    '__std_*',
    '_guard_*',
    'operator new',
    'operator delete',
  ],
  files: [
    '*/vctools/crt/*',
    '*/Microsoft Visual Studio/*/VC/Tools/MSVC/*',
    '*/Windows Kits/*',
    '*/minkernel/*',
    '*/onecore/*',
    '*/shared/inc/*',
  ],
  modules: [
    'ntdll',
    'kernel32',
    'kernelbase',
    'ucrtbase*',
    'msvcp*',
    'vcruntime*',
    'concrt*',
    'user32',
    'win32u',
    'gdi32*',
    'combase',
    'rpcrt4',
    'ole32',
    'oleaut32',
    'advapi32',
    'sechost',
    'msvcrt',
  ],
};

export interface CodeLocation {
  /** Function name without module, e.g. "app::Shape::area". */
  fn?: string;
  /** Module name, e.g. "sample.exe" (extension optional). */
  module?: string;
  /** Source file path. */
  file?: string;
}

interface SymbolRule {
  exact?: string;
  regex?: RegExp;
  withModule: boolean;
}

interface FileRule {
  prefix?: string;
  suffix?: string;
  regex?: RegExp;
}

interface Compiled {
  symbols: SymbolRule[];
  files: FileRule[];
  modules: RegExp[];
}

/** '*' matches any run of characters (separators included), '?' one character. */
function wildcardToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let src = '';
  for (const ch of pattern) {
    if (ch === '*') {
      if (!src.endsWith('.*')) src += '.*';
    } else if (ch === '?') src += '.';
    else src += ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
  }
  return new RegExp('^' + src + '$', caseInsensitive ? 'i' : '');
}

const hasWildcard = (pattern: string) => pattern.includes('*') || pattern.includes('?');

const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();

const isAbsolutePattern = (p: string) => /^[a-z]:\//i.test(p) || p.startsWith('/');

/** Removes template argument lists: "std::vector<int>::push_back" -> "std::vector::push_back". */
export function stripTemplateArgs(name: string): string {
  let out = '';
  let depth = 0;
  for (const ch of name) {
    if (ch === '<') depth++;
    else if (ch === '>') {
      if (depth > 0) depth--;
    } else if (depth === 0) out += ch;
  }
  return out;
}

/** Removes a trailing parameter list: "f(int)" -> "f"; "X::operator()" keeps its own parentheses. */
function stripParams(name: string): string {
  if (!name.endsWith(')')) return name;
  let depth = 0;
  for (let i = name.length - 1; i >= 0; i--) {
    if (name[i] === ')') depth++;
    else if (name[i] === '(' && --depth === 0) {
      const head = name.slice(0, i).trimEnd();
      return head && !head.endsWith('operator') ? head : name;
    }
  }
  return name;
}

export function moduleBaseName(module: string): string {
  return module.replace(/^.*[\\/]/, '').replace(/\.(dll|exe|sys|drv|ocx|cpl|pyd)$/i, '');
}

function compileSymbol(rule: string): SymbolRule {
  const withModule = rule.includes('!');
  return hasWildcard(rule) ? { regex: wildcardToRegExp(rule, withModule), withModule } : { exact: rule, withModule };
}

function compileFile(rule: string, workspaceFolder: string | undefined): FileRule {
  let r = rule.trim();
  if (workspaceFolder) r = r.replace(/\$\{workspaceFolder\}/g, workspaceFolder);
  r = normalizePath(r);
  if (hasWildcard(r)) {
    if (!isAbsolutePattern(r) && !r.startsWith('*')) r = '*/' + r;
    return { regex: wildcardToRegExp(r, true) };
  }
  return isAbsolutePattern(r) ? { prefix: r.replace(/\/$/, '') } : { suffix: r.replace(/\/$/, '') };
}

function compile(rules: RuleSet, workspaceFolder: string | undefined): Compiled {
  const list = (l: unknown) => (Array.isArray(l) ? l.filter((s): s is string => typeof s === 'string' && !!s.trim()) : []);
  return {
    symbols: list(rules.symbols).map((s) => compileSymbol(s.trim())),
    files: list(rules.files).map((s) => compileFile(s, workspaceFolder)),
    modules: list(rules.modules).map((s) => wildcardToRegExp(moduleBaseName(s.trim()), true)),
  };
}

function symbolMatches(rule: SymbolRule, names: string[], module: string | undefined): boolean {
  const candidates = rule.withModule ? (module ? names.map((n) => `${module}!${n}`) : []) : names;
  for (const c of candidates) {
    if (rule.regex) {
      if (rule.regex.test(c)) return true;
      continue;
    }
    const cmp = rule.withModule ? c.toLowerCase() : c;
    const ex = rule.withModule ? rule.exact!.toLowerCase() : rule.exact!;
    if (cmp === ex || cmp.startsWith(ex + '::') || cmp.startsWith(ex + '<')) return true;
  }
  return false;
}

function fileMatches(rule: FileRule, file: string): boolean {
  if (rule.regex) return rule.regex.test(file);
  if (rule.prefix !== undefined) return file === rule.prefix || file.startsWith(rule.prefix + '/');
  const s = rule.suffix!;
  return file === s || file.endsWith('/' + s) || file.includes('/' + s + '/') || file.startsWith(s + '/');
}

function matches(rules: Compiled, names: string[], module: string | undefined, file: string | undefined): boolean {
  if (names.length && rules.symbols.some((r) => symbolMatches(r, names, module))) return true;
  if (file && rules.files.some((r) => fileMatches(r, file))) return true;
  return !!module && rules.modules.some((r) => r.test(module));
}

export class JmcRules {
  /** Keep the built-in rules; for the profiler, system modules are external too. */
  readonly inheritDefaults: boolean;
  private readonly external: Compiled;
  private readonly user: Compiled;

  constructor(config: JmcConfig, workspaceFolder?: string) {
    this.inheritDefaults = config.inheritDefaults !== false;
    const ext = config.external ?? {};
    const inherit = (key: keyof RuleSet) => [...(this.inheritDefaults ? DEFAULT_EXTERNAL[key] : []), ...(Array.isArray(ext[key]) ? ext[key]! : [])];
    this.external = compile({ symbols: inherit('symbols'), files: inherit('files'), modules: inherit('modules') }, workspaceFolder);
    this.user = compile(config.user ?? {}, workspaceFolder);
  }

  /** 'user' when a user rule matches, else 'external' when an external rule does, else null. */
  classify(loc: CodeLocation): 'user' | 'external' | null {
    const names = new Set<string>();
    if (loc.fn) {
      for (const n of [loc.fn, stripTemplateArgs(loc.fn)]) {
        names.add(n);
        names.add(stripParams(n));
      }
    }
    const nameList = [...names];
    const module = loc.module ? moduleBaseName(loc.module).toLowerCase() : undefined;
    const file = loc.file ? normalizePath(loc.file) : undefined;
    if (matches(this.user, nameList, module, file)) return 'user';
    return matches(this.external, nameList, module, file) ? 'external' : null;
  }
}
