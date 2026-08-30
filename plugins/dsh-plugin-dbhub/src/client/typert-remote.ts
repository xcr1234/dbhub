/**
 * Client TYPERT_REMOTE face: installs the `dbhub` namespace on the
 * client through `ctx.remote.$mount(...)`, mirroring the host TYPERT
 * manifest one-to-one so both directions validate with the same
 * strict codecs.
 *
 * @module @xcr1234/dsh-plugin-dbhub/client
 */

import { z } from 'zod'
import {
  dbhubSaveInputSchema,
  dbhubToolListSchema,
  dbhubViewSchema,
} from '../shared/types.ts'

const PKG = '@xcr1234/dsh-plugin-dbhub'
const direct = { kind: 'direct' as const }

function jsonCodec(typeSymbol: string, schema: z.ZodTypeAny) {
  return { mode: 'strict' as const, typeSymbol: `${PKG}/types#${typeSymbol}`, schema }
}
function result(typeSymbol: string, schema: z.ZodTypeAny) {
  return { mode: 'strict' as const, typeSymbol: `${PKG}/types#${typeSymbol}`, schema }
}

export const TYPERT_REMOTE = {
  package: PKG,
  descriptors: [
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
