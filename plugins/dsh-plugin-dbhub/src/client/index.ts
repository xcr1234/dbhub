/**
 * Client plugin body: registers the locale dictionaries, injects the
 * stylesheet, then injects the React settings page into the
 * `settings.section` slot.
 *
 * The host wraps this file in a `window.__ModuleLoader__.load` factory
 * at build time, so the source shape is the same as every other
 * browser plugin in the dsh ecosystem.
 *
 * @module @xcr1234/dsh-plugin-dbhub/client
 */

import { DbhubSettingsSection } from './DbhubSettingsSection.tsx'
import { en, zh } from './locales.ts'
import { injectStyles } from './styles.ts'

/** Dictionary namespace owned by this plugin (settings page copy). */
const NS = 'dbhub'

/**
 * The Cordis-style client apply function. Invoked by dsh-web with a
 * `ctx` object exposing `slots`, `connection`, `locale`, and `effect`
 * — the same surface every browser plugin consumes.
 *
 * We no longer mount a TYPERT_REMOTE manifest (the old bridge-based
 * `@Remote` decorator path was retired — see `../index.ts` for the
 * full rationale). The panel talks to the host directly through
 * `ctx.connection.rpc.call('/dbhub', endpoint, payload)` via
 * `./rpc.ts`.
 */
export async function apply(ctx: {
  effect: (fn: () => unknown | (() => void), label?: string) => () => void
  locale: {
    register(ns: string, dict: { zh: unknown; en: unknown }): void
    bind(ns: string): (key: string, vars?: Record<string, string>) => string
  }
  connection: { rpc: { call: (channel: string, endpoint: string, payload: unknown) => Promise<unknown> } }
  slots: {
    inject(slotName: string, register: () => unknown): void
    register: (descriptor: unknown, component: unknown) => unknown
  }
  get<T = unknown>(key: string): T | undefined
}): Promise<void> {
  injectStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dbhub:dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dbhub',
        order: 40,
        label: () => t('nav'),
        locale: NS,
        // Inject the full ctx so the panel can call into
        // `ctx.connection.rpc` directly. Mirrors dsh-mcp-manager's
        // `inject: () => ({ ctx })` — keeping the same shape keeps
        // every panel in the dsh ecosystem feeling familiar.
        inject: () => ({ ctx }),
      },
      DbhubSettingsSection,
    ),
  )
}

/** Stable cordis plugin name (used for client diagnostics). */
export const name = 'dbhub'

/** Services required before this plugin mounts. */
export const inject = ['slots', 'connection', 'locale']