/**
 * The dbhub settings page.
 * @module @xcr1234/dsh-plugin-dbhub/client
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { inferDbType, type DbhubConfig, type DbhubSource, type DbhubTool, type DbhubView } from '../shared/types.ts'
import { C } from './styles.ts'

/** Locale namespace owned by this plugin; matches `client/index.ts`. */
const NS = 'dbhub'

type T = (key: keyof typeof import('./locales.ts').zh, vars?: Record<string, string>) => string

export interface DbhubRemote {
  list(): Promise<{ ok: true; value: DbhubView } | { ok: false; error: Error }>
  listTools(): Promise<{ ok: true; value: DbhubTool[] } | { ok: false; error: Error }>
  save(
    input: DbhubConfig,
  ): Promise<{ ok: true; value: DbhubView } | { ok: false; error: Error }>
}

export interface DbhubSettingsSectionProps {
  t: T
  dbhub: DbhubRemote
}

interface DraftSource {
  draftId: string
  id: string
  dsn: string
}

let tempIdCounter = 0
function tempId(): string {
  tempIdCounter += 1
  return `new-${Date.now().toString(36)}-${String(tempIdCounter)}`
}

function sourceToDraft(source: DbhubSource): DraftSource {
  return { draftId: source.id, id: source.id, dsn: source.dsn }
}

function newDraft(): DraftSource {
  return { draftId: tempId(), id: '', dsn: '' }
}

function inferTypeLabel(dsn: string): string {
  const type = inferDbType(dsn)
  if (type === null) return ''
  return type
}

interface FieldErrors {
  id?: string
  dsn?: string
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
  if (draft.dsn.length === 0) {
    errors.dsn = t('form.error.dsn')
  } else if (inferDbType(draft.dsn) === null) {
    errors.dsn = t('form.error.dsnInvalid')
  }
  return errors
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

export function DbhubSettingsSection(props: DbhubSettingsSectionProps): React.ReactElement {
  const t = props.t
  const remote = props.dbhub
  const [view, setView] = useState<DbhubView | null>(null)
  const [draft, setDraft] = useState<DbhubConfig | null>(null)
  const [editing, setEditing] = useState<DraftSource | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const refresh = useCallback(async () => {
    const result = await remote.list()
    if (result.ok) {
      setView(result.value)
      setDraft((prev) => (prev === null ? result.value.config : prev))
      setLoadError(null)
    } else {
      setLoadError(t('error.load', { message: result.error.message }))
    }
  }, [remote, t])

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
    const result = await remote.save(draft)
    setSaving(false)
    // eslint-disable-next-line no-console
    console.warn(`[dbhub-panel] save result: ${result.ok ? 'ok' : 'error: ' + result.error.message}`)
    if (result.ok) {
      setView(result.value)
      setDraft(result.value.config)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
      // dbhub's fs.watch has a 500 ms debounce before it begins a
      // reload, and the host runtime's reconcile + child spawn can
      // add another second on a cold restart. Pull the tool
      // inventory again after a short delay so the panel reflects
      // the freshly registered set rather than the pre-reload
      // snapshot the `save` response carried.
      window.setTimeout(() => {
        void remote.listTools().then((toolsResult) => {
          if (toolsResult.ok) {
            setView((prev) => (prev === null ? prev : { ...prev, tools: toolsResult.value }))
          }
        })
      }, 1500)
    } else {
      setSaveError(t('error.save', { message: result.error.message }))
    }
  }, [draft, remote, t])

  const onDiscard = useCallback(() => {
    if (view === null) return
    setDraft(view.config)
    setEditing(null)
    setSaveError(null)
  }, [view])

  const onAdd = useCallback(() => {
    setEditing(newDraft())
  }, [])

  const onEdit = useCallback((source: DbhubSource) => {
    setEditing(sourceToDraft(source))
  }, [])

  const onRemove = useCallback(
    (source: DbhubSource) => {
      if (draft === null) return
      if (!window.confirm(t('list.confirm.remove', { name: source.id }))) return
      setDraft({ ...draft, sources: draft.sources.filter((s) => s.id !== source.id) })
    },
    [draft, t],
  )

  const onEditChange = useCallback((patch: Partial<DraftSource>) => {
    setEditing((prev) => (prev === null ? prev : { ...prev, ...patch }))
  }, [])

  const onEditSave = useCallback(() => {
    if (editing === null || draft === null) return
    const errors = validateDraft(editing, takenIds, t)
    if (errors.id !== undefined || errors.dsn !== undefined) {
      setEditing({ ...editing, ...(errors as Partial<DraftSource>) })
      return
    }
    const next: DbhubConfig = { ...draft }
    const isNew = editing.draftId.startsWith('new-')
    const source: DbhubSource = { id: editing.id, dsn: editing.dsn }
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
  }, [])

  if (view === null || draft === null) {
    return (
      <div className={C.wrap}>
        {loadError !== null ? <div className={C.error}>{loadError}</div> : null}
        <div className={C.empty}>{t('list.emptyHint')}</div>
      </div>
    )
  }

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
              hint={t('form.idHint')}
              error={(editing as DraftSource & FieldErrors).id}
            >
              <input
                className={C.input}
                value={editing.id}
                onChange={(e) => onEditChange({ id: e.target.value })}
                placeholder="my_postgres"
              />
            </Field>
            <Field
              label={t('form.dsn')}
              hint={t('form.dsnHint')}
              error={(editing as DraftSource & FieldErrors).dsn}
            >
              <input
                className={C.input}
                value={editing.dsn}
                onChange={(e) => onEditChange({ dsn: e.target.value })}
                placeholder="postgres://user:pass@host:5432/dbname"
              />
            </Field>
          </div>
          <div className={C.editorFooter}>
            <button className={C.btn} onClick={onEditCancel} disabled={saving}>
              {t('action.cancel')}
            </button>
            <button className={`${C.btn} ${C.btnPrimary}`} onClick={onEditSave} disabled={saving}>
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
