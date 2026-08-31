/**
 * Typed client for the `/dbhub` host RPC channel. Thin wrapper over
 * `ctx.connection.rpc.call` with the host's reply envelope.
 *
 * This file mirrors dsh-mcp-manager's `src/client/rpc.ts` pattern:
 *  - extract `ctx.connection.rpc` via a structural cast (the shipped
 *    client-connection types declare `ctx.connection` only on the host
 *    side, yet the browser plugin provides the same service at runtime);
 *  - on success, unwrap the envelope and return the typed `value`;
 *  - on failure, throw `DbhubRpcError` so the panel can catch and
 *    render the structured `code + message` instead of dealing with
 *    raw exception strings.
 *
 * @module @xcr1234/dsh-plugin-dbhub/client/rpc
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { RPC_CHANNEL, type DbhubEndpoint, type DbhubRpcResult } from '../shared/types.ts'

/**
 * Locally-mirrored `RpcResult<T>` shape — kept identical to the host's
 * envelope (`shared/types.ts: DbhubRpcResult`) so callers can pattern-
 * match without re-importing the host type. The matching is structural
 * so wire-format drift would surface immediately as a parse error.
 */
type RpcResult<T> = DbhubRpcResult<T>

/**
 * Pull `ctx.connection.rpc` out of the runtime client context. The
 * shipped `@deepseek-ai/dsh-client-connection` types only declare
 * `ctx.connection` on the host-side module; we cast structurally at
 * the boundary so the browser plugin (which doesn't import the host
 * types) can still call into the same service.
 */
function connectionRpcOf(ctx: ClientContext): ClientConnectionRpc {
  const connection = (ctx as unknown as { connection?: { rpc: ClientConnectionRpc } }).connection
  if (connection === undefined) {
    throw new Error('connection service is unavailable (is @deepseek-ai/dsh-client-connection loaded?)')
  }
  return connection.rpc
}

/** Error thrown by {@link callRpc} with the host's `code` and `message`. */
export class DbhubRpcError extends Error {
  readonly code: string
  readonly details: Record<string, unknown> | undefined

  constructor(error: { code: string; message: string; details?: Record<string, unknown> }) {
    super(`${error.code}: ${error.message}`)
    this.name = 'DbhubRpcError'
    this.code = error.code
    this.details = error.details
  }
}

/**
 * Call a host endpoint and return its typed value, throwing on failure.
 *
 * @param ctx - client root context (provides `ctx.connection`).
 * @param endpoint - RPC endpoint name from {@link DbhubEndpoint}.
 * @param payload - endpoint-specific payload (defaults to `null`).
 * @returns the endpoint's typed business `value`.
 */
export async function callRpc<T>(
  ctx: ClientContext,
  endpoint: DbhubEndpoint,
  payload?: unknown,
): Promise<T> {
  const raw = await connectionRpcOf(ctx).call(RPC_CHANNEL, endpoint, payload ?? null)
  const result = raw as unknown as RpcResult<T>
  if (result.ok) return result.value
  throw new DbhubRpcError(result.error)
}