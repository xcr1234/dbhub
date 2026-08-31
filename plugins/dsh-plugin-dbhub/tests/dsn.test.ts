/**
 * Unit tests for the structured DSN parse/compose helpers.
 *
 * The helpers in `src/shared/dsn.ts` are the durable contract between
 * the panel form and the wire DSN string dbhub consumes. Encoding
 * bugs here would silently corrupt passwords, so each test round-trips
 * a representative input and asserts byte-for-byte identity on the way
 * back out.
 *
 * @module @xcr1234/dsh-plugin-dbhub/tests
 */

import assert from 'node:assert/strict'
import {
  composeDsn,
  DB_TYPE_LABELS,
  DB_TYPE_ORDER,
  DEFAULT_PORTS,
  emptyFields,
  parseDsn,
  type DbType,
  type DsnFields,
} from '../src/shared/dsn.ts'

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

function roundTrip(dsn: string): void {
  const parsed = parseDsn(dsn)
  expect.notEqual(parsed, null, `parseDsn returned null for ${dsn}`)
  if (parsed === null) return
  const composed = composeDsn(parsed)
  expect.equal(composed, dsn, `round-trip mismatch:\n  in:  ${dsn}\n  out: ${composed}`)
}

describe('DB_TYPE_ORDER / DEFAULT_PORTS / DB_TYPE_LABELS', () => {
  t('covers every supported type and gives each its canonical port', () => {
    const expectedPorts: Record<DbType, number | null> = {
      postgres: 5432,
      mysql: 3306,
      mariadb: 3306,
      sqlserver: 1433,
      oracle: 1521,
      sqlite: null as never,
    }
    for (const t of DB_TYPE_ORDER) {
      expect.ok(DB_TYPE_LABELS[t].length > 0, `${t} has a label`)
      if (t === 'sqlite') continue
      expect.equal(DEFAULT_PORTS[t], expectedPorts[t])
    }
    expect.equal((DEFAULT_PORTS as Record<string, number | undefined>).sqlite, undefined)
  })
})

