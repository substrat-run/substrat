/**
 * The MCP surface, derived from the SAME declarations as the route table.
 *
 * A vertical already says everything a tool needs: `summary` is a sentence, `input`
 * is a real Zod object, `permission` is the key the operation checks, and `http` is
 * the statement that this operation faces the network at all. So this is a THIRD
 * rendering of one catalog — REST, OpenAPI, MCP — and not a second description of
 * anything. There is nothing to declare and nothing to keep in sync: a vertical that
 * mounts its operations has an MCP endpoint, zero rows of setup (#112).
 *
 * ## `http` is the declaration
 *
 * An operation with `http` becomes a tool; one without does not. That is the exact
 * boundary `mountOperations` already draws — a composed engine's in-scope operations
 * carry no `http`, because the engine is entity-agnostic and does not own a URL shape,
 * so the vertical decides theirs. An `mcp:` block in the model would restate a fact
 * `http` already carries, and would drift the first time a route was renamed.
 *
 * ## Exposure is not authorization
 *
 * Every tool maps to a route that already exists, behind the same bearer verification
 * and the same `assertAllowed(await ctx.check(…))` inside the operation. Anything an
 * agent can do here it could already do with `curl` and the same token, which is why
 * this can default ON without being a permission decision made by omission. It is a
 * rendering, not a new door.
 *
 * The corollary is the split this file draws between two kinds of failure:
 * **authentication** is transport-level (no principal ⇒ HTTP 401, which is what makes
 * a client start its OAuth flow), while **authorization** is in-band (`isError: true`
 * on the tool result, so the agent reads "you may not do that" and picks something
 * else instead of the whole session failing).
 *
 * ## What this does NOT solve
 *
 * Tool COUNT. ticket0 routes 59 operations, and its `desk-admin` role holds 16 of its
 * 19 permission keys — so filtering a tool list by what the caller may do would remove
 * almost nothing for the one persona most likely to hold an MCP client. Curation is
 * `mcp: false` today (declaration-time, "never a tool for anyone" — the recording and
 * service operations), and per-consumer app scoping later (#111), which is where a
 * COHERENT subset actually belongs: which tools a consumer needs is a fact about the
 * consumer, not about the operation or the caller.
 *
 * A permission filter is still worth having as a least-privilege floor — dramatic for
 * a narrow principal, marginal for an admin — but it needs a way to read a principal's
 * keys that `ScopeStub` does not have. The shape it would take already exists for
 * connectors (`grants(): Promise<PermissionKey[]>`, scope-host.ts). Left out here
 * deliberately: `tools/list` filtering is invisible to the protocol, so adding it
 * later breaks no client.
 */
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z, listPageQuery, LIST_SORT_PARAM } from '@substrat-run/contracts';
import type { ScopeStub } from '@substrat-run/kernel';
import { classifyError, messageOf } from './errors.js';

/**
 * The protocol revisions this server speaks, newest first.
 *
 * Negotiated rather than asserted: a client names the revision it wants, and a server
 * that does not speak it answers with its own latest instead of failing — the client
 * then decides whether to continue. Answering with the client's own string when we do
 * not implement it would be the lie that breaks them later.
 */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** The header a client uses to pin a negotiated revision on later requests. */
export const MCP_PROTOCOL_HEADER = 'MCP-Protocol-Version';

/** The `http` + tool fragment this derivation reads, structurally (see `HttpDecl`). */
interface McpDecl {
  readonly summary?: string;
  readonly permission?: string;
  readonly input?: z.ZodObject<z.ZodRawShape>;
  readonly output?: z.ZodType;
  readonly http?: { readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; readonly path: string };
  readonly paged?: { readonly sortKey?: string; readonly total?: boolean };
  /** `false` ⇒ never a tool. An object may enrich what the model is told. */
  readonly mcp?: false | { readonly description?: string };
}

/** One derived tool, plus what dispatching it needs. */
export interface McpTool {
  /** The MCP-safe name (`ticket0/get-desk` → `ticket0_get-desk`). */
  readonly name: string;
  /** The operation this dispatches to — the name `ScopeStub.invoke` takes. */
  readonly operation: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
  };
  /** Literal-valued input fields the model pins; a caller cannot talk the tool out of them. */
  readonly pinned: Record<string, unknown>;
  readonly paged: boolean;
  readonly takesInput: boolean;
}

