/**
 * The dbhub settings page.
 * @module @xcr1234/dsh-plugin-dbhub/client
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import {
  inferDbType,
  type DbhubConfig,
  type DbhubSource,
  type DbhubTestResult,
  type DbhubTool,
  type DbhubView,
} from '../shared/types.ts'
import {
  composeDsn,
  DB_TYPE_LABELS,
  DB_TYPE_ORDER,
  DEFAULT_PORTS,
  emptyFields,
  parseDsn,
  type DbType,
  type DsnFields,
  type NetworkDsnFields,
  type SqliteDsnFields,
} from '../shared/dsn.ts'
import { C } from './styles.ts'
import { callRpc } from './rpc.ts'

/** Locale namespace owned by this plugin; matches `client/index.ts`. */
const NS = 'dbhub'

type T = (key: keyof typeof import('./locales.ts').zh, vars?: Record<string, string>) => string

export interface DbhubSettingsSectionProps {
  /**
   * DSH client root context. The panel talks to the host through
   * `ctx.connection.rpc.call('/dbhub', endpoint, payload)`; see
   * `./rpc.ts` for the thin wrapper used everywhere below.
   */
  ctx: ClientContext
  t: T
}

/**
 * The local edit buffer. `fields` holds the structured DSN parts the
 * user is editing; on save we compose back into a DSN string and
 * write `{ id, dsn }` into the config. `rawDsnFallback` keeps an
 * unparseable existing DSN alive — if the user hands us a connection
 * with an exotic format the parser doesn't recognise, the structured
 * form is hidden and they see / edit the raw string instead.
 */
interface DraftSource {
  draftId: string
  id: string
  fields: DsnFields | null
  rawDsnFallback: string | null
}

let tempIdCounter = 0
function tempId(): string {
  tempIdCounter += 1
  return `new-${Date.now().toString(36)}-${String(tempIdCounter)}`
}

function sourceToDraft(source: DbhubSource): DraftSource {
  const parsed = parseDsn(source.dsn)
  if (parsed === null) {
    // Unknown protocol or malformed DSN — fall back to raw editing
    // so the user can still tweak whatever weird shape they had.
    return { draftId: source.id, id: source.id, fields: null, rawDsnFallback: source.dsn }
  }
  return { draftId: source.id, id: source.id, fields: parsed, rawDsnFallback: null }
}

function newDraft(): DraftSource {
  return { draftId: tempId(), id: '', fields: emptyFields('postgres'), rawDsnFallback: null }
}

function inferTypeLabel(dsn: string): string {
  const type = inferDbType(dsn)
  if (type === null) return ''
  return type
}

interface FieldErrors {
  /** Connection ID slot. */
  id?: string
  /** Raw-DSN fallback slot (only set when the parser couldn't recognise the protocol). */
  rawDsn?: string
  /** Structured-form host slot. Only set for non-SQLite drafts. */
  host?: string
  /** Structured-form user slot. Only set for non-SQLite drafts. */
  user?: string
  /** Structured-form database slot. Only set for non-SQLite drafts. */
  database?: string
  /** Structured-form filePath slot. Only set for SQLite drafts. */
  filePath?: string
}

function validateDraft(draft: DraftSource, takenIds: Set<string>, t: T): FieldErrors {
  const errors: FieldErrors = {}
  if (draft.id.length === 0) {
    errors.id = t('form.error.id')
  } else if (!/^[A-Za-z0-9_-]{1,64}$/.test(draft.id)) {
    errors.id = t('form.error.idInvalid')
  } else if (takenIds.has(draft.id)) {
    errors.id = t('form.error.duplicateId')
  }
  if (draft.fields === null) {
    const raw = draft.rawDsnFallback ?? ''
    if (raw.length === 0) errors.rawDsn = t('form.error.type')
    else if (inferDbType(raw) === null) errors.rawDsn = t('form.error.type')
  } else if (draft.fields.type === 'sqlite') {
    if (!draft.fields.sqlite.memory && draft.fields.sqlite.filePath.trim().length === 0) {
      errors.filePath = t('form.error.filePath')
    }
  } else {
    const net = draft.fields.network
    if (net.host.trim().length === 0) errors.host = t('form.error.host')
    if (net.user.trim().length === 0) errors.user = t('form.error.user')
    if (net.database.trim().length === 0) errors.database = t('form.error.database')
  }
  return errors
}

