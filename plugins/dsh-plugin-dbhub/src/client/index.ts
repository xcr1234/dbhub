/**
 * Client plugin body: registers the locale dictionaries, mounts the
 * `dbhub` typert remote, then injects the React settings page into
 * the `settings.section` slot.
 *
 * The host client wraps this file in a `window.__ModuleLoader__.load`
 * factory at build time, so the source shape is the same as every
 * other browser plugin in the dsh ecosystem.
 *
 * @module @xcr1234/dsh-plugin-dbhub/client
 */

import { DbhubSettingsSection, type DbhubRemote } from './DbhubSettingsSection.tsx'
import { en, zh } from './locales.ts'
import { injectStyles } from './styles.ts'
import { TYPERT_REMOTE } from './typert-remote.ts'

/** Dictionary namespace owned by this plugin (settings page copy). */
const NS = 'dbhub'

/**
 * The Cordis-style client apply function. Invoked by dsh-web with a
 * `ctx` object exposing `slots`, `remote`, `locale`, and `effect` —
 * the same surface every browser plugin consumes.
 */
export async function apply(ctx: {
  effect: (fn: () => unknown | (() => void), label?: string) => () => void
  locale: {
    register(ns: string, dict: { zh: unknown; en: unknown }): void
    bind(ns: string): (key: string, vars?: Record<string, string>) => string
  }
  remote: { $mount(remote: typeof TYPERT_REMOTE): Promise<unknown> }
  slots: {
    inject(slotName: string, register: () => unknown): void
    register: (descriptor: unknown, component: unknown) => unknown
  }
  get<T = unknown>(key: string): T | undefined
}): Promise<void> {
  injectStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dbhub:dictionaries')
  await ctx.remote.$mount(TYPERT_REMOTE)
  const t = ctx.locale.bind(NS)
  const remote = ctx.get('remote.dbhub') as DbhubRemote | undefined
  if (!remote) {
    throw new Error('dbhub client: remote.dbhub is not available after $mount')
  }
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dbhub',
        order: 40,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ dbhub: remote }),
      },
      DbhubSettingsSection,
    ),
  )
}

/** Stable cordis plugin name (used by client diagnostics). */
export const name = 'dbhub'

/** Services required before this plugin mounts. */
export const inject = ['slots', 'remote', 'locale']
