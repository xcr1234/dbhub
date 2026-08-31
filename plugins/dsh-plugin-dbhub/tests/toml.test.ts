/**
 * Unit tests for the shared TOML / config conversion primitives.
 *
 * These functions are the durable contract between the panel and
 * dbhub's on-disk config; bugs here would surface as "settings save
 * did not take effect", which is the worst kind of bug to chase.
 * Each test round-trips a realistic config and asserts the exact
 * TOML shape dbhub's loader expects.
 *
 * @module @xcr1234/dsh-plugin-dbhub/tests
 */

import assert from 'node:assert/strict'
import toml from '@iarna/toml'
import { assertValidDsn, configToToml, parsePreservedFields, tomlToConfig, type PreservedFields } from '../src/shared/toml.ts'
import { dbhubConfigZodSchema, type DbhubConfig, inferDbType } from '../src/shared/types.ts'

const expect = assert
const failures: { suite: string; test: string; error: unknown }[] = []
let currentSuite = '(root)'
let testCount = 0

function describe(name: string, body: () => void | Promise<void>): Promise<void> {
  const previous = currentSuite
  currentSuite = name
  return Promise.resolve(body()).finally(() => {
    currentSuite = previous
  })
}

function t(name: string, body: () => void | Promise<void>): Promise<void> {
  testCount += 1
  return Promise.resolve(body()).catch((err: unknown) => {
    failures.push({ suite: currentSuite, test: name, error: err })
  })
}

describe('inferDbType', () => {
  t('returns the canonical type for every supported DSN prefix', () => {
    expect.equal(inferDbType('postgres://u:p@h/db'), 'postgres')
    expect.equal(inferDbType('postgresql://u:p@h/db'), 'postgres')
    expect.equal(inferDbType('mysql://u:p@h/db'), 'mysql')
    expect.equal(inferDbType('mariadb://u:p@h/db'), 'mariadb')
    expect.equal(inferDbType('sqlserver://u:p@h/db'), 'sqlserver')
    expect.equal(inferDbType('mssql://u:p@h/db'), 'sqlserver')
    expect.equal(inferDbType('sqlite:///abs/path.db'), 'sqlite')
    expect.equal(inferDbType('sqlite:///:memory:'), 'sqlite')
    expect.equal(inferDbType('oracle://u:p@h/sid'), 'oracle')
  })
  t('returns null for unknown / malformed DSNs', () => {
    expect.equal(inferDbType('not a dsn'), null)
    expect.equal(inferDbType('redis://h'), null)
    expect.equal(inferDbType('://broken'), null)
  })
})

describe('assertValidDsn', () => {
  t('returns the type for valid DSNs', () => {
    expect.equal(assertValidDsn('postgres://u@h/db', 'main'), 'postgres')
    expect.equal(assertValidDsn('mysql://u@h/db', 'main'), 'mysql')
  })
  t('throws with a helpful message for invalid DSNs', () => {
    expect.throws(() => assertValidDsn('redis://h', 'main'), /main/)
  })
})

describe('configToToml', () => {
  t('emits the exact [[sources]] shape dbhub loads', () => {
    const config: DbhubConfig = {
      port: 8080,
      enabled: true,
      sources: [
        { id: 'main', dsn: 'postgres://u:p@h/db' },
        { id: 'anal', dsn: 'mysql://u:p@h/db' },
      ],
    }
    const out = configToToml(config)
    // dbhub's loader reads sources as an array of tables; verify the
    // shape with @iarna/toml itself so we exercise the same parser
    // dbhub uses.
    const parsed = toml.parse(out) as { sources: Array<Record<string, string>> }
    expect.deepEqual(parsed.sources, [
      { id: 'main', dsn: 'postgres://u:p@h/db' },
      { id: 'anal', dsn: 'mysql://u:p@h/db' },
    ])
  })
  t('emits an empty sources array when no sources exist', () => {
    const out = configToToml({ port: 8080, enabled: true, sources: [] })
    const parsed = toml.parse(out) as { sources: unknown }
    expect.deepEqual(parsed.sources, [])
  })
})