describe('parseDsn — SQLite', () => {
  t('recognises in-memory database', () => {
    expect.deepEqual(parseDsn('sqlite:///:memory:'), {
      type: 'sqlite',
      sqlite: { filePath: '', memory: true },
    })
  })
  t('preserves absolute Unix paths with leading /', () => {
    expect.deepEqual(parseDsn('sqlite:///var/lib/data/mydb.db'), {
      type: 'sqlite',
      sqlite: { filePath: '/var/lib/data/mydb.db', memory: false },
    })
  })
  t('strips URL-convention slash from Windows drive-letter paths', () => {
    expect.deepEqual(parseDsn('sqlite:///C:/Users/me/data/app.db'), {
      type: 'sqlite',
      sqlite: { filePath: 'C:/Users/me/data/app.db', memory: false },
    })
  })
  t('preserves relative file paths with their leading ./', () => {
    expect.deepEqual(parseDsn('sqlite://./local.db'), {
      type: 'sqlite',
      sqlite: { filePath: './local.db', memory: false },
    })
  })
  t('keeps spaces in paths verbatim (no encoding)', () => {
    // 4-slash form (not in the docs but preserved verbatim) — the
    // URL-convention slash strip only kicks in for Windows drive
    // letters, so `//Users/...` stays `//Users/...`. Compose
    // re-prepends `sqlite://` and round-trips byte-for-byte.
    const dsn = 'sqlite:////Users/me/My Data/app.db'
    const parsed = parseDsn(dsn)
    expect.equal(parsed?.sqlite?.filePath, '/Users/me/My Data/app.db'.replace(/^\//, '//'))
    expect.equal(composeDsn(parsed!), dsn)
  })
  t('round-trips the canonical Unix absolute path', () => {
    roundTrip('sqlite:///var/lib/data/mydb.db')
  })
  t('round-trips the canonical Windows drive-letter path', () => {
    roundTrip('sqlite:///C:/Users/me/data/app.db')
  })
})

describe('parseDsn — network DSNs', () => {
  t('splits a typical postgres DSN', () => {
    expect.deepEqual(parseDsn('postgres://user:pass@localhost:5432/dbname'), {
      type: 'postgres',
      network: {
        host: 'localhost',
        port: '5432',
        user: 'user',
        password: 'pass',
        database: 'dbname',
        params: '',
      },
    })
  })
  t('accepts missing port', () => {
    const parsed = parseDsn('mysql://root@127.0.0.1/mydb')
    expect.deepEqual(parsed, {
      type: 'mysql',
      network: { host: '127.0.0.1', port: '', user: 'root', password: '', database: 'mydb', params: '' },
    })
  })
  t('accepts missing password (just user@)', () => {
    const parsed = parseDsn('mysql://root@127.0.0.1:3306/mydb')
    expect.deepEqual(parsed?.network?.user, 'root')
    expect.deepEqual(parsed?.network?.password, '')
  })
  t('accepts missing database', () => {
    const parsed = parseDsn('mysql://root:secret@127.0.0.1:3306')
    expect.equal(parsed?.network?.database, '')
    expect.equal(parsed?.network?.host, '127.0.0.1')
    expect.equal(parsed?.network?.port, '3306')
  })
  t('peels off query parameters into params', () => {
    const parsed = parseDsn('postgres://u:p@host/db?sslmode=require')
    expect.equal(parsed?.network?.params, 'sslmode=require')
    expect.equal(parsed?.network?.database, 'db')
  })
  t('handles IPv6 literals', () => {
    const parsed = parseDsn('postgres://u:p@[::1]:5432/db')
    expect.equal(parsed?.network?.host, '[::1]')
    expect.equal(parsed?.network?.port, '5432')
    expect.equal(parsed?.network?.database, 'db')
  })
})

describe('parseDsn — password special characters', () => {
  t('decodes percent-escaped characters', () => {
    const dsn = `mysql://u:${encodeURIComponent('p@ss/word')}@host/db`
    const parsed = parseDsn(dsn)
    expect.equal(parsed?.network?.password, 'p@ss/word')
    roundTrip(dsn)
  })
  t('preserves AWS-style token passwords with / and +', () => {
    const token = 'Avery+long/token=with/slashes'
    const dsn = `mysql://myuser:${encodeURIComponent(token)}@mydb.example/mydb`
    const parsed = parseDsn(dsn)
    expect.equal(parsed?.network?.password, token)
    roundTrip(dsn)
  })
  t('preserves passwords containing : and @ (encoded)', () => {
    const password = 'a:b@c'
    const dsn = `postgres://u:${encodeURIComponent(password)}@host/db`
    const parsed = parseDsn(dsn)
    expect.equal(parsed?.network?.password, password)
    roundTrip(dsn)
  })
  t('preserves passwords with #, &, =', () => {
    const password = 'p#a&b=c'
    const dsn = `postgres://u:${encodeURIComponent(password)}@host/db`
    const parsed = parseDsn(dsn)
    expect.equal(parsed?.network?.password, password)
    roundTrip(dsn)
  })
  t('preserves passwords with spaces', () => {
    const password = 'has spaces'
    const dsn = `postgres://u:${encodeURIComponent(password)}@host/db`
    const parsed = parseDsn(dsn)
    expect.equal(parsed?.network?.password, password)
    roundTrip(dsn)
  })
  t('preserves database names with special characters', () => {
    const database = 'db/with-slash'
    const dsn = `postgres://u:p@host/${encodeURIComponent(database)}`
    const parsed = parseDsn(dsn)
    expect.equal(parsed?.network?.database, database)
    roundTrip(dsn)
  })
})

describe('composeDsn', () => {
  t('encodes user/password when present', () => {
    const fields: DsnFields = {
      type: 'postgres',
      network: { host: 'h', port: '5432', user: 'u', password: 'p@s:s', database: 'd', params: '' },
    }
    expect.equal(composeDsn(fields), 'postgres://u:p%40s%3As@h:5432/d')
  })
  t('omits auth section when user is empty', () => {
    const fields: DsnFields = {
      type: 'postgres',
      network: { host: 'h', port: '5432', user: '', password: '', database: 'd', params: '' },
    }
    expect.equal(composeDsn(fields), 'postgres://h:5432/d')
  })
  t('omits port when empty', () => {
    const fields: DsnFields = {
      type: 'mysql',
      network: { host: 'h', port: '', user: 'u', password: 'p', database: '', params: '' },
    }
    expect.equal(composeDsn(fields), 'mysql://u:p@h')
  })
  t('encodes params keys and values', () => {
    const fields: DsnFields = {
      type: 'postgres',
      network: { host: 'h', port: '5432', user: 'u', password: 'p', database: 'd', params: 'sslmode=require&sslrootcert=/tmp/c a.pem' },
    }
    expect.equal(
      composeDsn(fields),
      'postgres://u:p@h:5432/d?sslmode=require&sslrootcert=%2Ftmp%2Fc%20a.pem',
    )
  })
  t('omits trailing ? when params is empty/whitespace', () => {
    const fields: DsnFields = {
      type: 'postgres',
      network: { host: 'h', port: '5432', user: 'u', password: 'p', database: 'd', params: '   ' },
    }
    expect.equal(composeDsn(fields), 'postgres://u:p@h:5432/d')
  })
  t('composes SQLite in-memory', () => {
    expect.equal(composeDsn({ type: 'sqlite', sqlite: { filePath: '', memory: true } }), 'sqlite:///:memory:')
  })
  t('composes SQLite file path', () => {
    expect.equal(
      composeDsn({ type: 'sqlite', sqlite: { filePath: '/var/lib/data/mydb.db', memory: false } }),
      'sqlite:///var/lib/data/mydb.db',
    )
    expect.equal(
      composeDsn({ type: 'sqlite', sqlite: { filePath: 'C:/data/app.db', memory: false } }),
      'sqlite:///C:/data/app.db',
    )
  })
})

describe('round-trip — every supported db type', () => {
  for (const type of DB_TYPE_ORDER) {
    const label = type
    t(`${label}: parse → compose is identity`, () => {
      if (type === 'sqlite') {
        roundTrip('sqlite:///:memory:')
        roundTrip('sqlite:///var/lib/app.db')
      } else {
        const port = DEFAULT_PORTS[type]
        const dsn = `${type}://user:pass@db.example:${String(port)}/${type}_db?sslmode=require`
        roundTrip(dsn)
      }
    })
  }
})

describe('round-trip — passwords with nasty characters', () => {
  const passwords = [
    'simple',
    'with space',
    'with@symbol',
    'with:colon',
    'with/slash',
    'with#hash',
    'with&amp',
    'with=equals',
    'with+plus',
    'with%percent',
    'a:b@c#d=e&f g+h%i',
    // Realistic AWS-style RDS IAM token shape
    'XCR1.dHj+Aa/bb-Cc/Dd==.Ee+Ff/Gg-Hh',
    // Unicode
    '密码',
  ]
  for (const pwd of passwords) {
    t(`password: ${JSON.stringify(pwd)}`, () => {
      const dsn = `postgres://u:${encodeURIComponent(pwd)}@host:5432/db`
      roundTrip(dsn)
    })
  }
})

describe('emptyFields', () => {
  t('returns SQLite defaults when type is sqlite', () => {
    expect.deepEqual(emptyFields('sqlite'), { type: 'sqlite', sqlite: { filePath: '', memory: false } })
  })
  t('pre-fills the canonical port for network types', () => {
    expect.deepEqual(emptyFields('postgres'), {
      type: 'postgres',
      network: { host: '', port: '5432', user: '', password: '', database: '', params: '' },
    })
    expect.deepEqual(emptyFields('mysql'), {
      type: 'mysql',
      network: { host: '', port: '3306', user: '', password: '', database: '', params: '' },
    })
    expect.deepEqual(emptyFields('sqlserver'), {
      type: 'sqlserver',
      network: { host: '', port: '1433', user: '', password: '', database: '', params: '' },
    })
    expect.deepEqual(emptyFields('oracle'), {
      type: 'oracle',
      network: { host: '', port: '1521', user: '', password: '', database: '', params: '' },
    })
  })
})

describe('parseDsn — malformed input', () => {
  t('returns null for unknown protocols', () => {
    expect.equal(parseDsn('redis://h'), null)
  })
  t('returns null for empty / whitespace', () => {
    expect.equal(parseDsn(''), null)
    expect.equal(parseDsn('   '), null)
  })
  t('returns null for missing protocol', () => {
    expect.equal(parseDsn('not a dsn'), null)
  })
})

// Run on import so the harness can collect results across all files.
await new Promise((resolve) => setImmediate(resolve))
await new Promise((resolve) => setImmediate(resolve))
console.log(`\n${testCount} tests collected in dsn.test.ts, ${failures.length} failed`)
for (const f of failures) {
  console.error(`  ✗ ${f.suite} > ${f.test}`)
  console.error(`    ${f.error instanceof Error ? f.error.message : String(f.error)}`)
}
if (failures.length > 0) process.exit(1)