/**
 * `ticket0/get-desk` → `ticket0_get-desk`.
 *
 * An operation name is a path (`module/verb`), and a tool name is matched by clients
 * against `^[a-zA-Z0-9_-]+$` — a `/` is rejected outright by some and silently mangled
 * by others. So the separator becomes `_` and every other out-of-class character with
 * it, while a HYPHEN is left alone: it is already in the class, and collapsing it too
 * would make `a/b-c` and `a/b_c` the same tool for no gain. The transform is still
 * lossy enough to collide, which is why the derivation checks (below) rather than
 * trusting that two operation names stay distinct through it.
 */
export function mcpToolName(operation: string): string {
  return operation.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

/**
 * Zod → JSON Schema, draft 2020-12, with the `$schema` key dropped (as `openapi.ts` does).
 *
 * **Degrades rather than throws**, and the reason is the call site: this runs inside
 * `mountOperations`, so a schema it cannot convert would stop a vertical from booting —
 * every route gone because one tool description could not be rendered. An optional
 * surface must never be able to do that. `mountOperations` reads `input` structurally
 * (`{ shape?: … }`) and several suites pass a plain object, which is legal there and
 * unconvertible here; a permissive schema is the honest answer for both.
 */
function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  // Zod 4 marks its own with `_zod`. Checked before converting because
  // `z.toJSONSchema` throws on anything else rather than returning a result.
  if (!(schema as { _zod?: unknown } | undefined)?._zod) return { type: 'object', properties: {} };
  try {
    const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }) as Record<
      string,
      unknown
    > & { $schema?: unknown };
    return rest;
  } catch {
    return { type: 'object', properties: {} };
  }
}

/** Zod's internal definition, read structurally — the same shape `operations-routes.ts` reads. */
function literalPins(input: z.ZodObject<z.ZodRawShape> | undefined): Record<string, unknown> {
  const shape = (input as unknown as { shape?: Record<string, unknown> } | undefined)?.shape;
  if (!shape) return {};
  const out: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(shape)) {
    const def = (schema as { _zod?: { def?: { type?: string; values?: unknown[]; value?: unknown } } })?._zod?.def;
    if (def?.type !== 'literal') continue;
    const values = def.values ?? (def.value === undefined ? undefined : [def.value]);
    if (Array.isArray(values) && values.length === 1) out[field] = values[0];
  }
  return out;
}

/**
 * The page trio, spelled into the tool's own schema.
 *
 * Over HTTP these ride in the query string and the mount supplies them; an MCP call has
 * no query string, so a paged read whose schema did not name them would look to an agent
 * like a list that returns everything. It then pulls the first page and concludes that
 * is the whole table — a wrong answer with no error anywhere, which is the failure mode
 * this platform spends the most effort refusing.
 */
function pageFields(sortKey: string | undefined): Record<string, unknown> {
  return {
    limit: { type: 'integer', description: 'How many entries to return. Capped by the platform.' },
    cursor: { type: 'string', description: 'Continue a previous page — the cursor it returned.' },
    order: { type: 'string', enum: ['asc', 'desc'], description: 'Walk direction.' },
    ...(sortKey === undefined
      ? {}
      : { [LIST_SORT_PARAM]: { type: 'string', description: `Sort column. Defaults to ${sortKey}.` } }),
  };
}

/**
 * Derive the tool list from a module's declared operations.
 *
 * Exported so a vertical can see what its MCP surface actually is — in a test, or in a
 * script that prints it — without standing up an HTTP server to ask.
 */