describe('tomlToConfig round-trip', () => {
  t('preserves every source through a configToToml → tomlToConfig round trip', () => {
    const config: DbhubConfig = {
      port: 9090,
      enabled: true,
      sources: [
        { id: 'a', dsn: 'postgres://u:p@h:5432/a' },
        { id: 'b', dsn: 'sqlite:///tmp/b.db' },
        { id: 'c', dsn: 'mysql://root:secret@127.0.0.1/c' },
      ],
    }
    const text = configToToml(config)
    const back = tomlToConfig(text, { ...config, sources: [] })
    expect.deepEqual(back.sources, config.sources)
  })
  t('drops unknown TOML keys on each source (round-trip is lossy on purpose)', () => {
    const text = [
      '[[sources]]',
      'id = "main"',
      'dsn = "postgres://u:p@h/db"',
      'ssh_host = "bastion.example"',
      'ssh_user = "ops"',
    ].join('\n')
    const back = tomlToConfig(text, { port: 8080, enabled: true, sources: [] })
    expect.deepEqual(back.sources, [{ id: 'main', dsn: 'postgres://u:p@h/db' }])
  })
  t('skips sources missing id or dsn', () => {
    const text = [
      '[[sources]]',
      'id = "ok"',
      'dsn = "postgres://u:h/db"',
      '',
      '[[sources]]',
      'dsn = "postgres://u@h/other"',
      '',
      '[[sources]]',
      'id = "no-dsn"',
    ].join('\n')
    const back = tomlToConfig(text, { port: 8080, enabled: true, sources: [] })
    expect.deepEqual(back.sources.map((s) => s.id), ['ok'])
  })
  t('throws a clear message on malformed TOML', () => {
    expect.throws(
      () => tomlToConfig('[[sources]\nid = "x"', { port: 8080, enabled: true, sources: [] }),
      /not valid TOML/,
    )
  })
})

describe('dbhubConfigZodSchema (wire shape)', () => {
  t('accepts a minimal valid config', () => {
    const parsed = dbhubConfigZodSchema.parse({
      port: 8080,
      enabled: true,
      sources: [],
    })
    expect.equal(parsed.port, 8080)
    expect.equal(parsed.enabled, true)
    expect.deepEqual(parsed.sources, [])
  })
  t('rejects an invalid source id', () => {
    const result = dbhubConfigZodSchema.safeParse({
      port: 8080,
      enabled: true,
      sources: [{ id: 'has spaces', dsn: 'postgres://u@h/db' }],
    })
    expect.equal(result.success, false)
  })
  t('rejects an out-of-range port', () => {
    const result = dbhubConfigZodSchema.safeParse({ port: 70000, enabled: true, sources: [] })
    expect.equal(result.success, false)
  })
})

describe('parsePreservedFields', () => {
  t('returns an empty object for invalid TOML', () => {
    expect.deepEqual(parsePreservedFields('not valid [[['), {})
  })
  t('returns an empty object when there are no sources', () => {
    expect.deepEqual(parsePreservedFields('# comment\nport = 8080\n'), {})
  })
  t('returns an empty object for empty input', () => {
    expect.deepEqual(parsePreservedFields(''), {})
  })
  t('skips sources with no id (no key to merge with)', () => {
    const text = '[[sources]]\ndsn = "postgres://u@h/db"\n'
    expect.deepEqual(parsePreservedFields(text), {})
  })
  t('extracts unknown fields keyed by source id', () => {
    const text = [
      '[[sources]]',
      'id = "main"',
      'dsn = "postgres://u:p@h/db"',
      'ssh_host = "bastion.example"',
      'ssh_user = "ops"',
      '',
      '[[sources]]',
      'id = "other"',
      'dsn = "mysql://u:p@h/db"',
      'sslmode = "verify-full"',
    ].join('\n')
    expect.deepEqual(parsePreservedFields(text), {
      main: { ssh_host: 'bastion.example', ssh_user: 'ops' },
      other: { sslmode: 'verify-full' },
    })
  })
  t('skips sources whose only fields are id and dsn', () => {
    const text = '[[sources]]\nid = "main"\ndsn = "postgres://u@h/db"\n'
    expect.deepEqual(parsePreservedFields(text), {})
  })
  t('handles nested TOML tables (e.g. [sources.ssh])', () => {
    const text = [
      '[[sources]]',
      'id = "main"',
      'dsn = "postgres://u:p@h/db"',
      '',
      '[sources.ssh]',
      'host = "bastion.example"',
      'port = 22',
    ].join('\n')
    expect.deepEqual(parsePreservedFields(text), {
      main: { ssh: { host: 'bastion.example', port: 22 } },
    })
  })
})

