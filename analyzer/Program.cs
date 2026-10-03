// DiagSessionAnalyzer: decodes the CPU samples of a Visual Studio .diagsession (or a raw .etl) with TraceEvent and
// writes a compact JSON profile that the VS Code extension renders (call tree, functions, flame graph, ...).
//
//   DiagSessionAnalyzer <file.diagsession|file.etl> --out <profile.json> [--pid N] [--cache-dir DIR]
//                       [--symbols "path;path"] [--ms-symbols] [--local-symbols] [--load-symbols "dll|dll"]
//                       [--no-lines]
//
// --local-symbols only loads the PDBs that sit next to their binary (plus the Windows ones with --ms-symbols);
// --load-symbols names module files whose PDBs are searched everywhere, Microsoft symbol server included.
// --patch (with --load-symbols and the --pid of an existing profile) only resolves those modules and writes their
// addresses' names and source lines, which the extension merges into that profile instead of analysing again.
//
// Progress goes to stderr as "PROGRESS <text>" lines; errors as "ERROR <text>" with a non-zero exit code.

using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Microsoft.Diagnostics.Symbols;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Etlx;
using Microsoft.Diagnostics.Tracing.Parsers.Kernel;

internal static class Program
{
    private const int FormatVersion = 1;
    private const string MsSymbolServer = "https://msdl.microsoft.com/download/symbols";

    private static int Main(string[] args)
    {
        try
        {
            var opts = Options.Parse(args);
            Run(opts);
            return 0;
        }
        catch (UsageException e)
        {
            Console.Error.WriteLine("ERROR " + e.Message);
            Console.Error.WriteLine("usage: DiagSessionAnalyzer <file.diagsession|file.etl> --out <profile.json> " +
                                    "[--pid N] [--cache-dir DIR] [--symbols PATH] [--ms-symbols] [--local-symbols] " +
                                    "[--load-symbols DLLS] [--no-lines]");
            return 2;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("ERROR " + e.Message.Replace('\n', ' '));
            Console.Error.WriteLine(e.ToString());
            return 1;
        }
    }

    private static void Progress(string text) => Console.Error.WriteLine("PROGRESS " + text);