export function mcpToolsOf(operations: Readonly<Record<string, object>>): McpTool[] {
  const tools: McpTool[] = [];
  const byName = new Map<string, string>();

  for (const operation of Object.keys(operations).sort()) {
    const op = operations[operation] as McpDecl | undefined;
    // `http` is the declaration: no route, no tool. `mcp: false` is the opt-out.
    if (!op?.http || op.mcp === false) continue;

    const name = mcpToolName(operation);
    const clash = byName.get(name);
    if (clash) {
      throw new Error(
        `mcpToolsOf: '${operation}' and '${clash}' both render as the tool name '${name}' — ` +
          'operation names must stay distinct once non-alphanumerics collapse to `_`',
      );
    }
    byName.set(name, operation);

    const declared = op.input ? jsonSchemaOf(op.input) : { type: 'object', properties: {} };
    const shape = declared as { properties?: Record<string, unknown>; required?: string[] };
    const inputSchema: Record<string, unknown> = {
      ...declared,
      type: 'object',
      properties: {
        ...(shape.properties ?? {}),
        ...(op.paged ? pageFields(op.paged.sortKey) : {}),
      },
    };

    const method = op.http.method;
    tools.push({
      name,
      operation,
      // `summary` is written for an API document rather than for tool selection, so a
      // vertical may say more here. Neither is required: the default is the sentence
      // the operation already carries.
      description: (op.mcp && op.mcp.description) || op.summary || operation,
      inputSchema,
      annotations: {
        readOnlyHint: method === 'GET',
        destructiveHint: method === 'DELETE',
        idempotentHint: method === 'GET' || method === 'PUT' || method === 'DELETE',
      },
      pinned: literalPins(op.input),
      paged: Boolean(op.paged),
      takesInput: Boolean(op.input),
    });
  }
  return tools;
}

/**
 * A server name, derived rather than declared.
 *
 * Operation names are `module/verb`, so the module the vertical declares most of IS the
 * vertical's name — `ticket0/get-desk`, `ticket0/list-agents` ⇒ `ticket0`. One less
 * thing to pass, and it cannot drift from what the tools are actually called.
 */
function serverNameOf(tools: McpTool[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) {
    const prefix = t.operation.includes('/') ? t.operation.slice(0, t.operation.indexOf('/')) : t.operation;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  let best = 'substrat-vertical';
  let seen = 0;
  for (const [prefix, n] of counts) {
    if (n > seen) {
      best = prefix;
      seen = n;
    }
  }
  return best;
}

export interface MountMcpOptions {
  /** Where to mount. Defaults to `${basePath}/mcp` — i.e. `/api/mcp` on the fleet's convention. */
  readonly path?: string;
  /**
   * What the handshake reports. The name defaults to the module prefix the operations
   * share; a vertical that wants its real version passes it, since nothing in a
   * declaration knows one.
   */
  readonly serverInfo?: { readonly name?: string; readonly version?: string };
}

// ── JSON-RPC ─────────────────────────────────────────────────────────────────

type Id = string | number | null;
interface Req {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: Id, code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

/**
 * A tool result the MODEL can read.
 *
 * `structuredContent` without a declared `outputSchema` on purpose: a schema obliges the
 * server to return something matching it, and a paged read's declared `output` is the
 * ENTRY while the result is a `Page` — so publishing one would make a client's own
 * validation reject a correct answer. The text block is the compatibility half the spec
 * asks for; both carry the same value.
 */
function toolResult(value: unknown) {
  const structured = value !== null && typeof value === 'object' && !Array.isArray(value);
  return {
    content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }],
    structuredContent: structured ? (value as Record<string, unknown>) : { result: value ?? null },
  };
}

/** A refusal the AGENT should read and adapt to, rather than a transport failure. */
function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Mount the MCP endpoint for a module's operations.
 *
 * Called by `mountOperations`, so a vertical gets this without asking. Stateless
 * Streamable HTTP: one `POST` per JSON-RPC message, answered as `application/json`.
 * `GET` is a 405, which the transport explicitly permits for a server that opens no
 * server-to-client stream — this one has nothing to push, since every tool is a
 * request/response call into a scope.
 */