describe('configToToml with preserved fields', () => {
  t('still emits a clean TOML when no preserved fields are passed', () => {
    const config: DbhubConfig = {
      port: 18080,
      enabled: true,
      sources: [{ id: 'main', dsn: 'postgres://u:p@h/db' }],
    }
    const text = configToToml(config)
    const back = toml.parse(text) as { sources: Array<Record<string, unknown>> }
    expect.deepEqual(back.sources, [{ id: 'main', dsn: 'postgres://u:p@h/db' }])
  })
  t('keeps SSH / SSL fields across a panel save', () => {
    const config: DbhubConfig = {
      port: 18080,
      enabled: true,
      sources: [{ id: 'main', dsn: 'postgres://u:p@h/db' }],
    }
    const preserved: PreservedFields = {
      main: { ssh_host: 'bastion.example', ssh_port: 22, ssh_user: 'ops' },
    }
    const text = configToToml(config, preserved)
    const back = toml.parse(text) as { sources: Array<Record<string, unknown>> }
    expect.deepEqual(back.sources, [
      {
        id: 'main',
        dsn: 'postgres://u:p@h/db',
        ssh_host: 'bastion.example',
        ssh_port: 22,
        ssh_user: 'ops',
      },
    ])
  })
  t('drops preserved fields whose source id was removed', () => {
    const config: DbhubConfig = {
      port: 18080,
      enabled: true,
      sources: [], // user removed everything
    }
    const preserved: PreservedFields = { main: { ssh_host: 'bastion' } }
    const text = configToToml(config, preserved)
    const back = toml.parse(text) as { sources: Array<Record<string, unknown>> }
    expect.deepEqual(back.sources, [])
  })
  t('drops preserved fields for ids that no longer exist (rename scenario)', () => {
    // User renamed `main` to `primary` in the panel. The old id's
    // preserved fields are NOT migrated — that's a deliberate choice:
    // automatic migration could be wrong (collisions, multiple
    // candidates), and a re-add is cheap.
    const config: DbhubConfig = {
      port: 18080,
      enabled: true,
      sources: [{ id: 'primary', dsn: 'postgres://u:p@h/db' }],
    }
    const preserved: PreservedFields = { main: { ssh_host: 'bastion' } }
    const text = configToToml(config, preserved)
    const back = toml.parse(text) as { sources: Array<Record<string, unknown>> }
    expect.equal(back.sources.length, 1)
    expect.equal(back.sources[0]?.id, 'primary')
    expect.equal((back.sources[0] as Record<string, unknown>).ssh_host, undefined)
  })
  t('panel-written fields always win on conflict with preserved fields', () => {
    const config: DbhubConfig = {
      port: 18080,
      enabled: true,
      sources: [{ id: 'main', dsn: 'postgres://u:p@new/db' }],
    }
    const preserved: PreservedFields = { main: { dsn: 'postgres://u:p@old/db', ssh_host: 'bastion' } }
    const text = configToToml(config, preserved)
    const back = toml.parse(text) as { sources: Array<Record<string, unknown>> }
    // Panel's dsn replaces the old one in the preserved bag (the
    // panel owns id+dsn); the non-conflicting ssh_host is kept.
    expect.equal(back.sources[0]?.dsn, 'postgres://u:p@new/db')
    expect.equal(back.sources[0]?.ssh_host, 'bastion')
  })
  t('preserves nested TOML tables intact', () => {
    const config: DbhubConfig = {
      port: 18080,
      enabled: true,
      sources: [{ id: 'main', dsn: 'postgres://u:p@h/db' }],
    }
    const preserved: PreservedFields = {
      main: { ssh: { host: 'bastion.example', port: 22 } },
    }
    const text = configToToml(config, preserved)
    const back = toml.parse(text) as { sources: Array<Record<string, unknown>> }
    expect.deepEqual(back.sources[0]?.ssh, { host: 'bastion.example', port: 22 })
  })
})

describe('parsePreservedFields → configToToml round-trip', () => {
  t('a hand-edited TOML survives a panel save unchanged on non-panel fields', () => {
    // This is the realistic bug: user hand-adds ssh_* fields, then
    // opens the panel, tweaks the DSN, and saves. The ssh_* fields
    // must still be there.
    const onDisk = [
      '[[sources]]',
      'id = "main"',
      'dsn = "postgres://u:p@old/db"',
      'ssh_host = "bastion.example"',
      'ssh_user = "ops"',
      'sslmode = "require"',
    ].join('\n')
    const preserved = parsePreservedFields(onDisk)
    const newConfig: DbhubConfig = {
      port: 18080,
      enabled: true,
      sources: [{ id: 'main', dsn: 'postgres://u:p@new/db' }],
    }
    const written = configToToml(newConfig, preserved)
    const back = toml.parse(written) as { sources: Array<Record<string, unknown>> }
    expect.deepEqual(back.sources, [
      {
        id: 'main',
        dsn: 'postgres://u:p@new/db',
        ssh_host: 'bastion.example',
        ssh_user: 'ops',
        sslmode: 'require',
      },
    ])
  })
})

// Run on import so the harness can collect results across all files.
await new Promise((resolve) => setImmediate(resolve))
await new Promise((resolve) => setImmediate(resolve))
console.log(`\n${testCount} tests collected in toml.test.ts, ${failures.length} failed`)
for (const f of failures) {
  console.error(`  ✗ ${f.suite} > ${f.test}`)
  console.error(`    ${f.error instanceof Error ? f.error.message : String(f.error)}`)
}
if (failures.length > 0) process.exit(1)