/** True when there are no field-level errors to surface. */
function hasErrors(errors: FieldErrors): boolean {
  for (const key in errors) {
    if (Object.prototype.hasOwnProperty.call(errors, key) && errors[key as keyof FieldErrors] !== undefined) {
      return true
    }
  }
  return false
}

function configEquals(a: DbhubConfig, b: DbhubConfig): boolean {
  if (a.port !== b.port) return false
  if (a.enabled !== b.enabled) return false
  if (a.sources.length !== b.sources.length) return false
  for (let i = 0; i < a.sources.length; i += 1) {
    const left = a.sources[i]
    const right = b.sources[i]
    if (left === undefined || right === undefined) return false
    if (left.id !== right.id) return false
    if (left.dsn !== right.dsn) return false
  }
  return true
}

function Field(props: { label: string; hint?: string; error?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className={C.field}>
      <label className={C.label}>{props.label}</label>
      {props.hint !== undefined ? <div className={C.hint}>{props.hint}</div> : null}
      {props.children}
      {props.error !== undefined ? <div className={C.error}>{props.error}</div> : null}
    </div>
  )
}

function redactDsn(dsn: string): string {
  const match = /^(.+:\/\/[^:]+:)([^@]+)(@.+)$/.exec(dsn)
  if (match === null) return dsn
  return `${match[1] ?? ''}***${match[3] ?? ''}`
}

/**
 * Switch the draft to a different database type. When switching between
 * network types we keep the username / password (people reuse creds
 * across MySQL → MariaDB → Postgres all the time) and reset the port
 * to the canonical default. Switching to / from SQLite fully resets,
 * since the field shapes don't share anything.
 */
function fieldsForTypeChange(prev: DraftSource, nextType: DbType): DsnFields {
  if (nextType === 'sqlite') {
    return emptyFields('sqlite')
  }
  const oldUser = prev.fields !== null && prev.fields.type !== 'sqlite' ? prev.fields.network.user : ''
  const oldPassword = prev.fields !== null && prev.fields.type !== 'sqlite' ? prev.fields.network.password : ''
  return {
    type: nextType,
    network: {
      host: '',
      port: String(DEFAULT_PORTS[nextType]),
      user: oldUser,
      password: oldPassword,
      database: '',
      params: '',
    },
  }
}