export function mountMcp(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  operations: Readonly<Record<string, object>>,
  resolveStub: (c: Context) => Promise<ScopeStub>,
  options: MountMcpOptions & { readonly basePath?: string } = {},
): { path: string; tools: number } {
  const tools = mcpToolsOf(operations);
  const path = options.path ?? `${options.basePath ?? '/api'}/mcp`;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const serverInfo = {
    name: options.serverInfo?.name ?? serverNameOf(tools),
    version: options.serverInfo?.version ?? '0',
  };

  /** Build the operation's input from the tool call's arguments. */
  const payloadOf = (tool: McpTool, args: Record<string, unknown>): Record<string, unknown> | undefined => {
    // Pins go in AFTER the caller's arguments, for the reason the route table gives:
    // a literal in the model is the model's statement, not a default a caller may edit.
    let payload: Record<string, unknown> = { ...args, ...tool.pinned };
    if (tool.paged) {
      // Parsed with the SAME schema the HTTP mount uses, so the default and the
      // `LIST_PAGE_MAX` ceiling are one definition rather than two (#811).
      const page = listPageQuery.parse({
        limit: payload['limit'],
        cursor: payload['cursor'],
        order: payload['order'],
      });
      payload = {
        ...payload,
        limit: page.limit,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        ...(page.order === undefined ? {} : { order: page.order }),
      };
    } else if (!tool.takesInput && Object.keys(payload).length === 0) {
      // An operation declaring no input takes `undefined`, and `z.object({})` cannot
      // say so — a handler typed for `undefined` would reject `{}`.
      return undefined;
    }
    return payload;
  };

  const call = async (c: Context, id: Id, params: Record<string, unknown> | undefined) => {
    // Authentication FIRST, before we say whether the tool exists. An anonymous call
    // throws an HTTPException, which travels out of this handler as a 401 so an MCP
    // client starts its authorization flow instead of reading a tool failure — and
    // answering "unknown tool" before that would let anyone with the URL enumerate
    // the surface by watching -32602 and 401 trade places.
    const stub = await resolveStub(c);

    const name = typeof params?.['name'] === 'string' ? (params['name'] as string) : undefined;
    const tool = name ? byName.get(name) : undefined;
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${name ?? '(none)'}`);

    const rawArgs = params?.['arguments'];
    const args = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

    try {
      const result = await stub.invoke(tool.operation, payloadOf(tool, args));
      return rpcResult(id, toolResult(result));
    } catch (err) {
      // Authorization is IN-BAND. A refused permission, a failed parse, a domain
      // error — the agent should read it and choose again, and a JSON-RPC error or
      // an HTTP status would instead look like the session itself is broken. A 401
      // is the one that must not be swallowed: it means "who are you", not "no".
      if (err instanceof HTTPException && err.status === 401) throw err;
      const seen = classifyError(err);
      if (seen?.status === 401) throw err;
      return rpcResult(id, toolError(seen ? seen.message : messageOf(err)));
    }
  };

  const handle = async (c: Context, msg: Req): Promise<object | null> => {
    const id = msg.id ?? null;
    const isNotification = msg.id === undefined;
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.['protocolVersion'];
        const version =
          typeof asked === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
            ? asked
            : MCP_PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion: version,
          // `listChanged: false` is the truth: the tool list is derived from
          // declarations fixed at deploy, so it cannot change under a live session.
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return isNotification ? null : rpcResult(id, {});
      case 'tools/list': {
        await resolveStub(c);
        return rpcResult(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          })),
        });
      }
      case 'tools/call':
        return await call(c, id, msg.params);
      default:
        return isNotification ? null : rpcError(id, -32601, `Method not found: ${msg.method ?? '(none)'}`);
    }
  };

  app.post(path, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, 'Parse error'), 400);
    }
    // Batching left the protocol in 2025-06-18 but earlier clients still send arrays,
    // and answering one is cheaper than explaining why we will not.
    const messages = Array.isArray(body) ? (body as Req[]) : [body as Req];
    if (messages.length === 0) return c.json(rpcError(null, -32600, 'Invalid Request'), 400);

    const replies: object[] = [];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') {
        replies.push(rpcError(null, -32600, 'Invalid Request'));
        continue;
      }
      const reply = await handle(c, msg);
      if (reply) replies.push(reply);
    }
    // Nothing to answer means every message was a notification: 202, no body.
    if (replies.length === 0) return c.body(null, 202);
    return c.json(Array.isArray(body) ? replies : (replies[0] as object));
  });

  // No server-initiated stream, so no SSE to open. The transport allows saying so.
  app.get(path, (c) => c.json(rpcError(null, -32601, 'This server opens no event stream'), 405));

  return { path, tools: tools.length };
}
