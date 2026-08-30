/**
 * Host TYPERT face: publishes the `dbhub` namespace, mirroring the
 * reference `@opendsh/dsh-plugin-setting-mcp` plugin's hand-written
 * manifest shape (so the same `dsh-typert-loader` row scan picks it up).
 *
 * Endpoints:
 *  - `dbhub/list`       — current settings view + runtime phase +
 *                         live tool inventory from dbhub's HTTP API.
 *  - `dbhub/listTools`  — fast tool-only fetch (used by the panel
 *                         after a `dbhub/save` round-trip).
 *  - `dbhub/save`       — replace the settings section, atomically
 *                         rewriting dbhub.toml. Returns the new view.
 *
 * The zod schemas are imported from `../shared/types.ts`, so the
 * client half and this host face validate with the exact same
 * codecs.
 *
 * @module @xcr1234/dsh-plugin-dbhub
 */

import { z } from 'zod'
import {
  dbhubSaveInputSchema,
  dbhubToolListSchema,
  dbhubViewSchema,
} from './shared/types.ts'

const PKG = '@xcr1234/dsh-plugin-dbhub'
const direct = { kind: 'direct' as const }

function jsonCodec(typeSymbol: string, schema: z.ZodTypeAny) {
  return { mode: 'strict' as const, typeSymbol: `${PKG}/types#${typeSymbol}`, schema }
}
function result(typeSymbol: string, schema: z.ZodTypeAny) {
  return { mode: 'strict' as const, typeSymbol: `${PKG}/types#${typeSymbol}`, schema }
}

export const TYPERT = {
  package: PKG,
  face: 'host' as const,
  schemas: [],
  model: {
    services: [
      {
        tags: [],
        key: 'dbhub',
        exportName: 'dbhub',
        members: [
          { name: 'list', kind: 'method' as const, signature: '(): Promise<DbhubView>' },
          {
            name: 'listTools',
            kind: 'method' as const,
            signature: '(): Promise<DbhubTool[]>',
          },
          {
            name: 'save',
            kind: 'method' as const,
            signature: '(input: DbhubConfig): Promise<DbhubView>',
          },
        ],
        types: [
          {
            name: 'DbhubSource',
            declaration:
              'export interface DbhubSource { id: string; dsn: string }',
          },
          {
            name: 'DbhubConfig',
            declaration:
              'export interface DbhubConfig { port: number; enabled: boolean; sources: DbhubSource[] }',
          },
          {
            name: 'DbhubTool',
            declaration:
              'export interface DbhubTool { sourceId: string; name: string; description: string | null; readonly: boolean }',
          },
          {
            name: 'DbhubView',
            declaration:
              'export interface DbhubView { config: DbhubConfig; running: boolean; lastError: string | null; configPath: string; tools: DbhubTool[] }',
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
  invocations: [
    {
      id: `${PKG}#dbhub/list`,
      service: 'dbhub',
      namespace: 'dbhub',
      method: 'list',
      invocation: direct,
      parameters: [],
      result: result('DbhubView', dbhubViewSchema),
    },
    {
      id: `${PKG}#dbhub/listTools`,
      service: 'dbhub',
      namespace: 'dbhub',
      method: 'listTools',
      invocation: direct,
      parameters: [],
      result: result('DbhubTool[]', dbhubToolListSchema),
    },
    {
      id: `${PKG}#dbhub/save`,
      service: 'dbhub',
      namespace: 'dbhub',
      method: 'save',
      invocation: direct,
      parameters: [
        {
          name: 'input',
          wire: 'input' as const,
          source: 'json' as const,
          codec: jsonCodec('DbhubConfig', dbhubSaveInputSchema),
        },
      ],
      result: result('DbhubView', dbhubViewSchema),
    },
  ],
}