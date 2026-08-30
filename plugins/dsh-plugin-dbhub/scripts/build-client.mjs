#!/usr/bin/env node
// Build the browser half into the shape dsh-web's client-modules
// expects: `window.__ModuleLoader__.load({ id, factory: (require)
// => module.exports })`. The factory body is the CJS bundle esbuild
// produces, which already collects the module's named exports onto
// `module.exports`. We wrap the whole thing in a factory that
// exposes the same `module` / `exports` / `require` shims to the
// bundle so it can run in lockstep with the page-level module
// table that dsh-web already provides.

import { build } from 'esbuild'
import { readFile, writeFile, unlink } from 'node:fs/promises'

await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  target: 'es2020',
  platform: 'browser',
  jsx: 'transform',
  minify: false,
  sourcemap: true,
  // Host-provided modules stay external; esbuild emits
  // `require("react")` calls, which the factory's `require`
  // argument (the page-level module table) resolves. Everything
  // else (zod, @iarna/toml, etc.) is bundled into the client so
  // the browser-side factory never reaches for a module the host
  // does not pre-seed.
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  outfile: 'client/client.tmp.cjs',
  logLevel: 'info',
})

const cjsSource = await readFile('client/client.tmp.cjs', 'utf8')

const wrapped = [
  '/* eslint-disable */',
  'window.__ModuleLoader__.load({',
  '  id: "@xcr1234/dsh-plugin-dbhub",',
  '  factory: function (require) {',
  // Run the CJS body inside a scope where `require`, `module`,
  // and `exports` resolve to the factory's locals. The CJS output
  // esbuild produces is plain JavaScript that reads from those
  // identifiers directly; no other shims are required.
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  '    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  cjsSource,
  '    return module.exports;',
  '  }',
  '});',
  '',
].join('\n')

await writeFile('client/client.js', wrapped, 'utf8')
await unlink('client/client.tmp.cjs')
await unlink('client/client.tmp.cjs.map').catch(() => {})
console.log('wrote client/client.js')
