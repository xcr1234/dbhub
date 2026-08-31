/**
 * Host-side Connection-RPC plumbing for the dbhub plugin.
 *
 * Mirrors dsh-mcp-manager's `src/index.ts` pattern: a single channel
 * (`/dbhub`) registered via `ctx.connection.rpc.handle(...)` with a
 * `dispatch()` switch routing endpoint names to `DbhubService`
 * methods. The reply envelope matches the host's standard `RpcResult`
 * shape so callers can error-envelope into the UI without re-throwing.
 *
 * Why this lives here, not inline in `src/index.ts`:
 *  - keeps the entry focused on lifecycle wiring;
 *  - gives the dispatch + envelope helpers one importable surface so
 *    tests and the entry share the same code path.
 *
 * @module @xcr1234/dsh-plugin-dbhub/host/rpc
 */

import { RPC_CHANNEL, type DbhubEndpoint, type DbhubRpcResult } from '../shared/types.ts'
import type { DbhubService } from './settings.ts'

/** Wire envelope helpers used by both success and failure branches. */
function ok<T>(value: T): DbhubRpcResult<T> {
  return { ok: true, value }
}

function fail<T = never>(code: string, message: string): DbhubRpcResult<T> {
  return { ok: false, error: { code, message } }
}

/**
 * Route one endpoint call to the right DbhubService method. Returns
 * the wire envelope directly — never throws into the Connection RPC
 * machinery, which would surface as a less helpful infra-level error.
 *
 * Endpoint-to-method mapping:
 *   list            → service.list()                  (no payload)
 *   listTools       → service.listTools()             (no payload)
 *   save            → service.save(input)             (payload: DbhubConfig)
 *   testConnection  → service.testConnection(input)   (payload: DbhubTestInput)
 */
export async function dispatch(
  service: DbhubService,
  endpoint: string,
  payload: unknown,
): Promise<DbhubRpcResult<unknown>> {
  switch (endpoint as DbhubEndpoint) {
    case 'list':
      return ok(await service.list())

    case 'listTools':
      return ok(await service.listTools())

    case 'save':
      // Payload is the new DbhubConfig verbatim. The service method
      // validates it (assertValidDsn + duplicate-id check) and writes
      // via settings.replace; errors surface as `fail()` below.
      try {
        const value = await service.save(payload as Parameters<DbhubService['save']>[0])
        return ok(value)
      } catch (err) {
        return fail('save-failed', err instanceof Error ? err.message : String(err))
      }

    case 'testConnection':
      try {
        const value = await service.testConnection(
          payload as Parameters<DbhubService['testConnection']>[0],
        )
        return ok(value)
      } catch (err) {
        return fail('test-failed', err instanceof Error ? err.message : String(err))
      }

    default:
      return fail('unknown-endpoint', `dbhub: unknown endpoint "${endpoint}"`)
  }
}

/** Re-export so the entry can `import { RPC_CHANNEL } from './rpc.ts'`. */
export { RPC_CHANNEL }