export function DbhubSettingsSection(props: DbhubSettingsSectionProps): React.ReactElement {
  const t = props.t
  const ctx = props.ctx
  const [view, setView] = useState<DbhubView | null>(null)
  const [draft, setDraft] = useState<DbhubConfig | null>(null)
  const [editing, setEditing] = useState<DraftSource | null>(null)
  /** Per-field validation errors. Lives separately from `editing` so
   *  typing in a field doesn't get echoed back as error text — the
   *  original code merged errors into `editing` (e.g. set `editing.id`
   *  to a localised message), which conflated user input with
   *  validation messages and could also crash React when the slot's
   *  runtime type was an object (the filePath slot). */
  const [errors, setErrors] = useState<FieldErrors>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  // `testing` mirrors `saving` for the "test connection" button — drives
  // the button label (连接中… vs 测试连接) and disables the form while
  // the host spawns a one-shot dbhub child process. `testResult` keeps
  // the last probe outcome so the editor can render a green / red chip
  // until the user types again or saves. `lastTestedDsn` records the
  // DSN we last probed; the chip only renders when the current
  // `previewDsn` matches it, so typing in any field invalidates the
  // chip implicitly without needing an explicit reset call everywhere.
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<DbhubTestResult | null>(null)
  const [lastTestedDsn, setLastTestedDsn] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const value = await callRpc<DbhubView>(ctx, 'list')
      setView(value)
      setDraft((prev) => (prev === null ? value.config : prev))
      setLoadError(null)
    } catch (err) {
      setLoadError(t('error.load', { message: err instanceof Error ? err.message : String(err) }))
    }
  }, [ctx, t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const dirty = useMemo(() => {
    if (draft === null || view === null) return false
    return !configEquals(draft, view.config)
  }, [draft, view])

  const takenIds = useMemo(() => {
    const set = new Set<string>()
    if (draft) for (const s of draft.sources) if (s.id.length > 0) set.add(s.id)
    return set
  }, [draft])

  const onSave = useCallback(async () => {
    if (draft === null) return
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    // eslint-disable-next-line no-console
    console.warn(`[dbhub-panel] save click: sources=${String(draft.sources.length)} port=${String(draft.port)}`)
    try {
      const value = await callRpc<DbhubView>(ctx, 'save', draft)
      setSaving(false)
      // eslint-disable-next-line no-console
      console.warn('[dbhub-panel] save result: ok')
      setView(value)
      setDraft(value.config)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
      // dbhub's fs.watch has a 500 ms debounce before it begins a
      // reload, and the host runtime's reconcile + child spawn can
      // add another second on a cold restart. Pull the tool
      // inventory again after a short delay so the panel reflects
      // the freshly registered set rather than the pre-reload
      // snapshot the `save` response carried.
      window.setTimeout(() => {
        void callRpc<DbhubTool[]>(ctx, 'listTools').then((tools) => {
          setView((prev) => (prev === null ? prev : { ...prev, tools }))
        }).catch(() => {
          // Best-effort refresh; ignore failure here.
        })
      }, 1500)
    } catch (err) {
      setSaving(false)
      // eslint-disable-next-line no-console
      console.warn(`[dbhub-panel] save error: ${err instanceof Error ? err.message : String(err)}`)
      setSaveError(t('error.save', { message: err instanceof Error ? err.message : String(err) }))
    }
  }, [draft, ctx, t])

  const onDiscard = useCallback(() => {
    if (view === null) return
    setDraft(view.config)
    setEditing(null)
    setErrors({})
    setSaveError(null)
  }, [view])

  /**
   * Probe the DSN currently in the editor via the host's one-shot
   * `--test-dsn` child process. The result chip stays visible only
   * while `previewDsn` matches the DSN we just tested — typing in
   * any field invalidates it implicitly, so the user never sees a
   * stale success against a changed DSN.
   */
  const onTest = useCallback(async () => {
    if (editing === null) return
    const dsn =
      editing.fields !== null
        ? composeDsn(editing.fields)
        : editing.rawDsnFallback ?? ''
    if (dsn.length === 0) return
    setTesting(true)
    setTestResult(null)
    try {
      const value = await callRpc<DbhubTestResult>(ctx, 'testConnection', { dsn })
      setTestResult(value)
    } catch (err) {
      // Protocol-level failure (RPC envelope said "no"). The
      // business-level DbhubTestResult already has its own ok/error
      // fields, so wrap a synthetic failure that the chip can render
      // in the same shape as a failed probe.
      setTestResult({
        ok: false,
        latencyMs: 0,
        dbType: null,
        serverVersion: null,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setTesting(false)
    }
    setLastTestedDsn(dsn)
  }, [editing, ctx])

  const onAdd = useCallback(() => {
    setEditing(newDraft())
    setErrors({})
  }, [])

  const onEdit = useCallback((source: DbhubSource) => {
    setEditing(sourceToDraft(source))
    setErrors({})
  }, [])

  const onRemove = useCallback(
    (source: DbhubSource) => {
      if (draft === null) return
      if (!window.confirm(t('list.confirm.remove', { name: source.id }))) return
      setDraft({ ...draft, sources: draft.sources.filter((s) => s.id !== source.id) })
    },
    [draft, t],
  )

  const onEditChange = useCallback((patch: Partial<{ id: string; fields: DsnFields | null; rawDsnFallback: string | null }>) => {
    setEditing((prev) => {
      if (prev === null) return prev
      const next: DraftSource = { ...prev, ...patch }
      // Switching type wipes the raw-fallback path since structured
      // editing takes over.
      if (patch.fields !== undefined && patch.fields !== null) next.rawDsnFallback = null
      // Switching from raw fallback to structured re-init the fields.
      if (patch.rawDsnFallback !== undefined && patch.rawDsnFallback === null && prev.rawDsnFallback !== null) {
        next.fields = emptyFields('postgres')
      }
      return next
    })
    // Clear the id error the moment the user types anything new —
    // stale errors are more confusing than no error at all.
    if (patch.id !== undefined) setErrors((prev) => ({ ...prev, id: undefined }))
    if (patch.rawDsnFallback !== undefined) setErrors((prev) => ({ ...prev, rawDsn: undefined }))
  }, [])

  const onTypeChange = useCallback((nextType: DbType) => {
    setEditing((prev) => {
      if (prev === null || prev.fields === null) return prev
      return { ...prev, fields: fieldsForTypeChange(prev, nextType) }
    })
    // Type change wipes all structured-form errors since the slots
    // no longer apply to the new shape.
    setErrors((prev) => ({ ...prev, host: undefined, user: undefined, database: undefined, filePath: undefined }))
  }, [])

  const onNetworkFieldChange = useCallback((patch: Partial<NetworkDsnFields>) => {
    setEditing((prev) => {
      if (prev === null || prev.fields === null || prev.fields.type === 'sqlite') return prev
      return { ...prev, fields: { ...prev.fields, network: { ...prev.fields.network, ...patch } } }
    })
    setErrors((prev) => {
      const next = { ...prev }
      if (patch.host !== undefined) next.host = undefined
      if (patch.user !== undefined) next.user = undefined
      if (patch.database !== undefined) next.database = undefined
      return next
    })
  }, [])

  const onSqliteFieldChange = useCallback((patch: Partial<SqliteDsnFields>) => {
    setEditing((prev) => {
      if (prev === null || prev.fields === null || prev.fields.type !== 'sqlite') return prev
      return { ...prev, fields: { ...prev.fields, sqlite: { ...prev.fields.sqlite, ...patch } } }
    })
    setErrors((prev) => {
      if (patch.filePath === undefined) return prev
      return { ...prev, filePath: undefined }
    })
  }, [])

  const onEditSave = useCallback(() => {
    if (editing === null || draft === null) return
    // When editing an existing source, exclude its ORIGINAL id from
    // the duplicate-id check. `takenIds` is built from the whole
    // draft config and therefore includes the row the user is
    // editing — without this carve-out, saving any edit to an
    // existing connection would trip `form.error.duplicateId` even
    // when the user kept the id exactly the same. Only NEW sources
    // (draftId starts with `new-`) genuinely need to avoid every
    // existing id.
    const isNew = editing.draftId.startsWith('new-')
    const idsForDupCheck = new Set(takenIds)
    if (!isNew) idsForDupCheck.delete(editing.draftId)
    const nextErrors = validateDraft(editing, idsForDupCheck, t)
    if (hasErrors(nextErrors)) {
      setErrors(nextErrors)
      return
    }
    setErrors({})
    // Resolve final DSN: structured compose, or raw fallback.
    let dsn: string
    if (editing.fields !== null) dsn = composeDsn(editing.fields)
    else if (editing.rawDsnFallback !== null && editing.rawDsnFallback.length > 0) dsn = editing.rawDsnFallback
    else return

    const next: DbhubConfig = { ...draft }
    const source: DbhubSource = { id: editing.id, dsn }
    if (isNew) {
      next.sources = [...draft.sources, source]
    } else if (editing.id !== editing.draftId) {
      next.sources = draft.sources.map((s) => (s.id === editing.draftId ? source : s))
    } else {
      next.sources = draft.sources.map((s) => (s.id === editing.draftId ? source : s))
    }
    setDraft(next)
    setEditing(null)
  }, [draft, editing, t, takenIds])

  const onEditCancel = useCallback(() => {
    setEditing(null)
    setErrors({})
  }, [])

  if (view === null || draft === null) {
    return (
      <div className={C.wrap}>
        {loadError !== null ? <div className={C.error}>{loadError}</div> : null}
        <div className={C.empty}>{t('list.emptyHint')}</div>
      </div>
    )
  }

  // Live preview: shown under the form so users can verify what gets
  // written. For raw-fallback edits the preview IS the raw string.
  const previewDsn =
    editing?.fields !== null && editing?.fields !== undefined ? composeDsn(editing.fields) : editing?.rawDsnFallback ?? ''

  return (
    <div className={C.wrap}>
      <p className={C.desc}>
        {t('desc')}
        <a className={C.contact} href="https://github.com/xcr1234/dbhub" target="_blank" rel="noreferrer">
          {t('contact')}
        </a>
      </p>

      <div className={C.card}>
        <div className={C.cardHead}>
          <div className={C.cardTitle}>{t('title')}</div>
          {view.running ? (
            <span className={`${C.badge} ${C.badgeOk}`}>{t('status.running')}</span>
          ) : view.lastError !== null ? (
            <span className={`${C.badge} ${C.badgeError}`}>{t('status.error')}</span>
          ) : (
            <span className={`${C.badge} ${C.badgeOff}`}>{t('status.stopped')}</span>
          )}
        </div>
        {view.running === false && view.lastError !== null ? (
          <div className={C.error} title={view.lastError}>
            {view.lastError}
          </div>
        ) : null}
        <Field label={t('port')} hint={t('portHint')}>
          <input
            className={C.input}
            type="number"
            min={1}
            max={65535}
            value={String(draft.port)}
            onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) || draft.port })}
            disabled={saving}
          />
        </Field>
        <label className={C.checkbox}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            disabled={saving}
          />
          {t('enabled')}
        </label>
      </div>

      <div className={C.card}>
        {draft.sources.length === 0 ? (
          <div className={C.empty}>
            <div>{t('list.empty')}</div>
            <div>{t('list.emptyHint')}</div>
          </div>
        ) : (
          draft.sources.map((source) => {
            const sourceTools = (view?.tools ?? []).filter(
              (tool) => tool.sourceId === source.id,
            )
            return (
              <div className={C.row} key={source.id}>
                <div className={C.rowMain}>
                  <div className={C.name}>{source.id}</div>
                  <div className={C.meta}>
                    {(() => {
                      const type = inferTypeLabel(source.dsn)
                      return type.length > 0 ? `${type} · ${redactDsn(source.dsn)}` : redactDsn(source.dsn)
                    })()}
                  </div>
                  {sourceTools.length > 0 ? (
                    <div className={C.toolsRow}>
                      {sourceTools.map((tool) => (
                        <span
                          className={`${C.toolChip} ${tool.readonly ? C.toolChipReadonly : ''}`}
                          key={`${tool.sourceId}.${tool.name}`}
                          title={tool.description ?? tool.name}
                        >
                          {tool.name}
                          {tool.readonly ? <span className={C.toolChipSource}>· {t('tool.readonly')}</span> : null}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className={C.rowActions}>
                  <button className={C.btn} onClick={() => onEdit(source)} disabled={saving}>
                    {t('action.edit')}
                  </button>
                  <button className={`${C.btn} ${C.btnDanger}`} onClick={() => onRemove(source)} disabled={saving}>
                    {t('action.remove')}
                  </button>
                </div>
              </div>
            )
          })
        )}
        <div className={C.rowActions}>
          <button className={`${C.btn} ${C.btnPrimary}`} onClick={onAdd} disabled={saving || editing !== null}>
            {t('list.add')}
          </button>
        </div>
      </div>

      {editing !== null ? (
        <div className={C.editor}>
          <div className={C.editorHeader}>
            {editing.draftId.startsWith('new-') ? t('form.new') : t('form.edit', { name: editing.draftId })}
          </div>
          <div className={C.editorBody}>
            <Field
              label={t('form.id')}
              hint={
                editing.draftId.startsWith('new-')
                  ? t('form.idHint')
                  : t('form.idLockedHint')
              }
              error={errors.id}
            >
              <input
                className={C.input}
                value={editing.id}
                onChange={(e) => onEditChange({ id: e.target.value })}
                placeholder="my_postgres"
                // The id is the source's stable namespace — the
                // model-facing tool prefix (mcp__dbhub__<id>__...) is
                // built from it, and the on-disk TOML row's key is
                // keyed by it. Renaming would orphan any references,
                // so we lock it on edit. To "rename", the user should
                // remove the connection and add a fresh one with the
                // new id.
                disabled={!editing.draftId.startsWith('new-')}
                readOnly={!editing.draftId.startsWith('new-')}
              />
            </Field>

            {editing.fields !== null ? (
              <>
                <Field label={t('form.type')} hint={t('form.typeHint')}>
                  <select
                    className={C.select}
                    value={editing.fields.type}
                    onChange={(e) => onTypeChange(e.target.value as DbType)}
                  >
                    {DB_TYPE_ORDER.map((type) => (
                      <option key={type} value={type}>
                        {DB_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                </Field>

                {editing.fields.type === 'sqlite' ? (
                  <>
                    <Field
                      label={t('form.filePath')}
                      hint={t('form.filePathHint')}
                      error={errors.filePath}
                    >
                      <input
                        className={C.input}
                        value={editing.fields.sqlite.filePath}
                        onChange={(e) => onSqliteFieldChange({ filePath: e.target.value })}
                        placeholder="/var/lib/data/app.db"
                        disabled={editing.fields.sqlite.memory}
                      />
                    </Field>
                    <label className={C.checkbox}>
                      <input
                        type="checkbox"
                        checked={editing.fields.sqlite.memory}
                        onChange={(e) => {
                          // Capture the current path before the
                          // toggle, so flipping back to file-based
                          // editing doesn't lose what was typed.
                          const current = editing.fields?.type === 'sqlite' ? editing.fields.sqlite.filePath : ''
                          onSqliteFieldChange({ memory: e.target.checked, filePath: e.target.checked ? '' : current })
                        }}
                      />
                      {t('form.memoryMode')}
                    </label>
                    <div className={C.hint}>{t('form.memoryModeHint')}</div>
                  </>
                ) : (
                  <>
                    <div className={C.fieldRow}>
                      <Field label={t('form.host')} hint={t('form.hostHint')} error={errors.host}>
                        <input
                          className={C.input}
                          value={editing.fields.network.host}
                          onChange={(e) => onNetworkFieldChange({ host: e.target.value })}
                          placeholder="localhost"
                        />
                      </Field>
                      <Field label={t('form.port')} hint={t('form.portHint')}>
                        <input
                          className={C.input}
                          type="number"
                          min={1}
                          max={65535}
                          value={editing.fields.network.port}
                          onChange={(e) => onNetworkFieldChange({ port: e.target.value })}
                          placeholder={String(DEFAULT_PORTS[editing.fields.type])}
                        />
                      </Field>
                    </div>
                    <div className={C.fieldRow}>
                      <Field label={t('form.user')} hint={t('form.userHint')} error={errors.user}>
                        <input
                          className={C.input}
                          value={editing.fields.network.user}
                          onChange={(e) => onNetworkFieldChange({ user: e.target.value })}
                          placeholder="root"
                        />
                      </Field>
                      <Field label={t('form.password')} hint={t('form.passwordHint')}>
                        <input
                          className={C.input}
                          type="password"
                          value={editing.fields.network.password}
                          onChange={(e) => onNetworkFieldChange({ password: e.target.value })}
                          placeholder="••••••"
                        />
                      </Field>
                    </div>
                    <Field label={t('form.database')} hint={t('form.databaseHint')} error={errors.database}>
                      <input
                        className={C.input}
                        value={editing.fields.network.database}
                        onChange={(e) => onNetworkFieldChange({ database: e.target.value })}
                        placeholder="mydb"
                      />
                    </Field>
                    <Field label={t('form.params')} hint={t('form.paramsHint')}>
                      <input
                        className={C.input}
                        value={editing.fields.network.params}
                        onChange={(e) => onNetworkFieldChange({ params: e.target.value })}
                        placeholder="sslmode=require&connect_timeout=10"
                      />
                    </Field>
                  </>
                )}

                <Field label={t('form.dsnPreview')} hint={t('form.dsnPreviewHint')}>
                  <code className={C.dsnPreview}>{redactDsn(previewDsn) || '—'}</code>
                </Field>
              </>
            ) : (
              <Field
                label={t('form.rawDsn')}
                hint={t('form.rawDsnHint')}
                error={errors.rawDsn}
              >
                <input
                  className={C.input}
                  value={editing.rawDsnFallback ?? ''}
                  onChange={(e) => onEditChange({ rawDsnFallback: e.target.value })}
                />
              </Field>
            )}
          </div>
          <div className={C.editorFooter}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'flex-start', gap: 6, minWidth: 0, paddingTop: 4 }}>
              {/* Result chip only renders when the editor's current
                  preview DSN still matches what we last probed. Typing
                  in any field invalidates it implicitly (previewDsn
                  changes, lastTestedDsn doesn't), so the chip never
                  shows a stale verdict against a changed DSN.

                  Success uses a single-line badge (the latency + short
                  message fits). Failure uses a block element so a
                  multi-line Oracle / Postgres error like
                  `ORA-01017: invalid credential or not authorized;\nlogon denied\nHelp: ...`
                  wraps cleanly instead of being clipped — .dshdb-badge
                  is fixed at 20px height, which is why we drop the
                  class here and recreate the look inline. */}
              {testResult !== null && lastTestedDsn === previewDsn ? (
                testResult.ok ? (
                  <span
                    className={`${C.badge} ${C.badgeOk}`}
                    title={testResult.serverVersion ?? ''}
                    style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {t('editor.testOk', { latencyMs: String(testResult.latencyMs) })}
                  </span>
                ) : (
                  <div
                    className={C.badgeError}
                    title={testResult.error ?? ''}
                    style={{
                      maxWidth: '100%',
                      padding: '4px 8px',
                      borderRadius: 8,
                      fontSize: 11,
                      lineHeight: '16px',
                      // Preserve real newlines from the connector's
                      // error message; long unbroken strings (URLs,
                      // DSNs in error text) break anywhere instead of
                      // pushing the buttons offscreen.
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'anywhere',
                      textAlign: 'left',
                      alignSelf: 'flex-start',
                    }}
                  >
                    {t('editor.testFail', { message: testResult.error ?? '' })}
                  </div>
                )
              ) : null}
            </div>
            <button
              className={C.btn}
              onClick={onEditCancel}
              disabled={saving || testing}
              style={{ alignSelf: 'center', flexShrink: 0 }}
            >
              {t('action.cancel')}
            </button>
            <button
              className={C.btn}
              onClick={onTest}
              disabled={saving || testing || previewDsn.length === 0}
              style={{ alignSelf: 'center', flexShrink: 0 }}
            >
              {testing ? t('editor.testing') : t('editor.test')}
            </button>
            <button
              className={`${C.btn} ${C.btnPrimary}`}
              onClick={onEditSave}
              disabled={saving || testing}
              style={{ alignSelf: 'center', flexShrink: 0 }}
            >
              {t('action.save')}
            </button>
          </div>
        </div>
      ) : null}

      <div className={C.card}>
        <div className={C.cardHead}>
          <div className={C.cardTitle}>{t('tools.title')}</div>
          {view.running && (view.tools ?? []).length > 0 ? (
            <span className={`${C.badge} ${C.badgeInfo}`}>
              {String((view.tools ?? []).length)}
            </span>
          ) : null}
        </div>
        {view.running ? (
          (view.tools ?? []).length > 0 ? (
            <div className={C.toolsRow}>
              {(view.tools ?? []).map((tool) => (
                <span
                  className={`${C.toolChip} ${tool.readonly ? C.toolChipReadonly : ''}`}
                  key={`${tool.sourceId}.${tool.name}`}
                  title={
                    (tool.description ?? tool.name) +
                    (tool.sourceId.length > 0 ? `\nsource: ${tool.sourceId}` : '')
                  }
                >
                  {tool.sourceId}.{tool.name}
                  {tool.readonly ? <span className={C.toolChipSource}>· {t('tool.readonly')}</span> : null}
                </span>
              ))}
            </div>
          ) : (
            <div className={C.toolsEmpty}>{t('tools.refreshing')}</div>
          )
        ) : (
          <div className={C.toolsEmpty}>{t('tools.empty')}</div>
        )}
      </div>

      <div className={C.toml}>
        <div>{t('toml.path')}</div>
        <code className={C.tomlPath}>{view.configPath}</code>
        <div className={C.hint}>{t('toml.hint')}</div>
      </div>

      <div className={C.footer}>
        {saveError !== null ? <div className={C.error}>{saveError}</div> : null}
        {saved ? <div className={C.notice}>{t('footer.saved')}</div> : null}
        {dirty && !saved && saveError === null ? <div className={C.notice}>{t('footer.dirty')}</div> : null}
        <div style={{ flex: 1 }} />
        <button className={C.btn} onClick={onDiscard} disabled={!dirty || saving}>
          {t('footer.discard')}
        </button>
        <button
          className={`${C.btn} ${C.btnPrimary}`}
          onClick={onSave}
          disabled={!dirty || saving || editing !== null}
        >
          {saving ? t('footer.saving') : t('footer.save')}
        </button>
      </div>
    </div>
  )
}