    private static void Run(Options o)
    {
        var total = Stopwatch.StartNew();
        string etlx = PrepareEtlx(o);

        Progress("Loading trace");
        using var log = new TraceLog(etlx);
        double intervalMs = log.SampleProfileInterval.TotalMilliseconds;
        if (intervalMs <= 0) intervalMs = 1.0;

        // One pass to count CPU samples per process: the trace is system-wide.
        Progress("Counting samples per process");
        var perProcess = new Dictionary<int, int>();
        foreach (var ev in log.Events.ByEventType<SampledProfileTraceData>())
        {
            perProcess.TryGetValue(ev.ProcessID, out int c);
            perProcess[ev.ProcessID] = c + 1;
        }

        var processes = log.Processes
            .Where(p => perProcess.ContainsKey(p.ProcessID))
            .GroupBy(p => p.ProcessID)
            .Select(g => g.OrderByDescending(p => p.EndTimeRelativeMsec - p.StartTimeRelativeMsec).First())
            .Select(p => new ProcessRow(p.ProcessID, p.Name ?? "?", perProcess[p.ProcessID], p.CommandLine ?? ""))
            .OrderByDescending(p => p.Samples)
            .ToList();
        if (processes.Count == 0)
            throw new Exception("the trace holds no CPU samples (was the CPU Usage tool enabled?)");

        int pid = o.Pid ?? PickDefaultProcess(processes);
        var process = log.Processes.Where(p => p.ProcessID == pid)
            .OrderByDescending(p => perProcess.ContainsKey(p.ProcessID) ? 1 : 0)
            .FirstOrDefault() ?? throw new Exception($"process {pid} not found in the trace");
        Progress($"Target process {process.Name} ({pid})");

        // Collect the samples of the target process and the call stacks they use.
        var samples = new List<(double t, int tid, CallStackIndex cs)>();
        foreach (var ev in process.EventsInProcess.ByEventType<SampledProfileTraceData>())
            samples.Add((ev.TimeStampRelativeMSec, ev.ThreadID, ev.CallStackIndex()));

        var modulesUsed = new HashSet<ModuleFileIndex>();
        var seenStacks = new HashSet<CallStackIndex>();
        foreach (var s in samples)
        {
            for (var cs = s.cs; cs != CallStackIndex.Invalid && seenStacks.Add(cs); cs = log.CallStacks.Caller(cs))
            {
                var mf = log.CodeAddresses.ModuleFileIndex(log.CallStacks.CodeAddressIndex(cs));
                if (mf != ModuleFileIndex.Invalid) modulesUsed.Add(mf);
            }
        }

        // Symbols: PDB folders recorded in the trace + user paths + the (VS) symbol cache.
        using var symLog = new StringWriter();
        string symPath = BuildSymbolPath(o, log, modulesUsed, o.MsSymbols);
        Progress("Symbol path: " + symPath);
        using var reader = new SymbolReader(symLog, symPath);
        reader.SecurityCheck = _ => true; // accept PDBs from any folder (local build output, network shares)
        if (!o.MsSymbols) reader.Options |= SymbolReaderOptions.CacheOnly;

        // Modules the user asked symbols for: every location, Microsoft symbol server included.
        using var explicitReader = o.LoadSymbols.Count > 0 ? new SymbolReader(symLog, BuildSymbolPath(o, log, modulesUsed, true)) : null;
        if (explicitReader != null) explicitReader.SecurityCheck = _ => true;

        // Local mode: an empty symbol path, and the PDB found next to the DLL (or at its build location) is only
        // accepted when that folder is the folder of one of the traced binaries.
        using var localReader = o.LocalSymbols ? new SymbolReader(symLog, Directory.CreateDirectory(Path.Combine(o.CacheDir, "no-symbols")).FullName) : null;
        if (localReader != null)
        {
            var binaryDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var m in modulesUsed)
            {
                string? d = DirectoryOf(log.ModuleFiles[m].FilePath);
                if (d != null) binaryDirs.Add(d);
            }
            localReader.SecurityCheck = pdb => DirectoryOf(pdb) is { } d && binaryDirs.Contains(d);
            localReader.Options |= SymbolReaderOptions.CacheOnly;
        }

        var moduleList = modulesUsed.Select(m => log.ModuleFiles[m])
            .Where(m => !o.Patch || o.LoadSymbols.Contains(m.FilePath ?? ""))
            .OrderBy(m => m.Name)
            .ToList();
        var readers = new Dictionary<ModuleFileIndex, SymbolReader>();
        foreach (var mf in moduleList)
        {
            string file = mf.FilePath ?? "";
            if (explicitReader != null && o.LoadSymbols.Contains(file)) readers[mf.ModuleFileIndex] = explicitReader;
            else if (localReader != null && !(o.MsSymbols && ProfileBuilder.IsSystemModule(file))) readers[mf.ModuleFileIndex] = localReader;
            else readers[mf.ModuleFileIndex] = reader;
        }

