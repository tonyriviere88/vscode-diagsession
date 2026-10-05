import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const builds = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    target: 'node18',
    // jsonc-parser's UMD "main" hides its requires from esbuild
    mainFields: ['module', 'main'],
  },
  {
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  },
  {
    entryPoints: ['webview/profiler.ts'],
    outfile: 'dist/profiler.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  },
];

for (const b of builds) {
  const options = { bundle: true, sourcemap: true, minify: !watch, logLevel: 'info', ...b };
  if (watch) {
    await (await esbuild.context(options)).watch();
  } else {
    await esbuild.build(options);
  }
}