        int done = 0;
        var symbolsLoaded = new HashSet<ModuleFileIndex>();
        foreach (var mf in moduleList)
        {
            done++;
            Progress($"Loading symbols {done}/{moduleList.Count}: {mf.Name}");
            try
            {
                log.CodeAddresses.LookupSymbolsForModule(readers[mf.ModuleFileIndex], mf);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"symbols for {mf.Name} failed: {e.Message}");
            }
        }

        Progress("Building profile");
        var b = new ProfileBuilder(log, mf => readers.TryGetValue(mf, out var r) ? r : reader, !o.NoLines);
        foreach (var s in samples) b.AddSample(s.t, s.tid, s.cs);

        if (o.Patch)
        {
            // Same samples in the same order: the address indexes match those of the profile being patched.
            Progress("Writing symbols");
            using (var fs = File.Create(o.Out))
            using (var w = new Utf8JsonWriter(fs))
            {
                w.WriteStartObject();
                w.WriteNumber("version", FormatVersion);
                w.WriteNumber("pid", process.ProcessID);
                b.WritePatch(w, moduleList.Select(m => m.ModuleFileIndex).ToHashSet());
                w.WriteEndObject();
            }
            if (o.Verbose) Console.Error.WriteLine(symLog.ToString());
            Progress($"Done in {total.Elapsed.TotalSeconds:F1}s");
            return;
        }

        foreach (var ca in b.UsedCodeAddresses())
        {
            if (log.CodeAddresses.MethodIndex(ca) != MethodIndex.Invalid)
            {
                var mf = log.CodeAddresses.ModuleFileIndex(ca);
                if (mf != ModuleFileIndex.Invalid) symbolsLoaded.Add(mf);
            }
        }

        Progress("Writing profile");
        using (var fs = File.Create(o.Out))
        using (var w = new Utf8JsonWriter(fs))
        {
            w.WriteStartObject();
            w.WriteNumber("version", FormatVersion);
            w.WriteString("source", o.Input);
            w.WriteString("traceStartUtc", log.SessionStartTime.ToUniversalTime().ToString("o"));
            w.WriteNumber("traceDurationMs", log.SessionDuration.TotalMilliseconds);
            w.WriteNumber("sampleIntervalMs", intervalMs);
            w.WriteNumber("cpuCount", log.NumberOfProcessors);
            w.WriteString("symbolPath", o.LocalSymbols ? "next to each binary" + (o.MsSymbols ? "; Windows modules: " + symPath : "") : symPath);
            w.WriteBoolean("msSymbols", o.MsSymbols);
            w.WriteBoolean("localSymbols", o.LocalSymbols);
            w.WriteNumber("analysisSeconds", total.Elapsed.TotalSeconds);

            w.WriteStartObject("process");
            w.WriteNumber("pid", process.ProcessID);
            w.WriteString("name", process.Name ?? "?");
            w.WriteString("commandLine", process.CommandLine ?? "");
            w.WriteNumber("startMs", process.StartTimeRelativeMsec);
            w.WriteNumber("endMs", process.EndTimeRelativeMsec);
            w.WriteEndObject();

            w.WriteStartArray("processes");
            foreach (var p in processes)
            {
                w.WriteStartObject();
                w.WriteNumber("pid", p.Pid);
                w.WriteString("name", p.Name);
                w.WriteNumber("samples", p.Samples);
                w.WriteEndObject();
            }
            w.WriteEndArray();

            // Local symbols: the module's PDB was next to it (local mode only), which makes it the user's code.
            var local = new HashSet<ModuleFileIndex>(symbolsLoaded.Where(mf => localReader != null && readers.GetValueOrDefault(mf) == localReader));
            b.Write(w, symbolsLoaded, local);
            w.WriteEndObject();
        }

        string symLogText = symLog.ToString();
        if (o.Verbose) Console.Error.WriteLine(symLogText);
        Progress($"Done in {total.Elapsed.TotalSeconds:F1}s: {samples.Count} samples");
    }

    private static int PickDefaultProcess(List<ProcessRow> processes)
    {
        // The trace is system-wide; without a pid, the target is the busiest process that is not the OS or the
        // collector itself, which is what the CPU Usage tool profiles in practice.
        var skip = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Idle", "System", "StandardCollector.Service", "VSDiagnostics", "xperf", "Registry", "MemCompression",
            "Secure System", "csrss", "dwm", "svchost", "MsMpEng", "Interrupts", "DPC",
        };
        var pick = processes.FirstOrDefault(p => p.Pid > 4 && !skip.Contains(Path.GetFileNameWithoutExtension(p.Name)));
        return (pick ?? processes[0]).Pid;
    }

    private static string PrepareEtlx(Options o)
    {
        string input = Path.GetFullPath(o.Input);
        if (!File.Exists(input)) throw new UsageException($"file not found: {input}");
        var info = new FileInfo(input);
        string key = Hash($"{input.ToLowerInvariant()}|{info.Length}|{info.LastWriteTimeUtc.Ticks}");
        string dir = Path.Combine(o.CacheDir, key);
        Directory.CreateDirectory(dir);
        string etlx = Path.Combine(dir, "trace.etlx");
        if (File.Exists(etlx)) return etlx;

        string etl;
        if (input.EndsWith(".etl", StringComparison.OrdinalIgnoreCase))
        {
            etl = input;
        }
        else
        {
            Progress("Extracting ETL from the .diagsession");
            using var zip = ZipFile.OpenRead(input);
            var entry = zip.Entries
                .Where(e => e.FullName.EndsWith(".etl", StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(e => e.Length)
                .FirstOrDefault() ?? throw new Exception("no .etl inside the .diagsession");
            etl = Path.Combine(dir, "trace.etl");
            entry.ExtractToFile(etl, overwrite: true);
        }

        Progress("Decoding ETL (first open of this file only)");
        var options = new TraceLogOptions
        {
            ContinueOnError = true,
            ConversionLog = TextWriter.Null,
        };
        string tmp = etlx + ".tmp";
        TraceLog.CreateFromEventTraceLogFile(etl, tmp, options);
        File.Move(tmp, etlx, overwrite: true);
        if (!ReferenceEquals(etl, input)) TryDelete(etl);
        return etlx;
    }

    private static string? DirectoryOf(string? path)
    {
        if (string.IsNullOrEmpty(path) || !Path.IsPathRooted(path)) return null;
        try
        {
            return Path.GetDirectoryName(Path.GetFullPath(path))?.TrimEnd('\\');
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static string BuildSymbolPath(Options o, TraceLog log, HashSet<ModuleFileIndex> modules, bool msSymbols)
    {
        var parts = new List<string>();
        void Add(string? p)
        {
            if (string.IsNullOrWhiteSpace(p)) return;
            p = p.Trim();
            if (!parts.Contains(p, StringComparer.OrdinalIgnoreCase)) parts.Add(p);
        }

        foreach (var p in (o.Symbols ?? "").Split(';')) Add(p);

        // Where the PDBs were when the binaries were built, and next to the binaries themselves.
        foreach (var m in modules)
        {
            var mf = log.ModuleFiles[m];
            foreach (var candidate in new[] { mf.PdbName, mf.FilePath })
            {
                if (string.IsNullOrEmpty(candidate) || !Path.IsPathRooted(candidate)) continue;
                try
                {
                    string? d = Path.GetDirectoryName(candidate);
                    if (d != null && Directory.Exists(d) && !IsWindowsDir(d)) Add(d);
                }
                catch (ArgumentException) { }
            }
        }

        foreach (var p in (Environment.GetEnvironmentVariable("_NT_SYMBOL_PATH") ?? "").Split(';'))
            if (msSymbols || !p.Contains("://")) Add(p);

        string cache = o.SymbolCache ?? Path.Combine(Path.GetTempPath(), "SymbolCache"); // Visual Studio's default
        Add(msSymbols ? $"srv*{cache}*{MsSymbolServer}" : $"srv*{cache}");
        return string.Join(";", parts);
    }

    private static bool IsWindowsDir(string d)
    {
        string win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        return d.StartsWith(win, StringComparison.OrdinalIgnoreCase);
    }

    private static string Hash(string s)
    {
        var bytes = System.Security.Cryptography.SHA1.HashData(Encoding.UTF8.GetBytes(s));
        return Convert.ToHexString(bytes)[..16];
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private sealed record ProcessRow(int Pid, string Name, int Samples, string CommandLine);
}

/// Re-indexes the global TraceLog tables into a compact per-process profile: stacks form a prefix tree of code
/// addresses, addresses map to functions (and source lines), functions to modules.
internal sealed class ProfileBuilder
{
    private readonly TraceLog _log;
    private readonly Func<ModuleFileIndex, SymbolReader> _reader;
    private readonly bool _lines;

    private readonly Dictionary<CallStackIndex, int> _stackMap = new();
    private readonly List<int> _stackParent = new();
    private readonly List<int> _stackAddr = new();

    private readonly Dictionary<CodeAddressIndex, int> _addrMap = new();
    private readonly List<CodeAddressIndex> _addrs = new();

    private readonly Dictionary<string, int> _funcMap = new();
    private readonly List<(string name, int module)> _funcs = new();
    private readonly Dictionary<ModuleFileIndex, int> _moduleMap = new();
    private readonly List<ModuleFileIndex> _modules = new();

    private readonly List<double> _time = new();
    private readonly List<int> _thread = new();
    private readonly List<int> _stack = new();
    private readonly Dictionary<int, int> _threadMap = new();
    private readonly List<int> _tids = new();

    /// `reader` gives the symbol reader that loaded a module, which also resolves its source lines.
    public ProfileBuilder(TraceLog log, Func<ModuleFileIndex, SymbolReader> reader, bool lines)
    {
        _log = log;
        _reader = reader;
        _lines = lines;
    }

    public IEnumerable<CodeAddressIndex> UsedCodeAddresses() => _addrs;

    public void AddSample(double t, int tid, CallStackIndex cs)
    {
        if (!_threadMap.TryGetValue(tid, out int ti))
        {
            ti = _tids.Count;
            _tids.Add(tid);
            _threadMap[tid] = ti;
        }
        _time.Add(t);
        _thread.Add(ti);
        _stack.Add(MapStack(cs));
    }

    private int MapStack(CallStackIndex cs)
    {
        if (cs == CallStackIndex.Invalid) return -1;
        if (_stackMap.TryGetValue(cs, out int idx)) return idx;

        // Iterative: deep recursion in the traced program must not overflow our stack.
        var chain = new List<CallStackIndex>();
        for (var c = cs; c != CallStackIndex.Invalid && !_stackMap.ContainsKey(c); c = _log.CallStacks.Caller(c))
            chain.Add(c);
        for (int i = chain.Count - 1; i >= 0; i--)
        {
            var c = chain[i];
            var caller = _log.CallStacks.Caller(c);
            int parent = caller == CallStackIndex.Invalid ? -1 : _stackMap[caller];
            int addr = MapAddr(_log.CallStacks.CodeAddressIndex(c));
            _stackMap[c] = _stackParent.Count;
            _stackParent.Add(parent);
            _stackAddr.Add(addr);
        }
        return _stackMap[cs];
    }

    private int MapAddr(CodeAddressIndex ca)
    {
        if (_addrMap.TryGetValue(ca, out int idx)) return idx;
        idx = _addrs.Count;
        _addrs.Add(ca);
        _addrMap[ca] = idx;
        return idx;
    }

    private int MapModule(ModuleFileIndex mf)
    {
        if (_moduleMap.TryGetValue(mf, out int idx)) return idx;
        idx = _modules.Count;
        _modules.Add(mf);
        _moduleMap[mf] = idx;
        return idx;
    }

    private int MapFunc(CodeAddressIndex ca)
    {
        var mf = _log.CodeAddresses.ModuleFileIndex(ca);
        int module = mf == ModuleFileIndex.Invalid ? -1 : MapModule(mf);
        string name = FuncName(ca, module >= 0);
        string key = module + "|" + name;
        if (_funcMap.TryGetValue(key, out int idx)) return idx;
        idx = _funcs.Count;
        _funcs.Add((name, module));
        _funcMap[key] = idx;
        return idx;
    }

    private string FuncName(CodeAddressIndex ca, bool hasModule)
    {
        var mi = _log.CodeAddresses.MethodIndex(ca);
        string name = mi != MethodIndex.Invalid ? _log.CodeAddresses.Methods.FullMethodName(mi) : "";
        if (!string.IsNullOrEmpty(name)) return name;
        // No symbol: like PerfView, group the module's unnamed addresses into one frame so they aggregate.
        return hasModule ? "?" : $"0x{_log.CodeAddresses.Address(ca):x}";
    }

    /// Source file and line of an address, or null. A module whose PDB throws is skipped from then on.
    private (string file, int line)? SourceLine(CodeAddressIndex ca, HashSet<ModuleFileIndex> brokenModules)
    {
        if (!_lines || _log.CodeAddresses.MethodIndex(ca) == MethodIndex.Invalid) return null;
        var mf = _log.CodeAddresses.ModuleFileIndex(ca);
        if (brokenModules.Contains(mf)) return null;
        try
        {
            var loc = _log.CodeAddresses.GetSourceLine(_reader(mf), ca);
            string path = loc?.SourceFile?.BuildTimeFilePath ?? "";
            return path.Length == 0 ? null : (path, loc!.LineNumber);
        }
        catch (Exception)
        {
            brokenModules.Add(mf);
            return null;
        }
    }

    /// The names and source lines of the addresses of some modules, to update a profile built from the same samples.
    public void WritePatch(Utf8JsonWriter w, HashSet<ModuleFileIndex> modules)
    {
        var addrs = new List<int>();
        var names = new List<string>();
        var addrFile = new List<int>();
        var addrLine = new List<int>();
        var fileMap = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var files = new List<string>();
        var brokenModules = new HashSet<ModuleFileIndex>();
        var resolved = new HashSet<ModuleFileIndex>();
        for (int i = 0; i < _addrs.Count; i++)
        {
            var ca = _addrs[i];
            var mf = _log.CodeAddresses.ModuleFileIndex(ca);
            if (!modules.Contains(mf)) continue;
            if (_log.CodeAddresses.MethodIndex(ca) != MethodIndex.Invalid) resolved.Add(mf);
            addrs.Add(i);
            names.Add(FuncName(ca, true));
            if (SourceLine(ca, brokenModules) is { } src)
            {
                if (!fileMap.TryGetValue(src.file, out int fi))
                {
                    fi = files.Count;
                    files.Add(src.file);
                    fileMap[src.file] = fi;
                }
                addrFile.Add(fi);
                addrLine.Add(src.line);
            }
            else
            {
                addrFile.Add(-1);
                addrLine.Add(0);
            }
        }

        w.WriteNumber("addrCount", _addrs.Count);
        w.WriteStartArray("modules");
        foreach (var mf in modules)
        {
            w.WriteStartObject();
            w.WriteString("path", _log.ModuleFiles[mf].FilePath ?? "");
            w.WriteBoolean("symbols", resolved.Contains(mf));
            w.WriteEndObject();
        }
        w.WriteEndArray();
        WriteInts(w, "addrs", addrs);
        WriteStrings(w, "names", names);
        WriteStrings(w, "files", files);
        WriteInts(w, "addrFile", addrFile);
        WriteInts(w, "addrLine", addrLine);
    }

    public void Write(Utf8JsonWriter w, HashSet<ModuleFileIndex> symbolsLoaded, HashSet<ModuleFileIndex> localSymbols)
    {
        // Addresses -> functions and source lines.
        var addrFunc = new int[_addrs.Count];
        var addrLine = new int[_addrs.Count];
        var addrFile = new int[_addrs.Count];
        var fileMap = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var files = new List<string>();
        var brokenModules = new HashSet<ModuleFileIndex>();
        for (int i = 0; i < _addrs.Count; i++)
        {
            var ca = _addrs[i];
            addrFunc[i] = MapFunc(ca);
            addrFile[i] = -1;
            if (SourceLine(ca, brokenModules) is not { } src) continue;
            if (!fileMap.TryGetValue(src.file, out int fi))
            {
                fi = files.Count;
                files.Add(src.file);
                fileMap[src.file] = fi;
            }
            addrFile[i] = fi;
            addrLine[i] = src.line;
        }

        w.WriteStartArray("modules");
        foreach (var mf in _modules)
        {
            var m = _log.ModuleFiles[mf];
            w.WriteStartObject();
            w.WriteString("name", ModuleDisplayName(m));
            w.WriteString("path", m.FilePath ?? "");
            w.WriteBoolean("symbols", symbolsLoaded.Contains(mf));
            w.WriteBoolean("local", localSymbols.Contains(mf));
            w.WriteBoolean("system", IsSystemModule(m.FilePath ?? ""));
            w.WriteEndObject();
        }
        w.WriteEndArray();

        WriteStrings(w, "funcNames", _funcs.Select(f => f.name));
        WriteInts(w, "funcModule", _funcs.Select(f => f.module));
        WriteStrings(w, "files", files);
        WriteInts(w, "addrFunc", addrFunc);
        WriteInts(w, "addrFile", addrFile);
        WriteInts(w, "addrLine", addrLine);
        WriteInts(w, "stackParent", _stackParent);
        WriteInts(w, "stackAddr", _stackAddr);

        w.WriteStartArray("threads");
        foreach (int tid in _tids)
        {
            var th = _log.Threads.Where(t => t.ThreadID == tid).OrderByDescending(t => t.EndTimeRelativeMSec).FirstOrDefault();
            w.WriteStartObject();
            w.WriteNumber("tid", tid);
            w.WriteString("name", th?.ThreadInfo ?? "");
            w.WriteNumber("startMs", th?.StartTimeRelativeMSec ?? 0);
            w.WriteNumber("endMs", th?.EndTimeRelativeMSec ?? 0);
            w.WriteEndObject();
        }
        w.WriteEndArray();

        w.WriteStartArray("sampleTime");
        foreach (double t in _time) w.WriteNumberValue(Math.Round(t, 3));
        w.WriteEndArray();
        WriteInts(w, "sampleThread", _thread);
        WriteInts(w, "sampleStack", _stack);
    }

    private static string ModuleDisplayName(TraceModuleFile m)
    {
        // The trace records lower-cased paths; show the file name with its on-disk casing, as Visual Studio does.
        string path = m.FilePath ?? "";
        string file = path.Length > 0 ? Path.GetFileName(path) : "";
        if (file.Length == 0) return m.Name ?? "?";
        return ActualPath(path) is { } actual ? Path.GetFileName(actual) : file;
    }

    public static string? ActualPath(string path)
    {
        try
        {
            string? dir = Path.GetDirectoryName(path);
            if (dir == null || !File.Exists(path)) return null;
            var found = new DirectoryInfo(dir).GetFiles(Path.GetFileName(path));
            return found.Length > 0 ? Path.Combine(dir, found[0].Name) : null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    public static bool IsSystemModule(string path)
    {
        if (path.Length == 0) return true;
        string win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        return path.StartsWith(win, StringComparison.OrdinalIgnoreCase)
               || path.StartsWith(@"\SystemRoot\", StringComparison.OrdinalIgnoreCase)
               || path.EndsWith(".sys", StringComparison.OrdinalIgnoreCase);
    }

    private static void WriteInts(Utf8JsonWriter w, string name, IEnumerable<int> values)
    {
        w.WriteStartArray(name);
        foreach (int v in values) w.WriteNumberValue(v);
        w.WriteEndArray();
    }

    private static void WriteStrings(Utf8JsonWriter w, string name, IEnumerable<string> values)
    {
        w.WriteStartArray(name);
        foreach (string v in values) w.WriteStringValue(v);
        w.WriteEndArray();
    }
}

internal sealed class UsageException(string message) : Exception(message);

internal sealed class Options
{
    public string Input = "";
    public string Out = "";
    public int? Pid;
    public string CacheDir = Path.Combine(Path.GetTempPath(), "DiagSessionAnalyzer");
    public string? Symbols;
    public string? SymbolCache;
    public bool MsSymbols;
    public bool LocalSymbols;
    public bool Patch;
    public HashSet<string> LoadSymbols = new(StringComparer.OrdinalIgnoreCase);
    public bool NoLines;
    public bool Verbose;

    public static Options Parse(string[] args)
    {
        var o = new Options();
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            string Next() => i + 1 < args.Length ? args[++i] : throw new UsageException($"{a} needs a value");
            switch (a)
            {
                case "--out": o.Out = Next(); break;
                case "--pid": o.Pid = int.Parse(Next()); break;
                case "--cache-dir": o.CacheDir = Next(); break;
                case "--symbols": o.Symbols = Next(); break;
                case "--symbol-cache": o.SymbolCache = Next(); break;
                case "--ms-symbols": o.MsSymbols = true; break;
                case "--local-symbols": o.LocalSymbols = true; break;
                case "--patch": o.Patch = true; break;
                case "--load-symbols":
                    foreach (var p in Next().Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                        o.LoadSymbols.Add(p);
                    break;
                case "--no-lines": o.NoLines = true; break;
                case "--verbose": o.Verbose = true; break;
                default:
                    if (a.StartsWith("--")) throw new UsageException($"unknown option {a}");
                    o.Input = a;
                    break;
            }
        }
        if (o.Input.Length == 0) throw new UsageException("no input file");
        if (o.Out.Length == 0) throw new UsageException("--out is required");
        if (o.Patch && (o.LoadSymbols.Count == 0 || o.Pid == null)) throw new UsageException("--patch needs --load-symbols and --pid");
        return o;
    }
}
