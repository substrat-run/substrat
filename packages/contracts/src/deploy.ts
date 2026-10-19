import { z } from 'zod';
import { moduleId, permissionKey, scopeId, tenantId, verticalSlug } from './ids.js';
import { envVarSpec, capability, lifecycleHold, declaredEntityType, freshnessSpec, scheduleSpec, PLATFORM_BINDING_PREFIX, type ModuleManifest } from './manifest.js';
import { eventType } from './events.js';
import { roleDefinition, type RoleDefinition } from './permission.js';
import { RESERVED_STORE_OPERATIONS } from './scope-store-envelope.js';
import { declaredSurface } from './routing.js';
import { emittedModel } from './model.js';
import { scopeDumpTable } from './introspection.js';
import { substratError } from './errors.js';
import { blankReason } from './review-text.js';
import { SCOPE_STORE_CANARY, STORE_DRIVER_ID } from './script-names.js';
import { bindingShapeBreaks, bindingShapeRefusal } from './registry-diff.js';

// The deploy manifest is the JSON part a `substrat push` sends alongside the
// module files (self-serve-deploy.md). It lives here — not in the transport
// package — because BOTH ends must speak the same shape: the CLI builds and
// validates it before upload, the control plane re-parses it at the trust
// boundary and runs the §4 sandbox contract against the result. One schema,
// two parses, no drift.

/**
 * The runtime baseline a `runtimeNeeds` vertical builds against — the platform picks the
 * compatibility date, the builder never does. Advancing it is a platform release concern
 * (re-push under the new baseline), exactly like a kernel upgrade.
 *
 * MAINTAINED, not set-and-forget (#636): a stale baseline is the hand-copied-duplicate
 * disease D-38 exists to kill, one level up — while it sits still, hand-authored
 * wrangler-path dates advance past it, and the D-38 migration itself becomes a silent
 * compatibility DOWNGRADE for those verticals. Two guards hold the line mechanically:
 * a staleness test (packages/cli/test/push.test.ts) goes red when this date falls more
 * than ~6 months behind, and `resolveWranglerConfig` refuses a `runtimeNeeds` push whose
 * ignored wrangler.jsonc carries a NEWER date than this baseline. Keep advances a few
 * weeks behind today so builders' installed wrangler/workerd always know the date.
 */
export const RUNTIME_BASELINE = '2026-06-01';

/**
 * One of the vertical's OWN stores: a durable state class the code exports, reached in the
 * worker through `binding`. This is the substrate-vocabulary side of what the wire manifest
 * calls `doClasses` + a `durable_object_namespace` binding — the §4 sandbox contract already
 * guarantees a vertical binds nothing BUT its own stores, so own-stores is the entire
 * vocabulary; there is nothing else a builder could legitimately say.
 */
export const storeNeed = z.object({
  /** How the worker reaches it: `env.<binding>`. SCREAMING_SNAKE, like an env key. */
  binding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  /** The exported class implementing the store. */
  class: z.string().min(1),
});
export type StoreNeed = z.infer<typeof storeNeed>;

/**
 * A **per-tenant relational store** the platform provisions and hands to the vertical —
 * one independent SQL database *per tenant* (D1 on Cloudflare, a separate `.sqlite` file
 * on the pure adapter), reached in the worker through `binding` (#301). This is the third
 * distinct store shape, and the vocabulary keeps them apart on purpose:
 *
 * - `storeNeed` (own DO)          — the vertical's own durable class, one DO **per scope**.
 * - a static shared `d1` binding  — ONE database shared across every tenant (a build-time id).
 * - `tenantStoreNeed` (this)      — one platform-minted store **per tenant**. `relational`
 *   today on the wire; a blob is the same level, declared with `kind: 'blob'`
 *   (see `declaredTenantStore`).
 *
 * The load-bearing difference from a static `d1` binding: the builder supplies **no
 * database id**. The platform mints it per tenant in the tenant lifecycle and injects it,
 * which is what closes the ownership gap a bundle-chosen id left open (self-serve-deploy.md
 * §4, `control-plane-api/src/deploy.ts`). Because there is no id to declare, a per-tenant
 * store is a `runtimeNeeds` NEED, never a `declaredBinding` — nothing about it is bound
 * statically on the shared serving script.
 */
export const tenantStoreNeed = z.object({
  /** How the worker reaches this tenant's store: `host.tenantStore(tenantId, <binding>)`. */
  binding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  /**
   * The store shape on the wire. `relational` only: a blob travels in `blobStores`,
   * so a control plane from before the union still parses the manifest it is sent.
   */
  kind: z.literal('relational').default('relational'),
});
export type TenantStoreNeed = z.infer<typeof tenantStoreNeed>;

/**
 * A per-tenant store as a builder declares it (`runtimeNeeds.tenantStores`).
 *
 * `kind` defaults to `relational`, so a declaration that predates the union keeps
 * its meaning. `blob` is the same store as an entry in `blobStores` — that list
 * stays accepted, and {@link partitionDeclaredStores} reads both spellings into
 * one set. The deploy manifest does not: blobs still leave in `blobStores`.
 */
export const declaredTenantStore = z.object({
  binding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  kind: z.enum(['relational', 'blob']).default('relational'),
});
export type DeclaredTenantStore = z.infer<typeof declaredTenantStore>;

/**
 * A platform-minted per-tenant store, as handed to the vertical at provision (K-31) and
 * resolvable again at request time. `ref` is **opaque to the vertical**: a D1 `database_id`
 * on Cloudflare, a per-tenant `.sqlite` path token on the pure adapter. The vertical opens
 * it through the host (`openTenantStore`) and never parses it — that indirection is what
 * lets one vertical run unchanged against D1 in production and separate SQLite files locally.
 */
export const tenantStoreHandle = z.object({
  binding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  kind: z.literal('relational'),
  ref: z.string().min(1),
});
export type TenantStoreHandle = z.infer<typeof tenantStoreHandle>;

/**
 * The env name a tenant's store is bound under on the Cloudflare serving script (#301,
 * PR-2): `<BINDING>__<TENANTID>`. One convention, shared by its two ends — the control
 * plane derives it when attaching the D1 binding to the serving script, and the vertical
 * worker derives it to look the binding up (`env[tenantStoreBindingName(handle.binding,
 * tenantId)]` narrows to a `D1Database`). It lives in contracts precisely so neither side
 * hardcodes the other's half. A tenant id is a ULID (uppercase alphanumeric) and the
 * declared binding is SCREAMING_SNAKE, so the result is always a valid binding name; the
 * double underscore keeps it out of the single-underscore namespace a builder would use.
 * On the pure adapter there is no binding to name — the handle's `ref` is the whole reach.
 */
export function tenantStoreBindingName(binding: string, tenantId: string): string {
  return perTenantBindingName(binding, tenantId);
}

/**
 * The ONE encoding behind {@link tenantStoreBindingName} and {@link blobStoreBindingName}
 * (#1995). Both halves are checked rather than assumed: a ULID has no `_`, so
 * `<BINDING>__<ULID>` splits exactly one way and names exactly one tenant — but only if the
 * id IS a ULID. An unchecked join of `X__<another id>` would name a different binding than
 * the tenant it claims to be. Refused here, once, for every caller.
 */
function perTenantBindingName(binding: string, tenant: string): string {
  if (!BINDING_NAME.test(binding)) {
    throw new Error(`not a per-tenant binding name: '${binding}' (expected SCREAMING_SNAKE)`);
  }
  if (!tenantId.safeParse(tenant).success) {
    throw new Error(`not a tenant id: '${tenant}' — a per-tenant binding is named by a ULID only`);
  }
  return `${binding}__${tenant}`;
}

const BINDING_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * A **per-tenant blob store** the platform provisions and hands to the vertical (#473) —
 * an object store for attachment bytes (an R2 bucket on Cloudflare, a directory on the
 * pure adapter), reached in the worker through `binding`. The fourth store shape, same
 * ownership story as `tenantStoreNeed`: the builder supplies **no bucket id** — the
 * platform mints one per tenant in the tenant lifecycle and injects it, so a blob store
 * is a `runtimeNeeds` NEED, never a `declaredBinding`. (A hand-authored static
 * `r2_bucket` binding remains admissible under §4 as an own store — this exists so
 * attachment bytes don't have to ride one: per-tenant minting closes the shared-bucket
 * ownership gap, and per-SCOPE isolation inside the store is platform-derived key
 * prefixes constructed only in kernel/adapter code, never in module or route code.)
 */
export const blobStoreNeed = z.object({
  /** How the worker reaches this tenant's store: `env[blobStoreBindingName(binding, tenantId)]`. */
  binding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  /**
   * The store shape. Only `blob`. A new declaration should say
   * `tenantStores: [{ binding, kind: 'blob' }]` instead; this list stays so a
   * declaration already written keeps working.
   */
  kind: z.literal('blob').default('blob'),
});
export type BlobStoreNeed = z.infer<typeof blobStoreNeed>;

/**
 * A platform-minted per-tenant blob store, as handed over at provision (K-31). `ref` is
 * **opaque to the vertical**: an R2 bucket name on Cloudflare, a per-tenant directory
 * token on the pure adapter. The vertical never parses it — request-time reach is the
 * injected binding (Cloudflare) or the host's own resolution (pure adapter).
 */
export const blobStoreHandle = z.object({
  binding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  kind: z.literal('blob'),
  ref: z.string().min(1),
});
export type BlobStoreHandle = z.infer<typeof blobStoreHandle>;

/**
 * The env name a tenant's blob store is bound under on the Cloudflare serving script
 * (#473): `<BINDING>__<TENANTID>` — the same convention, and for the same reason, as
 * {@link tenantStoreBindingName}; the value narrows to an `R2Bucket` instead of a
 * `D1Database`. On the pure adapter there is no binding to name.
 */
export function blobStoreBindingName(binding: string, tenantId: string): string {
  return perTenantBindingName(binding, tenantId);
}

/**
 * The blob store attachment bytes live in (#1995). Fixed by the platform rather than named
 * by each vertical, because both ends of it are platform code: the push declares it for any
 * vertical whose modules declare `attachmentTargets` ({@link withAttachmentBlobStore}), and
 * the Cloudflare host resolves `env[blobStoreBindingName(ATTACHMENT_BLOB_BINDING, tenantId)]`
 * by itself. A vertical that had to remember either half was the defect: every deployed one
 * forgot both, and no upload could succeed on a hosted deploy.
 */
export const ATTACHMENT_BLOB_BINDING = 'ATTACHMENTS';

/** Whether any of these module manifests declares an attachment target (#1995). */
export function declaresAttachmentTargets(
  modules: readonly { readonly attachmentTargets?: readonly unknown[] }[],
): boolean {
  return modules.some((m) => (m.attachmentTargets?.length ?? 0) > 0);
}

/**
 * The blob stores a push declares (#1995): the vertical's own `runtimeNeeds.blobStores`, plus
 * {@link ATTACHMENT_BLOB_BINDING} when any module declares an attachment target — derived
 * from the same module manifests the permission surface is, so the need cannot drift from
 * the declaration that creates it. A hand-declared blob store of that name IS the attachment
 * store (the kind is a single literal), so it is kept once. The same declaration written
 * as `tenantStores: [{ binding: 'ATTACHMENTS', kind: 'blob' }]` is that store too: a raw
 * `RuntimeNeeds` still carries the blob there, and this function reads the kind rather
 * than treating every entry of that name as relational. A per-tenant RELATIONAL store
 * of that name is refused: it would be bound under the very `ATTACHMENTS__<tenant>` name the
 * host reads attachment bytes through. (A static binding of the name is the push's to refuse,
 * since only it reads the wrangler config those come from.)
 */
export function withAttachmentBlobStore(
  needs:
    | {
        readonly blobStores?: readonly BlobStoreNeed[];
        readonly tenantStores?: readonly { binding: string; kind?: 'relational' | 'blob' }[];
      }
    | undefined,
  /** {@link declaresAttachmentTargets} over the vertical's modules. */
  attaches: boolean,
): BlobStoreNeed[] {
  const stores = [...(needs?.blobStores ?? [])];
  for (const store of needs?.tenantStores ?? []) {
    if (store.kind !== 'blob') {
      if (store.binding === ATTACHMENT_BLOB_BINDING) {
        throw new Error(
          `runtimeNeeds.tenantStores declares '${ATTACHMENT_BLOB_BINDING}', the binding the platform keeps for ` +
            `attachment bytes (#1995) — rename that store; attachments need no declaration of their own`,
        );
      }
      continue;
    }
    if (!stores.some((kept) => kept.binding === store.binding)) {
      stores.push({ binding: store.binding, kind: 'blob' });
    }
  }
  if (attaches && !stores.some((s) => s.binding === ATTACHMENT_BLOB_BINDING)) {
    stores.push({ binding: ATTACHMENT_BLOB_BINDING, kind: 'blob' });
  }
  return stores;
}

/**
 * How the runtime routes a request between the vertical's STATIC files and its worker
 * (#340) — the substrate-vocabulary form of Cloudflare's `assets.config`. Every field is
 * optional with a runtime default, so a vertical that only wants "serve my SPA" declares
 * a directory and nothing else.
 *
 * The two that matter for a Substrat vertical, and why:
 * - `notFoundHandling: 'single-page-application'` — a deep client route (`/jobs/123`) is
 *   not a file, and must resolve to `index.html` rather than 404. This is the inline
 *   `serveAsset` fallback, expressed as configuration.
 * - `runWorkerFirst` — SPA fallback would otherwise swallow the vertical's OWN routes,
 *   which are not files either. Listing `/api/*` + `/internal/*` keeps the worker in
 *   front of exactly the paths it owns while everything else is served from the edge
 *   without invoking it. `true` runs the worker in front of every request (asset serving
 *   still happens behind it) — correct only for a vertical that inspects every path.
 */
export const assetRouting = z.object({
  /** Trailing-slash/`.html` normalisation. Cloudflare's default is `auto-trailing-slash`. */
  htmlHandling: z
    .enum(['auto-trailing-slash', 'force-trailing-slash', 'drop-trailing-slash', 'none'])
    .optional(),
  /** What a path matching no asset gets. `none` (default) falls through to the worker. */
  notFoundHandling: z.enum(['none', '404-page', 'single-page-application']).optional(),
  /** Routes the worker handles BEFORE asset matching — `true` for all, or a glob list. */
  runWorkerFirst: z.union([z.boolean(), z.array(z.string().min(1)).min(1)]).optional(),
});

/**
 * Prefixes the PLATFORM routes worker-first, whatever a vertical declared.
 *
 * A `.well-known` URI is a protocol surface — RFC 8615 reserves it for exactly that —
 * so a SPA must never answer one. Left to the vertical this is a rule that rots: the
 * MCP surface (#112) mounts `/.well-known/oauth-protected-resource/*` because RFC 9728
 * requires it at the origin root, ticket0's manifest did not list it, and the asset
 * layer served `index.html` from the edge without ever invoking the worker. The route
 * was registered correctly and unreachable, which no lint or test can see: it fails one
 * layer below the code, in production only.
 *
 * So the platform adds it rather than asking. A vertical that mounts nothing there is
 * unaffected — its own catch-all answers 404, which is what the asset layer would have
 * said anyway.
 */
export const PLATFORM_WORKER_FIRST_PREFIXES = ['/.well-known/*'] as const;

export type AssetRouting = z.infer<typeof assetRouting>;

/**
 * The vertical's STATIC files, as a NEED (#340): a directory of built bytes the platform
 * uploads to the runtime's own asset store, served from the edge without invoking the
 * worker. Native assets are not a binding — they are a top-level upload path — so this is
 * a `runtimeNeeds` need and never rides the §4 binding allowlist (see
 * {@link ADMISSIBLE_BINDING_TYPES}); the platform's own hash verification is what makes
 * accepting builder-supplied bytes safe (self-serve-deploy.md §4.1).
 *
 * Replaces the inline-into-the-worker workaround every demo carried while WfP dispatch had
 * no asset path: base64 in the bundle costs ~+33 % against the script-size limit, is
 * re-parsed on every cold start, and invokes the worker for every image.
 */
export const assetsNeed = assetRouting.extend({
  /** Directory of built files, relative to the vertical root (e.g. `app/dist`). */
  directory: z.string().min(1),
});
export type AssetsNeed = z.infer<typeof assetsNeed>;

// The reserved operations live beside the envelope that admits them, a module that imports nothing.
export { RESERVED_STORE_OPERATIONS, type ReservedStoreOperation } from './scope-store-envelope.js';

/** The operations a vertical may invoke on a scope store. No `substrat.*` name belongs here. */
export interface StoreOperationCatalog {
  readonly operations: readonly string[];
}

/** The longest store operation name (#2207 §6). */
export const STORE_OPERATION_NAME_MAX = 64;

/**
 * A store operation name is a fixed label (#2207 §6): no `@`, no whitespace, no `:`,
 * at most {@link STORE_OPERATION_NAME_MAX} characters. The name goes on an invocation
 * line tenant members can read, so a name built from input (`lookup:<email>`) is
 * refused rather than logged. The reserved `substrat.*` names are labels too.
 */
export const storeOperationName = z
  .string()
  .min(1)
  .max(STORE_OPERATION_NAME_MAX)
  .regex(/^[^@:\s]+$/, { message: 'a store operation name is a fixed label: no @, no whitespace, no :' });

const storeCatalogOperation = storeOperationName.refine((name) => !name.startsWith('substrat.'), {
    message: 'a catalog operation cannot use the substrat. prefix — those names are the platform’s',
  });

/** A store driver id: `[a-z0-9]+` (RFC scope-stores §10.7, L20). Part of every store script name. */
export const storeDriverId = z.string().regex(STORE_DRIVER_ID, { message: 'a store driver id is [a-z0-9]+' });

/**
 * One pinned release of a store driver (D-63): the sha256 of the release bundle, which the
 * platform checks at every upload, and the source commit the bundle was built from, which a
 * reviewer reads. The digest is {@link storeDriverReleaseDigest} over the bundle's modules and the
 * module the entry imports.
 *
 * `schema` is the version of the stored data the release migrates an object to when it wakes
 * (D-63, "Rollback against a migrated schema"; proposed in #2300, for the maintainer to confirm).
 * The platform never moves a script to a release with a lower `schema` than the one it leaves:
 * not by a rollout, a rollback, or the restore after a failed rollout. A driver's migrations are
 * forward-only, so a release that changes the stored shape raises it.
 */
export const storeDriverRelease = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/, { message: 'a release sha256 is 64 lowercase hex' }),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/, { message: 'a release source commit is 40 lowercase hex' }),
    schema: z.number().int({ message: 'a release schema is an integer' }).nonnegative({ message: 'a release schema is not negative' }),
  })
  .strict();
export type StoreDriverRelease = z.infer<typeof storeDriverRelease>;

/**
 * A store driver, registered in this repo and pinned (D-63): every release the platform may run,
 * the class it runs, the catalog a vertical may call, and every reserved operation. A release is
 * pinned by a reviewed change to this list, and a pin is never removed, a superseded release
 * included. The list itself is {@link STORE_DRIVERS}. Empty until a driver is reviewed in.
 */
export const storeDriverRegistration = z.object({
  // Held to the driver-id grammar first (L20), so a second driver cannot be added outside it.
  driver: storeDriverId.pipe(z.literal('graph')),
  releases: z
    .array(storeDriverRelease)
    .min(1)
    .refine((releases) => new Set(releases.map((r) => r.sha256)).size === releases.length, {
      message: 'a release is pinned once',
    }),
  // No script name: the platform names the upload `scopeStoreScriptName(vertical, driver)`.
  className: z.string().min(1),
  operations: z.array(storeCatalogOperation),
  platformOperations: z.array(z.enum(RESERVED_STORE_OPERATIONS)).refine(
    (ops) => RESERVED_STORE_OPERATIONS.every((op) => ops.includes(op)),
    { message: 'a store driver answers every reserved operation, including substrat.erase' },
  ),
});
export type StoreDriverRegistration = z.infer<typeof storeDriverRegistration>;

/**
 * Registered store drivers. None yet: a driver is registered by its id once the approval
 * flow in docs/rfc/store-driver-release-approval.md has replaced per-release pins (its step 5),
 * and a third-party driver such as graph also waits for a decision record lifting D-63's
 * isolation requirement for it (#2210, #2394).
 */
export const STORE_DRIVERS: readonly StoreDriverRegistration[] = [];

/** The most module bytes one release bundle may carry (#2300), decoded. A bigger upload is 413. */
export const STORE_RELEASE_MAX_BYTES = 10 * 1024 * 1024;

/** The most modules one release bundle may carry (#2300, #2390). A bigger upload is 422. */
export const STORE_RELEASE_MAX_MODULES = 1000;

/**
 * A driver's own module: one top-level package that starts with `driver_`, then identifiers,
 * ending in `.py`. The prefix keeps it off every name the Python entry imports or the runtime
 * provides.
 */
const PYTHON_DRIVER_MODULE = /^(driver_[a-z0-9_]+)(?:\/[A-Za-z_][A-Za-z0-9_]*)*\/[A-Za-z_][A-Za-z0-9_]*\.py$/;

/** One segment of a vendored path: no empty segment, no `.` or `..`, no leading dot. */
const VENDORED_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;

/**
 * Python 3.13's standard library, as `sys.stdlib_module_names` lists it: the Python the store
 * entry's compatibility date selects (Pyodide 3.13.2, whose list is CPython 3.13's). A vendored
 * copy of one of these could shadow the module the entry, its verifier glue or the runtime
 * imports. Hand-copied, and held to the runtime by `packages/store-entry-python/probe.mjs`, which
 * asks the running worker for its own list and for every top-level module it has loaded.
 */
const PYTHON_STDLIB_MODULES: readonly string[] = (
  '__future__ _abc _aix_support _android_support _apple_support _ast _asyncio _bisect _blake2 _bz2 _codecs _codecs_cn _codecs_hk ' +
  '_codecs_iso2022 _codecs_jp _codecs_kr _codecs_tw _collections _collections_abc _colorize _compat_pickle _compression ' +
  '_contextvars _csv _ctypes _curses _curses_panel _datetime _dbm _decimal _elementtree _frozen_importlib ' +
  '_frozen_importlib_external _functools _gdbm _hashlib _heapq _imp _interpchannels _interpqueues _interpreters _io ' +
  '_ios_support _json _locale _lsprof _lzma _markupbase _md5 _multibytecodec _multiprocessing _opcode _opcode_metadata ' +
  '_operator _osx_support _overlapped _pickle _posixshmem _posixsubprocess _py_abc _pydatetime _pydecimal _pyio _pylong ' +
  '_pyrepl _queue _random _scproxy _sha1 _sha2 _sha3 _signal _sitebuiltins _socket _sqlite3 _sre _ssl _stat _statistics ' +
  '_string _strptime _struct _suggestions _symtable _sysconfig _thread _threading_local _tkinter _tokenize _tracemalloc ' +
  '_typing _uuid _warnings _weakref _weakrefset _winapi _wmi _zoneinfo abc antigravity argparse array ast asyncio atexit ' +
  'base64 bdb binascii bisect builtins bz2 cProfile calendar cmath cmd code codecs codeop collections colorsys compileall ' +
  'concurrent configparser contextlib contextvars copy copyreg csv ctypes curses dataclasses datetime dbm decimal difflib ' +
  'dis doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib ' +
  'functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib ' +
  'importlib inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox marshal math mimetypes ' +
  'mmap modulefinder msvcrt multiprocessing netrc nt ntpath nturl2path numbers opcode operator optparse os pathlib pdb ' +
  'pickle pickletools pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr ' +
  'pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select ' +
  'selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 sre_compile sre_constants sre_parse ssl ' +
  'stat statistics string stringprep struct subprocess symtable sys sysconfig syslog tabnanny tarfile tempfile termios ' +
  'textwrap this threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo ' +
  'types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xml ' +
  'xmlrpc zipapp zipfile zipimport zlib zoneinfo'
).split(' ');

/**
 * The top-level names a vendored path may not take (#2390), each with why. A path's top-level
 * name is its first segment under `python_modules/` up to the first `.` or `-`, so a package
 * directory, a module, a compiled extension and a distribution's metadata all read as the name
 * they would be imported or installed as: `workers/`, `workers.py`, `workers.cpython-312.so` and
 * `workers_runtime_sdk-1.9.3.dist-info` are `workers`, `workers`, `workers` and
 * `workers_runtime_sdk`. A `prefix` row refuses every name that starts with one of its `names`.
 */
const PYTHON_VENDORED_RESERVED: readonly { readonly match: 'name' | 'prefix'; readonly names: readonly string[]; readonly why: string }[] = [
  { match: 'prefix', names: ['driver_'], why: 'it takes the driver package prefix' },
  { match: 'prefix', names: ['substrat_'], why: "it takes the entry's prefix" },
  // The SDK's own files, as workers-runtime-sdk 1.9 installs them: its package, the `asgi` module
  // beside it, its patch loader and the two stubs it ships for the runtime's private modules.
  { match: 'name', names: ['workers', 'workers_runtime_sdk', 'workers_py', 'asgi'], why: "it is the workers runtime SDK, which is the platform's runtime, not a vendored copy" },
  { match: 'prefix', names: ['_workers_sdk', '_cloudflare'], why: "it is the workers runtime SDK, which is the platform's runtime, not a vendored copy" },
  { match: 'name', names: ['js', 'pyodide', 'pyodide_js'], why: 'the Python workers runtime provides it' },
  { match: 'prefix', names: ['_pyodide'], why: 'the Python workers runtime provides it' },
  { match: 'name', names: ['__main__', 'sitecustomize', 'usercustomize'], why: 'the interpreter runs it when it starts' },
  { match: 'name', names: PYTHON_STDLIB_MODULES, why: "it is in Python's standard library" },
  // `sysconfig`'s data module, named for the platform (`_sysconfigdata__emscripten_wasm32-emscripten`
  // under Pyodide), so it is not in `sys.stdlib_module_names`. The probe found the runtime loads it.
  { match: 'prefix', names: ['_sysconfigdata'], why: "it is in Python's standard library" },
];
const PYTHON_VENDORED_RESERVED_NAMES = new Map(
  PYTHON_VENDORED_RESERVED.filter((row) => row.match === 'name').flatMap((row) => row.names.map((name) => [name, row.why] as const)),
);
const PYTHON_VENDORED_RESERVED_PREFIXES = PYTHON_VENDORED_RESERVED.filter((row) => row.match === 'prefix').flatMap((row) =>
  row.names.map((prefix) => [prefix, row.why] as const),
);

/** The file names a vendored path may not end in, each with why: installer output, not a dependency. */
const PYTHON_VENDORED_FILES: readonly { readonly match: 'name' | 'suffix'; readonly names: readonly string[]; readonly why: string }[] = [
  { match: 'suffix', names: ['.pth'], why: 'a path file runs code when the interpreter starts' },
  { match: 'name', names: ['pyvenv.cfg'], why: "it is a virtual environment's marker" },
  { match: 'suffix', names: ['.synced'], why: "it is an installer's sync marker" },
];

export type PythonStoreModuleClass = { readonly kind: 'driver'; readonly packageName: string } | { readonly kind: 'vendored' };

function refusePythonStoreModule(name: string, why: string): never {
  throw new Error(`a store driver release may not ship a module named '${name}': ${why}`);
}

/**
 * Which kind of module a Python store-driver release is shipping (#2390).
 *
 * The driver's own code is one `driver_<package>/…/<module>.py` file. Beside that package a
 * release may carry `python_modules/<path>`, the driver's dependencies, which the upload sends
 * as Data modules under the same names. Refused: a path that climbs (`..`), is absolute, or
 * contains a backslash; a vendored top-level name in {@link PYTHON_VENDORED_RESERVED}; a vendored
 * file in {@link PYTHON_VENDORED_FILES}.
 *
 * The script imports `workers` from the Python workers runtime the upload selects, not from a
 * copy in the bundle. A lock file is not a module here.
 */
export function classifyPythonStoreModule(name: string): PythonStoreModuleClass {
  if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    refusePythonStoreModule(name, 'a path is relative and uses no backslash');
  }
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    refusePythonStoreModule(name, 'a path does not climb out of the release');
  }
  const driver = PYTHON_DRIVER_MODULE.exec(name);
  if (driver) return { kind: 'driver', packageName: driver[1]! };
  if (!name.startsWith('python_modules/')) {
    refusePythonStoreModule(name, 'a driver module is driver_<package>/…/<module>.py, or a dependency is python_modules/<path>');
  }
  const rest = parts.slice(1);
  const top = rest[0]!.split(/[.-]/)[0]!;
  const reserved = PYTHON_VENDORED_RESERVED_NAMES.get(top) ?? PYTHON_VENDORED_RESERVED_PREFIXES.find(([prefix]) => top.startsWith(prefix))?.[1];
  if (reserved) refusePythonStoreModule(name, `a vendored path may not take the top-level name '${top}': ${reserved}`);
  const file = rest[rest.length - 1]!;
  const installer = PYTHON_VENDORED_FILES.find((row) =>
    row.names.some((fileName) => (row.match === 'name' ? file === fileName : file.endsWith(fileName))),
  );
  if (installer) refusePythonStoreModule(name, installer.why);
  if (!rest.every((part) => VENDORED_SEGMENT.test(part))) {
    refusePythonStoreModule(name, 'a vendored path is relative segments');
  }
  return { kind: 'vendored' };
}

/**
 * A release bundle as `substrat store-driver upload` sends it (#2300): the commit it was built from,
 * the module the platform's entry imports, and every module, base64. The control plane stores it
 * keyed by its {@link storeDriverReleaseDigest}, which it computes itself. Module names are judged
 * by {@link classifyPythonStoreModule} when the bundle arrives, the same rule its upload applies.
 */
export const storeDriverReleaseUpload = z
  .object({
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/, { message: 'a release source commit is 40 lowercase hex' }),
    entry: z.string().min(1),
    modules: z
      .array(z.object({ name: z.string().min(1), contentBase64: z.string() }).strict())
      .min(1)
      .max(STORE_RELEASE_MAX_MODULES),
  })
  .strict();
export type StoreDriverReleaseUpload = z.infer<typeof storeDriverReleaseUpload>;

/** The domain tag a release digest starts with. Another framing is another tag, and a pin migration. */
export const STORE_RELEASE_DIGEST_TAG = 'substrat.store-release/v1';

/** A name inside a release digest: printable ASCII, no space, so no NUL and no encoding choice. */
const RELEASE_DIGEST_NAME = /^[\x21-\x7e]+$/;

/**
 * The sha256 that pins a store driver's release (D-63), as lowercase hex. It covers everything that
 * decides what runs, apart from the class the registration names: the module the platform's
 * entry imports, and every module's name and bytes, a vendored `python_modules/` file included.
 * Framed as {@link STORE_RELEASE_DIGEST_TAG}
 * and one zero byte, the entry's name and one zero byte, then each module in name order: its
 * name, one zero byte, its length as an unsigned 64-bit big-endian integer, then its exact bytes.
 * A vendored `python_modules/` module is a module, so its name and bytes are covered the same way.
 *
 * The framing is what makes the digest name one release, so its preconditions are held here,
 * not left to a caller: every name (the entry's included) is non-empty printable ASCII without
 * a space. A NUL would let one name absorb the next module's frame, and a lone surrogate encodes
 * to the same bytes as U+FFFD, so either would let two releases share a digest. ASCII also makes
 * the sort below (UTF-16 code units) the byte order, so a pin computed outside JavaScript agrees.
 * A module named twice is refused, and so is an entry that is not one of the modules.
 */
export async function storeDriverReleaseDigest(release: {
  readonly entry: string;
  readonly modules: readonly { readonly name: string; readonly content: Uint8Array }[];
}): Promise<string> {
  const encode = (name: string) => {
    if (!RELEASE_DIGEST_NAME.test(name)) {
      throw new Error(`a release name must be printable ASCII without spaces: ${JSON.stringify(name)}`);
    }
    return new TextEncoder().encode(name);
  };
  const zero = new Uint8Array([0]);
  const parts: Uint8Array[] = [encode(STORE_RELEASE_DIGEST_TAG), zero, encode(release.entry), zero];
  if (!release.modules.some((module) => module.name === release.entry)) {
    throw new Error(`a release's entry '${release.entry}' is not one of its modules`);
  }
  const sorted = [...release.modules].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const [i, module] of sorted.entries()) {
    if (i > 0 && sorted[i - 1]!.name === module.name) throw new Error(`a release ships '${module.name}' twice`);
    const name = encode(module.name);
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(module.content.byteLength));
    parts.push(name, zero, length, module.content);
  }
  const framed = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    framed.set(part, offset);
    offset += part.byteLength;
  }
  const hash = await crypto.subtle.digest('SHA-256', framed);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether a version's stored manifest (`HostAdmin.versionManifest`) declares a scope
 * store (#2242). `null` is a version pushed before manifests were kept, which is before
 * scope stores, so it declares none. `undefined` is returned when the JSON cannot be
 * read as a stored manifest: the caller cannot tell, and must not read that as "none".
 */
export function scopeStoresDeclaredIn(manifestJson: string | null): boolean | undefined {
  if (manifestJson === null) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(manifestJson);
  } catch {
    return undefined;
  }
  const parsed = storedDeployManifest.safeParse(raw);
  return parsed.success ? parsed.data.scopeStores.length > 0 : undefined;
}

/**
 * Whether the deployment running a version may hold a scope store — the gate subject
 * erasure fails closed on (#2242). A push declaring an unregistered driver is refused, so
 * with no driver in `drivers` nothing can hold one: false, and erasure proceeds as it did
 * before stores existed. Otherwise true when the manifest declares a store, or when it
 * is unknown (`undefined`: no version can be named, or it could not be read) or cannot
 * be parsed. False for a manifest that declares none, and for `null`, a version pushed
 * before manifests (and so stores) existed.
 */
export function mayHoldScopeStores(
  manifestJson: string | null | undefined,
  drivers: readonly StoreDriverRegistration[] = STORE_DRIVERS,
): boolean {
  if (drivers.length === 0) return false;
  if (manifestJson === undefined) return true;
  return scopeStoresDeclaredIn(manifestJson) ?? true;
}

/**
 * A platform-run object, one per scope (#2207). The builder names the binding and the
 * driver. The driver has no default. A scope store adds no binding to the vertical's upload
 * (RFC scope-stores §10.7, L1): the vertical reaches it only through the platform's hop.
 *
 * The field was `kind` until K-53's rename, with no alias: no vertical ever stored a scope
 * store, since none could be registered. A declaration still spelling `kind` is refused
 * with that rename named, rather than as a missing `driver` beside a silently dropped key.
 */
export const SCOPE_STORE_KIND_RENAMED = 'scopeStores[].kind was renamed driver: declare { binding, driver }';
export const scopeStoreNeed = z.object({
  binding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  driver: z.literal('graph'),
  kind: z.never({ message: SCOPE_STORE_KIND_RENAMED }).optional(),
});
export type ScopeStoreNeed = z.infer<typeof scopeStoreNeed>;

/** The env name the platform binds a scope store under. */
export function scopeStoreBindingName(binding: string): string {
  if (!BINDING_NAME.test(binding)) {
    throw new Error(`not a scope-store binding name: '${binding}' (expected SCREAMING_SNAKE)`);
  }
  return `${PLATFORM_BINDING_PREFIX}STORE_${binding}`;
}

/**
 * The object name the host builds (#2207). The vertical names a binding; the host
 * names the object, from the tenant and scope it has just checked and the vertical
 * the scope runs. Tenant, scope and binding contain no `/`. A vertical slug may,
 * and it sits between the two ids, so the name still splits one way.
 */
export function scopeStoreObjectName(tenantId: string, vertical: string, scopeId: string, binding: string): string {
  return `${tenantId}/${vertical}/${scopeId}/${binding}`;
}

/**
 * The object a release is canaried on (D-63, #2300), in the driver's canary script. Its vertical
 * segment is {@link SCOPE_STORE_CANARY}, which no vertical slug is, so no route a tenant reaches
 * names it; the tenant and scope ids are fresh for each canary and never in the directory.
 */
export function scopeStoreCanaryObjectName(tenantId: string, scopeId: string, binding: string): string {
  return scopeStoreObjectName(tenantId, SCOPE_STORE_CANARY, scopeId, binding);
}

/** `{ operation, input }` over the store's fetch. */
export const storeRequest = z.object({
  operation: storeOperationName,
  input: z.unknown().optional(),
});
export type StoreRequest = z.infer<typeof storeRequest>;

/** What a store answers when it refuses. `code` is the driver's, `status` is an HTTP
 *  error status: anything outside 400–599 is not a refusal, and not this envelope. */
export const storeErrorEnvelope = z.object({
  code: z.string().min(1),
  status: z.number().int().min(400).max(599),
  body: z.unknown().optional(),
});

/** `{ result }` or `{ error }`. Anything else is not this envelope. */
export const storeResponse = z.union([
  z.object({ result: z.unknown() }).strict(),
  z.object({ error: storeErrorEnvelope }).strict(),
]);
export type StoreResponse = z.infer<typeof storeResponse>;

/**
 * What each reserved operation takes and answers (#2207). The result schemas are
 * objects so a later field is additive. `import` replaces the whole object and
 * answers how many tables it wrote.
 */
export const storeSizeResult = z.object({ bytes: z.number().int().nonnegative() });
export type StoreSizeResult = z.infer<typeof storeSizeResult>;

export const storeEraseInput = z.object({ subjectId: z.string().min(1) });
export const storeEraseResult = z.object({ erased: z.number().int().nonnegative() });
export type StoreEraseResult = z.infer<typeof storeEraseResult>;

export const storeExportResult = z.object({ tables: z.array(scopeDumpTable) });
export type StoreExportResult = z.infer<typeof storeExportResult>;

export const storeImportInput = z.object({ tables: z.array(scopeDumpTable) });
export const storeImportResult = z.object({ tables: z.number().int().nonnegative() });
export type StoreImportResult = z.infer<typeof storeImportResult>;

export const storeWipeResult = z.object({});
export type StoreWipeResult = z.infer<typeof storeWipeResult>;

/**
 * What each reserved operation answers, parsed (#2239). A plain map of the result
 * types, so a package that names one (the kernel's `callReservedStoreOperation`)
 * publishes no zod type of its own.
 */
export interface ReservedStoreResults {
  'substrat.export': StoreExportResult;
  'substrat.import': StoreImportResult;
  'substrat.size': StoreSizeResult;
  'substrat.wipe': StoreWipeResult;
  'substrat.erase': StoreEraseResult;
}

/** One binding's storage, as `scopeStoreSizes` reports it. */
export const scopeStoreSize = z.object({
  binding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  bytes: z.number().int().nonnegative(),
});
export type ScopeStoreSize = z.infer<typeof scopeStoreSize>;

/**
 * What a vertical needs from the runtime, in substrate vocabulary (package.json
 * `substrat.runtimeNeeds`). A vertical authored with this section never writes deploy
 * config for a specific substrate — the CLI derives that at push time (D-38: builders
 * keep the substrate vocabulary; the Cloudflare mapping lives behind the platform).
 * A single shared relational database is still not bundle-declarable here; a PER-TENANT
 * relational store is, via `tenantStores` — the platform provisions it (self-serve-deploy.md
 * §4), so the vertical declares the NEED and never a database id.
 */
export const runtimeNeeds = z.object({
  /** The worker entry module, relative to the vertical root (e.g. `src/worker.ts`). */
  entry: z.string().min(1),
  /** Needs Node built-ins at runtime (crypto/streams shims — e.g. Better Auth). */
  needsNodeCompat: z.boolean().default(false),
  /** Command to run before bundling (SPA build, asset generation). Runs in the vertical root. */
  build: z.string().min(1).optional(),
  stores: z.array(storeNeed).default([]),
  /** One platform-run object per scope (#2207). `driver` has no default: it is the
   *  choice, and the only driver until a second one asks to widen the literal. A push
   *  of a driver with no registration is refused ({@link assertDeclaredScopeStores}). */
  scopeStores: z.array(scopeStoreNeed).default([]),
  /** Per-tenant stores the platform provisions (#301, #473). `kind` defaults to
   *  `relational`. `blob` is the same declaration as an entry in `blobStores`.
   *  NOT bound statically — there is one database or bucket per tenant, minted in
   *  the tenant lifecycle rather than at deploy. */
  tenantStores: z.array(declaredTenantStore).default([]),
  /** @deprecated Declare `tenantStores` with `kind: 'blob'` instead. Still accepted,
   *  and read into the same set ({@link partitionDeclaredStores}). */
  blobStores: z.array(blobStoreNeed).default([]),
  /** Static files served from the edge (#340). Absent ⇒ the vertical serves no static
   *  files (or still inlines them into the bundle), and nothing about its push changes. */
  assets: assetsNeed.optional(),
});
export type RuntimeNeeds = z.infer<typeof runtimeNeeds>;

/**
 * The two builder spellings of a per-tenant store, as one set (#2221).
 *
 * A `blob` entry in `tenantStores` and an entry in `blobStores` are the same
 * declaration. A binding named twice — in one list, or across them — is refused:
 * both would be bound as `<BINDING>__<tenant>` on the serving script, and nothing
 * else compares the two lists (except the reserved `ATTACHMENTS` name).
 */
export function partitionDeclaredStores(
  needs: { readonly tenantStores?: readonly DeclaredTenantStore[]; readonly blobStores?: readonly BlobStoreNeed[] } | undefined,
): { tenantStores: TenantStoreNeed[]; blobStores: BlobStoreNeed[] } {
  const tenantStores: TenantStoreNeed[] = [];
  const blobStores: BlobStoreNeed[] = [];
  const seen = new Map<string, string>();
  const claim = (binding: string, where: string) => {
    const prior = seen.get(binding);
    if (prior !== undefined) {
      throw new Error(
        `runtimeNeeds declares the per-tenant binding '${binding}' twice (${prior}, and ${where}). ` +
          `One name is one store: both would be bound as ${binding}__<tenant> on the serving script.`,
      );
    }
    seen.set(binding, where);
  };
  for (const store of needs?.tenantStores ?? []) {
    if (store.kind === 'blob') {
      claim(store.binding, `tenantStores kind 'blob'`);
      blobStores.push({ binding: store.binding, kind: 'blob' });
    } else {
      claim(store.binding, 'tenantStores');
      tenantStores.push({ binding: store.binding, kind: 'relational' });
    }
  }
  for (const store of needs?.blobStores ?? []) {
    claim(store.binding, 'blobStores');
    blobStores.push({ binding: store.binding, kind: 'blob' });
  }
  return { tenantStores, blobStores };
}

/**
 * What a push puts on the deploy manifest for per-tenant stores. Relational entries
 * stay in `tenantStores`. Blobs, whichever spelling declared them, stay in `blobStores`,
 * plus the attachment store when the modules declare a target. An older control plane
 * therefore reads the same manifest it reads today.
 */
export function manifestStoresOf(
  needs: { readonly tenantStores?: readonly DeclaredTenantStore[]; readonly blobStores?: readonly BlobStoreNeed[] } | undefined,
  /** {@link declaresAttachmentTargets} over the vertical's modules. */
  attaches: boolean,
): { tenantStores: TenantStoreNeed[]; blobStores: BlobStoreNeed[] } {
  const declared = partitionDeclaredStores(needs);
  return {
    tenantStores: declared.tenantStores,
    blobStores: withAttachmentBlobStore(declared, attaches),
  };
}

/**
 * Whether `name` is the binding a per-tenant store is injected as
 * ({@link tenantStoreBindingName}): `<BINDING>__<tenant>`. The declared spelling
 * `DB` is a different name from `DB__<tenant>`, and a static binding of the
 * declared spelling does not collide with the store.
 */
function isPerTenantRuntimeName(name: string, binding: string): boolean {
  const prefix = `${binding}__`;
  return name.startsWith(prefix) && tenantId.safeParse(name.slice(prefix.length)).success;
}

/**
 * One binding name is one store (#2207, #2221). The names a vertical declares —
 * an own store, a per-tenant store, a blob store, a scope store — are compared
 * as written. `ATTACHMENTS` stays the attachment blob store and cannot be a
 * scope store.
 *
 * A static wrangler binding is compared to the name that lands on the worker,
 * not to the declaration. An own store's durable-object binding IS that store,
 * so passing it again counts the name twice; push omits those names. A
 * per-tenant store is injected as `BINDING__<tenant>`. A scope store is not bound
 * on a hosted worker at all; `SUBSTRAT_STORE_<BINDING>` is the name a dev or test
 * host binds it under, so a static binding of that name is refused here as the
 * store's runtime name. A static binding spelled `DB` or `GRAPH` is neither of those.
 */
export function assertStoreBindingsDistinct(input: {
  readonly own?: readonly { binding: string }[];
  readonly tenantStores?: readonly { binding: string; kind?: string }[];
  readonly blobStores?: readonly { binding: string; kind?: string }[];
  readonly scopeStores?: readonly { binding: string; driver?: string }[];
  readonly bindingNames?: readonly string[];
}): void {
  const seen = new Map<string, string>();
  const claim = (binding: string, where: string) => {
    const prior = seen.get(binding);
    if (prior !== undefined) {
      throw substratError(
        'forbidden',
        `deploy refused: binding '${binding}' is declared as ${prior} and as ${where}. One name is one store.`,
      );
    }
    seen.set(binding, where);
  };
  for (const store of input.own ?? []) claim(store.binding, 'an own store');
  for (const store of input.tenantStores ?? []) claim(store.binding, 'a per-tenant store');
  for (const store of input.blobStores ?? []) claim(store.binding, 'a per-tenant blob store');
  for (const store of input.scopeStores ?? []) {
    if (store.binding === ATTACHMENT_BLOB_BINDING) {
      throw substratError(
        'forbidden',
        `deploy refused: '${ATTACHMENT_BLOB_BINDING}' is the attachment blob store, not a scope store.`,
      );
    }
    claim(store.binding, 'a scope store');
  }
  for (const name of input.bindingNames ?? []) {
    if ((input.own ?? []).some((store) => store.binding === name)) {
      throw substratError(
        'forbidden',
        `deploy refused: binding '${name}' is declared as an own store and as a static binding. One name is one store.`,
      );
    }
  }
  // Every name that lands on the worker, an own store's included, is compared with the
  // runtime names the platform injects: an own DO binding called `DB__<tenant>` would be a
  // second binding of that name beside the per-tenant store `DB`.
  const perTenant = [...(input.tenantStores ?? []), ...(input.blobStores ?? [])];
  const landed = [...(input.own ?? []).map((store) => store.binding), ...(input.bindingNames ?? [])];
  for (const name of landed) {
    const tenant = perTenant.find((store) => isPerTenantRuntimeName(name, store.binding));
    if (tenant) {
      throw substratError(
        'forbidden',
        `deploy refused: binding '${name}' is the runtime name of per-tenant store '${tenant.binding}'. One name is one store.`,
      );
    }
    const scope = (input.scopeStores ?? []).find((store) => name === scopeStoreBindingName(store.binding));
    if (scope) {
      throw substratError(
        'forbidden',
        `deploy refused: binding '${name}' is the runtime name of scope store '${scope.binding}'. One name is one store.`,
      );
    }
  }
}

/**
 * The two name lists {@link assertStoreBindingsDistinct} reads off a deploy's static
 * bindings (#2224). An own durable-object binding is an own store and is compared as
 * written; every other static binding is compared by the name that lands on the worker.
 * Push and the control plane both derive them here, from the `bindings` the manifest
 * carries, so the two checks cannot drift apart.
 */
export function storeNamesOfBindings(
  bindings: readonly { type: string; name: string; script_name?: string }[],
): { own: { binding: string }[]; bindingNames: string[] } {
  const isOwnStore = (b: (typeof bindings)[number]) => b.type === 'durable_object_namespace' && !b.script_name;
  return {
    own: bindings.filter(isOwnStore).map((b) => ({ binding: b.name })),
    bindingNames: bindings.filter((b) => !isOwnStore(b)).map((b) => b.name),
  };
}

/**
 * A scope store whose driver has no registration is refused (#2207). The declaration
 * parses — `graph` is the driver — and still cannot be stored as if the platform
 * could run it. `drivers` is what "registered" means: {@link STORE_DRIVERS} unless a
 * caller judges against another registry, as `mayHoldScopeStores` does.
 */
export function assertScopeStoresRegistered(
  stores: readonly ScopeStoreNeed[],
  drivers: readonly StoreDriverRegistration[] = STORE_DRIVERS,
): void {
  for (const store of stores) {
    if (!drivers.some((driver) => driver.driver === store.driver)) {
      throw substratError(
        'forbidden',
        `deploy refused: scope store '${store.binding}' declares driver '${store.driver}', which is not registered. ` +
          `A store driver is platform code, registered in this repo.`,
      );
    }
  }
}

/** Both refusals a push and the control plane apply to a scope-store declaration. */
export function assertDeclaredScopeStores(input: {
  readonly own?: readonly { binding: string }[];
  readonly tenantStores?: readonly { binding: string }[];
  readonly blobStores?: readonly { binding: string }[];
  readonly scopeStores?: readonly ScopeStoreNeed[];
  readonly bindingNames?: readonly string[];
  /** The registry the scope stores are judged against; {@link STORE_DRIVERS} when absent. */
  readonly drivers?: readonly StoreDriverRegistration[];
}): void {
  assertStoreBindingsDistinct(input);
  assertScopeStoresRegistered(input.scopeStores ?? [], input.drivers);
}

/**
 * One declared outbound destination (#303, D-46): a lowercase hostname the vertical's
 * worker may `fetch()` directly, or a `*.`-prefixed wildcard matching any subdomain depth
 * (`*.googleapis.com` matches `oauth2.googleapis.com` and `a.b.googleapis.com`, never the
 * apex `googleapis.com` — declare the apex separately if it is called). Hostname only:
 * no scheme, no port, no path, no embedded wildcards. IDNs are declared in punycode,
 * because that is the hostname the runtime sees.
 */
export const outboundHost = z
  .string()
  .max(253)
  .regex(
    /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?$/,
    'a lowercase hostname (api.example.com) or a *.-prefixed wildcard (*.example.com)',
  );
export type OutboundHost = z.infer<typeof outboundHost>;

/**
 * Does a destination hostname match the vertical's declared outbound surface? One
 * implementation for every seam that answers the question — the egress worker enforcing
 * (apps/vertical-egress), the CLI predicting, a console rendering — so "allowed" cannot
 * mean different things at different layers. Exact entries match exactly; `*.` entries
 * match any subdomain depth but never the apex. Case-insensitive on the hostname side
 * (DNS is), strict on the declared side (the schema only admits lowercase).
 */
export function matchesOutboundHost(hostname: string, declared: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  // `*.example.com` → suffix `.example.com`: the retained dot is the label boundary, so
  // the apex and any `evil-example.com` lookalike never match.
  return declared.some((d) => (d.startsWith('*.') ? h.endsWith(d.slice(1)) : h === d));
}

/**
 * Lift the declared `outbound` surface out of a STORED manifest's JSON (#303) without
 * re-parsing the whole manifest through the schema — a version list should not pay a full
 * manifest validation per row, and a legacy manifest predating the field must read as
 * null (unenforced) rather than fail. Null in ⇒ null out; malformed JSON reads as null,
 * because a manifest that never parsed also never served.
 */
export function outboundOfManifestJson(manifestJson: string | null | undefined): string[] | null {
  if (!manifestJson) return null;
  try {
    const m = JSON.parse(manifestJson) as { outbound?: unknown };
    return Array.isArray(m.outbound)
      ? m.outbound.filter((h): h is string => typeof h === 'string')
      : null;
  } catch {
    return null;
  }
}

/**
 * What a STORED manifest says about cross-vertical imports (#1705), in three answers:
 *
 * - `none`: no manifest, no registry, or a registry with no `imports` key. A version pushed
 *   before manifests were retained, or by a `substrat` CLI older than 0.34.0 (which writes no
 *   `imports` rows), or that simply
 *   imports nothing. Nothing is being hidden, and the hosted sweep calls no scope for it.
 * - `imports`: the rows, every one well formed.
 * - `unreadable`: JSON that does not parse, an `imports` that is not a list, or ANY row of the
 *   wrong shape. The hosted sweep keeps such a scope as a candidate and lets the scope's own
 *   answer decide, because excluding a consumer wrongly loses its edge with no trace, where
 *   including one wrongly costs one call.
 */
export type ManifestImports =
  | { kind: 'none' }
  | { kind: 'imports'; rows: { from: string; type: string; schemaVersion: number }[] }
  | { kind: 'unreadable'; reason: string };

/**
 * One registry list of a STORED manifest, in the three answers both readers below give: absent
 * (`null`), its rows, or why it cannot be read. Written once so the two cannot come to disagree
 * about a null registry, a list that is not a list, or one bad row.
 */
function registryRowsOfManifestJson<T>(
  manifestJson: string | null | undefined,
  key: 'imports' | 'exports' | 'entityGrants',
  row: z.ZodType<T>,
): { rows: T[] } | { unreadable: string } | null {
  if (!manifestJson) return null;
  let m: unknown;
  try {
    m = JSON.parse(manifestJson);
  } catch {
    return { unreadable: 'the stored manifest is not JSON' };
  }
  const registry = (m as { registry?: unknown } | null)?.registry;
  if (registry === undefined || registry === null) return null;
  if (typeof registry !== 'object' || !(key in registry)) return null;
  const rows = (registry as Record<string, unknown>)[key];
  if (!Array.isArray(rows)) return { unreadable: `the manifest's registry.${key} is not a list` };
  const out: T[] = [];
  for (const r of rows) {
    const p = row.safeParse(r);
    if (!p.success) return { unreadable: `a row of the manifest's registry.${key} is malformed` };
    out.push(p.data);
  }
  return { rows: out };
}

export function importsOfManifestJson(manifestJson: string | null | undefined): ManifestImports {
  const read = registryRowsOfManifestJson(manifestJson, 'imports', permissionRegistryImport);
  if (read === null) return { kind: 'none' };
  if ('unreadable' in read) return { kind: 'unreadable', reason: read.unreadable };
  return { kind: 'imports', rows: read.rows.map((r) => ({ from: r.from, type: r.type, schemaVersion: r.schemaVersion })) };
}

/**
 * What a STORED manifest says a vertical EXPORTS (#1705 PR 3), in `importsOfManifestJson`'s three
 * answers. The promote gate reads it for the outgoing and the incoming version: an exported
 * (type, schemaVersion) the outgoing version promised and the incoming one drops or re-versions
 * breaks every consumer that imports it.
 */
export type ManifestExports =
  | { kind: 'none' }
  | { kind: 'exports'; rows: { type: string; schemaVersion: number }[] }
  | { kind: 'unreadable'; reason: string };

export function exportsOfManifestJson(manifestJson: string | null | undefined): ManifestExports {
  const read = registryRowsOfManifestJson(manifestJson, 'exports', permissionRegistryExport);
  if (read === null) return { kind: 'none' };
  if ('unreadable' in read) return { kind: 'unreadable', reason: read.unreadable };
  return { kind: 'exports', rows: read.rows.map((r) => ({ type: r.type, schemaVersion: r.schemaVersion })) };
}

/**
 * #2178: the binding-shape gate over two STORED manifests — the version that runs now and the one
 * that would run instead — refused `precondition_failed` with {@link bindingShapeRefusal} when the
 * move strands people a link bound (`bindingShapeBreaks`). A manifest with no registry declares no
 * shape. One whose grant shapes cannot be read is refused too, saying so: the gate cannot tell
 * that it strands nobody, and no acknowledgement passes it.
 */
export function assertNoBindingShapeBreak(
  outgoingManifest: string | null | undefined,
  incomingManifest: string | null | undefined,
  opts: {
    /** What the outgoing version is, when the refusal should say (the installs that last reconciled it). */
    judgedFrom?: string;
    /**
     * Judge as if the outgoing version's retirements had not run: for installs with no receipt,
     * which may not have reconciled it, and (#2185) installs whose reconcile of it did not finish
     * its retirements. Either may still hold every key it retires (`retiredKeysOf`).
     */
    retiredStillHeld?: boolean;
    /**
     * #2184: the types the judged installs have bound through a link, as their reconcile reported
     * them, or `'unknown'` when it did not: a shape counts as binding where any of them bound it,
     * whatever the outgoing registry says about `bind` (`bindingShapeBreaks`). Omitted: the
     * registry's `bind` alone, for a version judged as what a scope runs rather than from a receipt.
     */
    boundEver?: readonly string[] | 'unknown';
  } = {},
): void {
  const grants = (json: string | null | undefined, which: string) => {
    const read = registryRowsOfManifestJson(json, 'entityGrants', entityGrantShape);
    if (read === null) return [];
    if ('unreadable' in read) {
      throw substratError(
        'precondition_failed',
        `the ${which} version's grant shapes cannot be read (${read.unreadable}), so whether this strands anyone a link bound is unknown — refused`,
      );
    }
    return read.rows;
  };
  const outgoing = grants(outgoingManifest, 'the running').map((g) => {
    const held = opts.retiredStillHeld ? retiredKeysOf(g) : [];
    return held.length ? { ...g, permissions: [...g.permissions, ...held], retired: undefined } : g;
  });
  const breaks = bindingShapeBreaks({ entityGrants: outgoing }, { entityGrants: grants(incomingManifest, 'the incoming') }, opts.boundEver);
  if (breaks.length > 0) {
    throw substratError('precondition_failed', bindingShapeRefusal(breaks) + (opts.judgedFrom ? `. Judged from ${opts.judgedFrom}` : ''));
  }
}

/**
 * One installed consumer a promote would break (#1705 PR 3): a scope whose running code imports
 * (type, schemaVersion) from the promoted vertical, which the incoming version drops (`incoming:
 * null`) or exports at another version. The consumer's edge then withholds every such event as
 * `version`, or finds the type `unexported`. Nothing is lost, and nothing arrives either.
 */
export const exportBreak = z.object({
  tenantId,
  scopeId,
  vertical: verticalSlug,
  /** The consumer's running version, or null when it is bound to none. */
  version: z.string().nullable(),
  type: eventType,
  schemaVersion: z.number().int().positive(),
  incoming: z.number().int().positive().nullable(),
});
export type ExportBreak = z.infer<typeof exportBreak>;

/**
 * The declared outgoing peer calls of a STORED manifest (#1706) — `outboundOfManifestJson`'s
 * sibling, and null on the same terms: no manifest, unparseable, or a version pushed before the
 * declaration existed. The directory read lifts it with the outbound surface, in one query, so
 * the router judges both from the dispatch it already resolved.
 */
export function callsOfManifestJson(manifestJson: string | null | undefined): string[] | null {
  if (!manifestJson) return null;
  try {
    const m = JSON.parse(manifestJson) as { calls?: unknown };
    return Array.isArray(m.calls) ? m.calls.filter((v): v is string => typeof v === 'string') : null;
  } catch {
    return null;
  }
}

/**
 * The §4 sandbox allowlist: the binding types a hosted vertical may declare, because each
 * is one of its OWN resources and carries no reach into platform infrastructure. This is a
 * POSITIVE allowlist — anything not named here is refused (self-serve-deploy.md §4), the
 * inverse of the original allow-by-omission denylist. It lives in `contracts` so both ends
 * speak one list: the CLI can predict admission, the control plane enforces it, and "what
 * passes" is a written set rather than an emergent property of what the check forgot to ban.
 *
 * Notable exclusions and why they are refused, not merely absent:
 * - `service` — a hosted vertical is ONE serving script (the DO is the app); it reaches the
 *   platform through the router (K-27), never a service binding. No own sibling to bind.
 * - `dispatch_namespace` — the platform's Workers-for-Platforms fabric, never a vertical's.
 * - anything managed/egress-shaped (`ai`, `browser`, `vectorize`, `hyperdrive`, `send_email`,
 *   `mtls_certificate`) — the outside world is a connector concern, and a vertical's own
 *   direct egress is the DECLARED `outbound` host list (#303, D-46), enforced by the egress
 *   worker — never a binding-shaped capability.
 *
 * NOT on this list because it is not a binding at all: **native static assets** (#340). They
 * are a top-level upload path (`assets: { jwt, config }` in the script metadata), so they can
 * neither be allowed nor refused here. They are admitted by a separate, narrower rule written
 * down in self-serve-deploy.md §4.1: the bytes are inert and public — no code, no authority,
 * no cross-tenant reach — but their content-address is a namespace-wide dedup key, so the
 * platform RE-DERIVES every hash from the uploaded bytes ({@link assetHash}) and refuses a
 * mismatch. What is trusted is the bytes; what is verified is the key.
 *
 * Caveat on `d1`: admissible as an own relational store (e.g. a Better-Auth `AUTH_DB`), but
 * the check does not yet PROVE the declared `database_id` is the vertical's own rather than
 * another tenant's — trusted under model-B human admission; platform provisioning closes that
 * gap (#301). A `durable_object_namespace` is admissible only for the vertical's OWN classes
 * (no `script_name`, `class_name` ∈ declared `doClasses`) — the control plane checks that.
 */
export const ADMISSIBLE_BINDING_TYPES = [
  'durable_object_namespace', // the vertical's own ScopeDO / state classes (own class only)
  'd1', // an own relational store (id ownership deferred to #301)
  'kv_namespace', // an own KV namespace
  'queue', // an own queue (producer binding)
  'r2_bucket', // an own R2 bucket
  'analytics_engine', // an own Analytics Engine dataset
  'secret_text', // an own secret (survives deploys via keep_bindings, #286)
  'plain_text', // an own inline config value (inert, no authority)
] as const;
export type AdmissibleBindingType = (typeof ADMISSIBLE_BINDING_TYPES)[number];

/** A binding the uploaded worker declares, as far as the sandbox contract check needs it.
 *  `type` stays a free string here — the §4 allowlist (`ADMISSIBLE_BINDING_TYPES`) is enforced
 *  by the control plane, not the schema, so a refused type produces a *named* rejection that
 *  points at the doc rather than a generic Zod parse error the builder can't act on. */
export const declaredBinding = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  class_name: z.string().optional(),
  script_name: z.string().optional(),
  /** For a `d1` binding: the database id — a vertical's OWN store (self-serve-deploy.md §4). */
  id: z.string().optional(),
});
export type DeclaredBinding = z.infer<typeof declaredBinding>;

/**
 * One row of the permission registry: a declared key, its description, and the module(s)
 * that declare it (§1 of PERMISSIONS.md, made machine-readable). `declaredBy` lets a
 * console group keys by owning engine without re-deriving from module code.
 */
export const permissionRegistryEntry = z.object({
  key: permissionKey,
  description: z.string().min(1),
  declaredBy: z.array(moduleId).min(1),
});
export type PermissionRegistryEntry = z.infer<typeof permissionRegistryEntry>;

/** An entity-narrowed grant SHAPE — which keys a per-entity grant carries (§4 of
 *  PERMISSIONS.md). The grants themselves are per-principal, runtime, scope-local; only
 *  their declared shapes are a code fact and belong in the manifest. */
/** A table or column a declaration names, interpolated into SQL — the kernel's `SQL_IDENTIFIER`. */
const sqlIdentifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const entityGrantShape = z.object({
  entityType: z.string().min(1),
  permissions: z.array(permissionKey),
  /**
   * #2071: a shape a person is GIVEN on their own record when they arrive (meridian's
   * `EMPLOYEE_SELF`, todo's owner grant), granted with `grantEntityShape`. Only these are
   * reconciled: a key the shape gains later reaches every holder at the next provision or
   * reconcile. A shape without it is SHARING, reached through `ctx.grant` (todo's `list`), and is
   * never reconciled. Topping it up would hand every person something was fully shared with the
   * keys the shape gains. Omitted rather than `false` when unset, so a registry that declares no
   * bootstrap shape keeps the permission digest it had.
   */
  bootstrap: z.literal(true).optional(),
  /**
   * #2071: how a bootstrap shape's HOLDER is found from the data, for the one-time backfill that
   * marks people granted before markers existed. Provenance only, never which keys someone holds:
   * someone `ctx.grant`ed every key of a one-key shape holds the whole shape and is still a
   * sharee. Read only on a `bootstrap` shape.
   *
   * - `'self'`: the entity id IS the principal id. Todo's `owner:<principal>`.
   * - `{ table, idColumn, principalColumn }`: the vertical's own table row for the entity names
   *   its principal. Meridian's `hr_employees.principal_ref`.
   *
   * For those two, a person counts only when they also hold a row, live or tombstoned, for some
   * key of the shape on that entity: evidence they were given it. Evidence that lands while the
   * backfill is running, behind the point it has read to, is not counted, as none after it ends
   * is (#2154). The backfill reads the table in `idColumn` order a window per pass (then by each
   * row's own identity, so neither a repeated id nor a NULL principal makes it skip a row), which is
   * bounded only when `idColumn` leads an index (the primary key does); otherwise each pass sorts
   * the whole table, and the scope writes a `shape-backfill-unbounded` warn line saying so.
   *
   * - `'grantee'` (#2083): whoever holds a LIVE current or retired key of the shape on an entity of this type was
   *   given the shape there. For a portal-style record that names no principal and may have
   *   several people (ticket0's `contact`, a shop's `customer`). True by enforcement from the
   *   first reconcile that carries the declaration: from then on direct grants, including
   *   `ctx.grant`, `HostAdmin.grant` and `grantEntityLocal`, refuse current and retired keys on
   *   this entity type, so only `grantEntityShape` can mint one. A tuple written BEFORE that
   *   reconcile cannot be told apart, so declaring it marks every holder of a live current or
   *   retired key on that type, however they got it. A live retired key is then taken back in
   *   that pass; a tombstoned key is no evidence. A marker remains until explicitly revoked.
   *
   * Absent: no backfill, so only people given the shape with `grantEntityShape` from then on are
   * holders.
   */
  holder: z
    .union([
      z.literal('self'),
      z.literal('grantee'),
      z.object({ table: sqlIdentifier, idColumn: sqlIdentifier, principalColumn: sqlIdentifier }),
    ])
    .optional(),
  /**
   * #2082: keys this bootstrap shape USED TO carry, taken back from every existing holder. A key
   * dropped from `permissions` alone stays with everyone who already held it (the reconcile never
   * removes a key on its own, and the promote diff says "existing holders keep it"). Listing it here is the
   * reviewed removal: at the next reconcile each person holding the shape's marker on an entity
   * of this type has that key's row there TOMBSTONED (K-21, never deleted), once per scope, with
   * one `entity.grants-retired` event per (person, entity).
   *
   * - **One tuple is one authority.** A direct `ctx.grant` of the same key to the same person on
   *   the same entity is the same row, so it is taken back too. The key held any other way stays:
   *   through a role, a grant on a parent, a grant on another entity, or by someone who is not a
   *   holder of the shape.
   * - **Once.** After a scope finishes the retirement, a key granted to a holder again is left
   *   alone. Putting the key back in `permissions` ends the retirement, so a later release may
   *   retire it again.
   * - **Re-adding does not undo it.** A key put back in `permissions` after a retirement reaches
   *   only people given the shape from then on: the top-up never re-grants a tombstoned key, and
   *   a retirement's tombstone is one.
   *
   * Only on a `bootstrap` shape, never a key still in `permissions`, no duplicates. Omitted when
   * empty, so a registry that retires nothing keeps the permission digest it had.
   */
  retired: z.array(permissionKey).optional(),
  /**
   * #1686: a BINDING shape — the record's own principal column decides who holds it, and a
   * `become` link may carry "on claim, set that column to the claimant" (a binding invite).
   * `permission` is an ordinary key: who holds it on a record may mint such a link for it and
   * may unbind its person. Checked at mint, again at the claim, and at an unbind.
   *
   * Only on a `bootstrap` shape whose `holder` is the table form, and never one of the shape's
   * own current or retired keys (a key that let you hand out itself would be no bound). The holder's
   * `idColumn` should be unique: a claim binds exactly one row, so an id two rows carry is refused,
   * and an unbind clears every row with it. The
   * column the holder names must be one of the entity's erasure SUBJECTS rather than an
   * `erasable` field: an erasure of the record or of its person unbinds it (the kernel clears the
   * column and takes the shape back, after the module's erasure hook has read the rows).
   *
   * Its keys are refused to every direct grant on a record of this type, as a `'grantee'` shape's
   * are, and a grant of one on a parent of another type never reaches such a record: the permission
   * walk stops climbing at a record whose shape protects the key (#2177). A claim refuses a record
   * whose column names someone, and one someone already holds the shape on (`bind-record-held` — a
   * person given it before the column was written: unbind them first). An unbind releases every
   * holder of the shape on the record from the spine, whatever the column names now.
   *
   * Once a scope has recorded a binding shape for a type (its first reconcile with the declaration),
   * the type's protected keys stay refused to direct grants there whatever later versions declare.
   * That is permanent and per scope: a vertical that removes the binding shape and wants those keys
   * plain-granted again must use new key names — a retirement takes the keys back from their
   * holders but does not lift the refusal, and nothing clears the scope's `shape-bound` record —
   * and a scope the binding was never declared in is unaffected. This is intended, and fails closed.
   * An erasure matches the erased id against every type that ever bound
   * (as module erasure matches subject columns whatever the type): an id that is not a ULID can
   * collide across types.
   *
   * People already bound KEEP the shape until they are released — an unbind while the shape binds,
   * an erasure (which reaches every type that ever bound in the scope), or `retired` — whatever a
   * later version does to the declaration: dropping `bind` keeps the holder recorded but leaves no
   * unbind. Dropping `bind` is allowed (it stops new links), and the people it leaves bound are
   * still guarded (#2184): each install's reconcile reports the types it has ever bound, and the
   * gate below counts a bootstrap shape with a table holder as binding wherever an install bound
   * it, or did not report (`boundShapes`), as well as wherever the registry says `bind`. A version
   * that removes the shape, moves its holder, drops `bootstrap` or drops a key
   * from `permissions` without listing it in `retired` is refused
   * wherever it would come to run where the shape binds — a promote, a bind, a route onto a serving
   * script — unless it retires every key (`bindingShapeBreaks`, #2178); a rollback to a version from
   * before the shape is refused the same way. Retiring is the way through: keep the shape with the
   * keys in `retired` and none in `permissions`, then drop or move it in a later version. A
   * retirement reaches an install only at its reconcile, so each primary install the move reaches is
   * also judged from the version it last reconciled (`provisionedVersionId`) and whether that
   * reconcile FINISHED the version's retirements (`retirementsFinishedVersionId`, #2185): the drop
   * stays refused until the retirement has finished in every one. An install whose reconcile left a
   * retirement open, whose vertical was built on packages that predate that report (its count comes
   * from `adapter-cloudflare` and is answered by `vertical-host`), or that has no receipt (a switch, a
   * rewind or a restore cleared it, or it is new) counts as still holding the keys, until the sweep's next
   * reconcile finishes them. A copy (fork, snapshot, preview) never reconciles, so a retirement never
   * reaches it, and it is judged only on what it runs. Omitted when unset, so a registry that binds
   * nothing keeps its digest.
   */
  bind: z.object({ permission: permissionKey }).optional(),
});
export type EntityGrantShape = z.infer<typeof entityGrantShape>;

/**
 * #1686: what is wrong with a shape's `bind`, as messages — empty when nothing is. Checked where
 * {@link retiredShapeProblems} is.
 */
export function bindShapeProblems(
  shape: Pick<EntityGrantShape, 'entityType' | 'permissions' | 'bootstrap' | 'holder' | 'retired' | 'bind'>,
  /** The keys the modules declare, where the registry is built; a push carries none to check against. */
  declared?: ReadonlySet<string>,
): string[] {
  if (!shape.bind) return [];
  const problems: string[] = [];
  const where = `entityGrants '${shape.entityType}'`;
  if (!shape.bootstrap) problems.push(`${where}: \`bind\` is only for a bootstrap shape; a sharing shape is reached through ctx.grant`);
  if (typeof shape.holder !== 'object') {
    problems.push(`${where}: \`bind\` needs a table holder ({ table, idColumn, principalColumn }) — the column a claim writes`);
  }
  if ([...shape.permissions, ...(shape.retired ?? [])].includes(shape.bind.permission)) {
    problems.push(`${where}: binds with ${shape.bind.permission}, which is one of the shape's own keys`);
  }
  // A bind permission nothing declares could never be held, so no link could ever be minted.
  if (declared && !declared.has(shape.bind.permission)) problems.push(`${where}: binds with ${shape.bind.permission}, which no module declares`);
  return problems;
}

/**
 * #2082: what is wrong with a shape's `retired`, as messages — empty when nothing is. Checked
 * where a registry is BUILT ({@link buildPermissionRegistry}) and where a push carries one
 * ({@link pushedPermissionRegistry}); stored history is read without it.
 */
export function retiredShapeProblems(shape: Pick<EntityGrantShape, 'entityType' | 'permissions' | 'bootstrap' | 'retired'>): string[] {
  const retired = shape.retired ?? [];
  if (retired.length === 0) return [];
  const problems: string[] = [];
  const where = `entityGrants '${shape.entityType}'`;
  if (!shape.bootstrap) problems.push(`${where}: \`retired\` is only for a bootstrap shape; a sharing shape has no holders to take a key back from`);
  const kept = retired.filter((k) => shape.permissions.includes(k));
  if (kept.length > 0) problems.push(`${where}: retires ${kept.join(', ')}, which it still grants`);
  const twice = retired.filter((k, i) => retired.indexOf(k) !== i);
  if (twice.length > 0) problems.push(`${where}: retires ${[...new Set(twice)].join(', ')} more than once`);
  return problems;
}

/**
 * #2185: the keys a shape's retirement takes back: its `retired` keys that it does not grant again,
 * each once, sorted. Empty for a sharing shape, which is never reconciled. The one reading of
 * "retired and not in `permissions`": the kernel's reconcile retires exactly these, the
 * binding-shape gate counts exactly these as still held where a retirement has not finished, and
 * a control plane counts a reconcile's retirements finished without asking when no shape has any.
 */
export function retiredKeysOf(shape: Pick<EntityGrantShape, 'permissions' | 'bootstrap' | 'retired'>): string[] {
  if (!shape.bootstrap) return [];
  return [...new Set(shape.retired ?? [])].filter((k) => !shape.permissions.includes(k)).sort();
}

/**
 * The vertical's declared permission surface, shipped in the deploy manifest (D-39) — the
 * machine-readable twin of PERMISSIONS.md. Assembled at push from the SAME `MODULES` +
 * `ROLES` + `ENTITY_GRANTS` the host registers (via the checked-in `permissions.json` that
 * `tools/permission-diff.mts` emits and CI keeps fresh), so it cannot drift from what is
 * enforced. `digests.permission` is its content hash: the platform now holds the registry
 * it already committed to, not only the hash. Immutable per version; consumed by admission
 * (a real permission diff between versions) and any tenant-facing permissions view.
 *
 * Deliberately NOT the runtime grant table: minted capability grants are scope-local tuples
 * (control-plane.md §4.5), reachable only through the admin-query RPC, never mirrored here.
 */
/**
 * One event type this vertical releases to other verticals of the tenant (#1705), and the
 * key a receiving vertical must hold for it. A row here is a flow OUT of the vertical, so
 * it belongs in the same artifact as the keys that gate it.
 */
export const permissionRegistryExport = z.object({
  type: eventType,
  schemaVersion: z.number().int().positive(),
  readPermission: permissionKey,
  declaredBy: z.array(moduleId).min(1),
});
export type PermissionRegistryExport = z.infer<typeof permissionRegistryExport>;

/**
 * One event type this vertical receives from another vertical (#1705) — the flow IN.
 * `from` is the producing vertical's registry slug.
 */
export const permissionRegistryImport = z.object({
  from: verticalSlug,
  type: eventType,
  schemaVersion: z.number().int().positive(),
  declaredBy: z.array(moduleId).min(1),
});
export type PermissionRegistryImport = z.infer<typeof permissionRegistryImport>;

export const permissionRegistry = z.object({
  permissions: z.array(permissionRegistryEntry),
  roles: z.array(roleDefinition),
  entityGrants: z.array(entityGrantShape).default([]),
  // #1705: the cross-vertical event edges, in and out. OPTIONAL, and omitted rather than
  // emptied when a vertical declares none. The registry is hashed into `digests.permission`,
  // so a defaulted `[]` would change every existing vertical's digest on its next push,
  // and each promote would then ask a human to acknowledge a change that did not happen.
  // Present, they move the digest, which is the point: widening what leaves a vertical,
  // or what enters it, cannot be promoted unacknowledged.
  exports: z.array(permissionRegistryExport).optional(),
  imports: z.array(permissionRegistryImport).optional(),
});
export type PermissionRegistry = z.infer<typeof permissionRegistry>;

/**
 * The registry as a PUSH carries it (#1869): an `entityGrants` shape naming a kernel namespace
 * as its entity type (`scope`, `Scope`, …) is refused, as the module manifest refuses one.
 * Only at the push boundary: {@link storedDeployManifest} reads history with the plain
 * {@link permissionRegistry}, so a version stored before the refusal stays readable.
 */
export const pushedPermissionRegistry = permissionRegistry.extend({
  entityGrants: z
    .array(
      entityGrantShape.extend({ entityType: declaredEntityType }).superRefine((shape, ctx) => {
        for (const message of retiredShapeProblems(shape)) ctx.addIssue({ code: 'custom', path: ['retired'], message });
        for (const message of bindShapeProblems(shape)) ctx.addIssue({ code: 'custom', path: ['bind'], message });
      }),
    )
    .default([]),
});

/**
 * A vertical's declared permission surface, as the **single typed source** — the input the
 * permission checkpoint (`tools/permission-diff.mts`) and `substrat push` both read to derive
 * the {@link permissionRegistry}. It is not the registry itself: keys carry no `declaredBy` yet
 * (that is derived from `modules`), because this is what an author *writes*, once.
 *
 * `modules` is structural on purpose — a `ModuleRegistration[]` (kernel) is assignable, but
 * `contracts` may not depend on the kernel, so it asks only for the `manifest` it reads.
 */
export interface PermissionsInput {
  /** The modules the host registers — the source of every permission key + description, and
   *  (a kernel `SqlMigration[]`, read by `substrat push`, #1677) of the SQL migrations. */
  modules: readonly { manifest: ModuleManifest; migrations?: readonly { version: string; sql: string }[] }[];
  /** The role templates provisioning stamps into each tenant. */
  roles: readonly RoleDefinition[];
  /** Entity-narrowed grant shapes — keys reachable outside the role table (default none). */
  entityGrants?: readonly EntityGrantShape[];
  /**
   * The declared keys, as literals — the array `defineOperations` needs (#1208).
   *
   * `modules` already carries every key, but not as a type anything can read back:
   * a manifest is a `moduleManifest.parse(…)` output, so each `key` is the branded
   * `PermissionKey` and the literal is gone one step before this function sees it.
   * `defineOperations(entities, KEYS)` needs the literal union to turn a mistyped
   * `permission:` into a compile error naming the real keys, so a vertical writes
   * the keys once as a `const` array and hands the SAME array to both.
   *
   * That is still a second description — but it is the only one, and it is no longer
   * unchecked: given here, {@link definePermissions} throws at module load if it and
   * the modules disagree in either direction. A vertical that used to carry its own
   * "the keys still match the modules" test can delete it.
   *
   * Optional, so every existing vertical keeps compiling; a vertical that omits it
   * gets `never` from {@link PermissionKeysOf}, never a silently-widened `string`.
   */
  keys?: readonly string[];
}

/**
 * The literal key union a {@link definePermissions} result carries — what `defineOperations`
 * wants as its `Perms` argument, read off the declared surface instead of restated a third time.
 *
 * `never` when `keys` was omitted, and deliberately not `string`: widening to `string` would make
 * `defineOperations` accept any `permission:` value at all, quietly deleting the check this exists
 * to serve. An unusable type is the loud answer; a permissive one is the silent wrong answer.
 *
 * Same answer when the array was written without `as const`, which is the likelier mistake — its
 * element type is already `string`, so passing it straight through would be that silent widening
 * arriving by a different road. `string extends …` is the test for "this is the widened type
 * rather than a union that happens to include it".
 */
export type PermissionKeysOf<T extends PermissionsInput> = T['keys'] extends readonly string[]
  ? string extends T['keys'][number]
    ? never
    : T['keys'][number]
  : never;

/**
 * Declare a vertical's permission surface, once, in TypeScript. A near-identity helper: it pins the
 * shape so a missing or mistyped field is a **compile error**, not a silently-skipped vertical,
 * and returns a plain, side-effect-free object safe to import in any Node context to read the
 * surface without running the vertical. A vertical exports the result and points at it from
 * `package.json` `substrat.permissions`; the checkpoint discovers it there rather than from a
 * by-name `seed.ts` re-export.
 *
 * `const T` rather than `PermissionsInput` so the input's literal types survive the call and
 * {@link PermissionKeysOf} has something to read. The runtime value is unchanged — it returns
 * exactly what it was given — and every existing call site keeps its old type by construction.
 *
 * The one thing it does beyond returning: if `keys` is given, it must be exactly the set the
 * modules declare, or this throws at module load. Load time is the right place, for the same
 * reason `defineOperations`' own assertions are there — it fires in every build, every test and
 * every dev server, so no vertical has to remember to write the check.
 */
export function definePermissions<const T extends PermissionsInput>(input: T): T {
  if (input.keys) assertKeysMatchModules(input.keys, input.modules);
  return input;
}

/**
 * `keys` and the modules describe the same set, or the vertical does not load.
 *
 * Both directions matter and they fail differently. A key the modules declare but `keys` omits
 * makes `defineOperations` reject a permission that genuinely exists — a compile error on correct
 * code. A key in `keys` that no module declares is worse: it type-checks an operation against a
 * permission nothing ever grants, so the operation compiles and is unreachable at runtime.
 */
function assertKeysMatchModules(
  keys: readonly string[],
  modules: readonly { manifest: ModuleManifest }[],
): void {
  const declared = new Set<string>();
  for (const m of modules) for (const p of m.manifest.permissions) declared.add(p.key);
  const given = new Set<string>(keys);

  const quote = (k: string) => `'${k}'`;
  const missing = [...declared].filter((k) => !given.has(k)).sort().map(quote);
  const extra = [...given].filter((k) => !declared.has(k)).sort().map(quote);
  if (missing.length === 0 && extra.length === 0) return;

  const parts: string[] = [];
  if (missing.length > 0) parts.push(`declared by a module but absent from \`keys\`: ${missing.join(', ')}`);
  if (extra.length > 0) parts.push(`in \`keys\` but declared by no module: ${extra.join(', ')}`);
  throw new Error(`definePermissions: \`keys\` disagrees with the modules — ${parts.join('; ')}.`);
}

/**
 * Derive the machine-readable {@link permissionRegistry} from a vertical's declared surface —
 * the keys+descriptions each module declares (with `declaredBy`), the role templates, and the
 * entity-grant shapes. `substrat push` calls this on the imported `permissions` entry to build
 * what it ships in the manifest; the permission checkpoint uses the same function, so the
 * derived surface is one code path with no room to disagree.
 *
 * Deterministic: every array is sorted (keys, roles, grants, and the members within each), so
 * the output — and therefore `digests.permission` — is a pure function of content, independent
 * of declaration order.
 */
export function buildPermissionRegistry(input: PermissionsInput): PermissionRegistry {
  const cmp = (a: string, b: string) => a.localeCompare(b);
  const sortKeys = <T extends string>(keys: readonly T[]): T[] => [...keys].sort(cmp);

  const declaredBy = new Map<PermissionRegistryEntry['key'], { description: string; modules: Set<PermissionRegistryEntry['declaredBy'][number]> }>();
  for (const m of input.modules) {
    for (const p of m.manifest.permissions) {
      const seen = declaredBy.get(p.key);
      if (seen) seen.modules.add(m.manifest.id);
      else declaredBy.set(p.key, { description: p.description, modules: new Set([m.manifest.id]) });
    }
  }

  const roles = [...input.roles]
    .sort((a, b) => cmp(a.key, b.key))
    .map((r) => {
      if (!r.source) throw new Error(`buildPermissionRegistry: role '${r.key}' has no source`);
      return { key: r.key, permissions: sortKeys(r.permissions), source: r.source };
    });

  const permissions = [...declaredBy.entries()]
    .map(([key, v]) => ({ key, description: v.description, declaredBy: [...v.modules].sort(cmp) }))
    .sort((a, b) => cmp(a.key, b.key));

  const entityGrants = [...(input.entityGrants ?? [])]
    .sort((a, b) => cmp(a.entityType, b.entityType))
    .map((g) => ({
      entityType: g.entityType,
      permissions: sortKeys(g.permissions),
      ...(g.bootstrap ? { bootstrap: true as const } : {}),
      ...(g.holder ? { holder: g.holder } : {}),
      ...(g.retired?.length ? { retired: sortKeys(g.retired) } : {}),
      ...(g.bind ? { bind: { permission: g.bind.permission } } : {}),
    }));
  const problems = [
    ...entityGrants.flatMap(retiredShapeProblems),
    ...entityGrants.flatMap((g) => bindShapeProblems(g, new Set(declaredBy.keys()))),
  ];
  if (problems.length > 0) throw new Error(`buildPermissionRegistry: ${problems.join('; ')}`);

  // #1705: the edges. Keyed so two modules declaring the same flow collapse into one row
  // with both named. A flow is one fact however many modules state it. The version and
  // key are taken from the FIRST declaration; `registerModule` refuses a host where two
  // modules disagree about them, so a disagreement never reaches a push.
  const exportRows = new Map<string, PermissionRegistryExport>();
  const importRows = new Map<string, PermissionRegistryImport>();
  // `events?.` although the type says required: this runs over whatever a vertical's permissions
  // entry exports, which the CLI imports as plain JS, and a manifest with no event surface
  // declares no edge. It must not throw where it used to succeed.
  for (const m of input.modules) {
    for (const e of m.manifest.events?.exports ?? []) {
      const row = exportRows.get(e.type);
      if (row) row.declaredBy = [...new Set([...row.declaredBy, m.manifest.id])].sort(cmp);
      else exportRows.set(e.type, { ...e, declaredBy: [m.manifest.id] });
    }
    for (const c of m.manifest.events?.consumes ?? []) {
      if (c.from === undefined) continue;
      const key = `${c.from}\u0000${c.type}`;
      const row = importRows.get(key);
      if (row) row.declaredBy = [...new Set([...row.declaredBy, m.manifest.id])].sort(cmp);
      else importRows.set(key, { from: c.from, type: c.type, schemaVersion: c.schemaVersion, declaredBy: [m.manifest.id] });
    }
  }
  const exports = [...exportRows.values()].sort((a, b) => cmp(a.type, b.type));
  const imports = [...importRows.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.type, b.type));

  return {
    permissions,
    roles,
    entityGrants,
    ...(exports.length ? { exports } : {}),
    ...(imports.length ? { imports } : {}),
  };
}

/**
 * One static file in the shipped manifest (#340). The trio Cloudflare's asset store keys
 * on — content-addressed `hash`, `size` — plus the `contentType` the platform attaches at
 * upload and the runtime serves back.
 *
 * `hash` is the platform's DEDUP KEY, and the reason it is re-derived at the trust boundary
 * rather than trusted: the asset store dedups by hash across the whole dispatch namespace,
 * so bytes accepted under a hash they do not have would let one push decide what a DIFFERENT
 * vertical's identical-hash asset serves. The bytes themselves are inert and public; the
 * *key* is not. The control plane recomputes every hash from the uploaded bytes and refuses
 * a mismatch (self-serve-deploy.md §4.1).
 *
 * The recipe is Cloudflare's, and must stay byte-identical on both ends or nothing dedups:
 * `sha256(base64(content) + extension)`, first 32 hex chars ({@link assetHash}).
 */
export const assetEntry = z.object({
  /** Served path, always leading-slash, `/`-separated (e.g. `/assets/app-4f2.js`). */
  path: z.string().regex(/^\/(?!\/)[^\s]*$/),
  /** `sha256(base64(content) + extension)`, first 32 hex — Cloudflare's manifest key. */
  hash: z.string().regex(/^[0-9a-f]{32}$/),
  size: z.number().int().nonnegative(),
  /** The MIME type the runtime serves this file as (attached at upload time). */
  contentType: z.string().min(1),
});
export type AssetEntry = z.infer<typeof assetEntry>;

/**
 * The multipart part-name prefix static files ride under in a push (#340) —
 * `asset:/index.html`. Here, with the manifest schema, for the reason this file exists:
 * both ends must speak the same shape. The prefix is what separates the two kinds of part
 * in one body — anything unprefixed is a worker module — so an asset called `worker.js`
 * can never be uploaded as code, and a served path is never constrained to be a legal
 * module name.
 */
export const ASSET_PART_PREFIX = 'asset:';

// Web-standard globals, present in Node ≥ 18, Workers and browsers alike. Declared locally
// rather than pulled in through DOM lib types — the same rule the kernel's secret-box follows:
// `contracts` depends on no platform's type surface.
declare const btoa: (input: string) => string;
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const crypto: {
  subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> };
};

/** Bytes → base64, web-standard only (`btoa` over a binary string, chunked so a large file
 *  does not blow the argument limit of `String.fromCharCode`). No `Buffer`: this runs in the
 *  CLI (node), in the control plane (workerd), and in the browser. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The content-address of one static file — **Cloudflare's recipe, not ours**:
 * `sha256(base64(content) + extension)` (extension without the dot), first 32 hex chars.
 * It is reproduced here rather than imported because both ends must compute it identically:
 * the CLI to build the manifest it ships, the control plane to VERIFY that manifest against
 * the bytes before either reaches the asset store (see {@link assetEntry}). A divergence
 * would not merely fail — it would silently defeat dedup, or store bytes under a key that
 * is not theirs.
 *
 * Web Crypto (`globalThis.crypto.subtle`), so the one implementation runs unchanged in node,
 * workerd, and the browser.
 */
export async function assetHash(content: Uint8Array, path: string): Promise<string> {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot + 1) : '';
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(toBase64(content) + extension),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/**
 * The static-file half of a push (#340): the routing config, plus the full file manifest.
 *
 * The manifest is retained (it rides `manifest_json` like the rest of the deploy manifest)
 * for a load-bearing reason: a promote re-uploads a version onto the STABLE serving script
 * from its archive (#286), and an asset upload session is driven by the manifest, not by
 * bytes — content already in the namespace's asset store is skipped, so the retained
 * manifest is what lets a promote re-attach the same assets without the builder re-pushing.
 * It is also what the dashboard renders as the per-version asset list.
 */
export const deployAssets = assetRouting.extend({
  files: z.array(assetEntry),
});
export type DeployAssets = z.infer<typeof deployAssets>;

/**
 * The most output fields one operation contributes to the field-coverage surface — the
 * declared half (#1321) and the observed walk (#1331) both cap here, so they count the
 * same fields.
 */
export const DECLARED_OUTPUT_FIELDS_MAX = 200;

/** The JSON part a `substrat push` sends alongside the module files. */
/**
 * One operation's DECLARED output fields (#1321) — the operation id as OpenAPI
 * knows it, and the property names of the response body. An operation whose
 * response declares no properties (a 204, a bare scalar) contributes nothing and
 * is omitted rather than carried as an empty list, so absence means "declares no
 * fields" everywhere in the surface.
 */
export const declaredOperationOutput = z.object({
  operationId: z.string().min(1),
  fields: z.array(z.string().min(1)).min(1).max(DECLARED_OUTPUT_FIELDS_MAX),
});
export type DeclaredOperationOutput = z.infer<typeof declaredOperationOutput>;

/**
 * One event type a module declares, and which side of the seam it sits on
 * (#1234). `emits` and `consumes` are kept apart because the findings differ: an
 * unemitted type may be a dead code path, while an unconsumed one is a consumer
 * that never runs — and the star topology means the two are declared by
 * different modules that never import each other.
 */
export const declaredEventSurface = z.object({
  moduleId,
  /**
   * The canonical `eventType` grammar, not a looser `min(1)`. A deploy manifest is
   * REPARSED at the control-plane trust boundary, where the pusher is whoever holds a
   * token rather than necessarily this CLI, so a weaker grammar here is a name a module
   * manifest could never carry being persisted and then reported as a finding about an
   * event that cannot exist.
   */
  type: eventType,
  direction: z.enum(['emits', 'consumes']),
});
export type DeclaredEventSurface = z.infer<typeof declaredEventSurface>;

/** How many SQL migrations a manifest carries at most (#1677). */
export const DECLARED_MIGRATIONS_MAX = 2000;
/** How many bytes of SQL (UTF-8, summed over every migration) a manifest carries at most. */
export const DECLARED_MIGRATIONS_SQL_BYTES_MAX = 512 * 1024;
/**
 * How large a serialized deploy manifest may be for `substrat push` to send its migrations.
 *
 * The control plane stores the whole manifest as one row in a Durable Object, and a DO's
 * SQLite refuses a string or row over 2 MB. Node's SQLite allows about a gigabyte, so no
 * node suite sees the limit (the #1655 class). The SQL grows when JSON-escaped, so the SQL
 * cap alone does not bound the row: the push measures the manifest it is about to send and
 * leaves `migrations` off when the whole would pass this, well under the DO's limit.
 *
 * Since #1764 a control plane stores the manifest WITHOUT its migrations and each migration
 * as its own row, which the 512 KiB SQL cap bounds. The push keeps this bound anyway: a
 * control plane from before #1764 still stores the manifest whole.
 */
export const DEPLOY_MANIFEST_BYTES_SAFE = 1.5 * 1024 * 1024;

/** How many `moves` or `discards` entries one migration carries at most (#2322). */
export const MIGRATION_DECLARATIONS_MAX = 64;
/** How long a declared `table` or `table.column` is at most. */
export const MIGRATION_DECLARATION_TARGET_MAX = 200;
/** How long a discard's reason is at most, in characters. */
export const MIGRATION_DISCARD_REASON_MAX = 2000;


/** A `moves` or `discards` record: bounded, keyed by `table` or `table.column`, and never empty. */
function migrationDeclarations(value: z.ZodType<string>) {
  return z
    .unknown()
    // Checked on the raw object, before `z.record`: zod drops a `__proto__` key (JSON.parse makes
    // it an own key) without failing, so the review would show one declaration fewer than the
    // pusher hashed. Refused here on every parse — the push boundary, the CLI before it sends, and
    // the store reading a row back — and by the kernel's fence, so the author hears it at lint
    // time. Only `__proto__` is lost: `constructor` and `prototype` are ordinary own keys, and
    // legal table names, and every reader walks a declaration by its own entries.
    .refine((v) => typeof v !== 'object' || v === null || !Object.hasOwn(v, '__proto__'), {
      message: 'a declaration cannot name __proto__',
    })
    .pipe(z.record(z.string().min(1).max(MIGRATION_DECLARATION_TARGET_MAX), value))
    .refine((r) => Object.keys(r).length > 0, { message: 'an empty declaration is left off' })
    .refine((r) => Object.keys(r).length <= MIGRATION_DECLARATIONS_MAX, {
      message: `at most ${MIGRATION_DECLARATIONS_MAX} entries`,
    });
}

/**
 * One SQL migration a module ships (#1677): the `(module, version)` pair the kernel journals
 * it under, and its SQL verbatim. Carried so a promote can show WHICH migrations it would run
 * and what they do, rather than only that a digest moved.
 */
export const declaredMigration = z.object({
  moduleId,
  /**
   * The module's `SqlMigration.version`, e.g. `0001-init`. Unique per module. Any text the kernel
   * journals, as the kernel and the data-loss fence accept it: a version is metadata, which must
   * never fail a push, and a stored manifest must stay readable. A review never prints it raw —
   * every surface shows it on one line through `reviewLine` or a quote (#2322).
   */
  version: z.string().min(1).max(200),
  sql: z.string(),
  /**
   * The migration's declared data losses (#2322), exactly as `SqlMigration.moves` and
   * `SqlMigration.discards` spell them (#115): `moves` is `{ source: target }`, `discards` is
   * `{ target: reason }`. Not part of the SQL, so not part of the scope journal's digest
   * (#2066), but part of `digests.migration`, and shown by the promote review beside the SQL.
   * ABSENT means the migration declares none (or was pushed before the field); never empty.
   */
  moves: migrationDeclarations(z.string().min(1).max(MIGRATION_DECLARATION_TARGET_MAX)).optional(),
  discards: migrationDeclarations(
    z
      .string()
      .max(MIGRATION_DISCARD_REASON_MAX)
      // The kernel fence refuses a discard with no reason at apply, by this same rule; the trust
      // boundary refuses it too. Blank counts invisible characters as nothing (`blankReason`).
      .refine((why) => !blankReason(why), { message: 'a discard gives a reason a reviewer can read' }),
  ).optional(),
});
export type DeclaredMigration = z.infer<typeof declaredMigration>;
/** A migration's `moves` and `discards` alone (#2322): what a push carries and a store keeps beside the SQL. */
export const declaredMigrationDeclarations = declaredMigration.pick({ moves: true, discards: true });

const utf8 = new TextEncoder();

/** The UTF-8 size of one string. */
export function utf8Length(text: string): number {
  return utf8.encode(text).length;
}

/** The UTF-8 size of one migration's declarations: every target, source and reason. */
export function declarationBytes(m: { moves?: Readonly<Record<string, string>>; discards?: Readonly<Record<string, string>> }): number {
  let n = 0;
  for (const record of [m.moves, m.discards]) {
    for (const [k, v] of Object.entries(record ?? {})) n += utf8Length(k) + utf8Length(v);
  }
  return n;
}

/**
 * The UTF-8 size of every migration's SQL and declarations, summed — what the byte cap is
 * measured in. The declarations count because they are stored and read beside the SQL.
 */
export function sqlBytes(migrations: readonly { sql: string; moves?: Readonly<Record<string, string>>; discards?: Readonly<Record<string, string>> }[]): number {
  return migrations.reduce((n, m) => n + utf8Length(m.sql) + declarationBytes(m), 0);
}

/** Deterministic JSON: object keys sorted recursively, array order preserved. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * `digests.migration` (#1949, #2339): what the promotion gate compares. It covers the store
 * classes and every SQL migration the host would apply: each migration's module, version, the
 * SHA-256 of its SQL and, only when it declares any, its `moves` and `discards` (#2322), so a
 * declaration-free entry hashes as it did before them. `unresolvedIndexes` is the CLI's alone:
 * the searchables, lists and (when declared) entityStates a module declares when the vertical's
 * kernel cannot derive their SQL, a push whose manifest then carries no migrations.
 *
 * One function on both ends: `substrat push` computes it, and the control plane re-derives it
 * from the migrations the push declares in its manifest, which it stores and the promote review
 * shows, and refuses a push whose digest disagrees. The digest a promote compares and the
 * migrations it shows are then always the same set.
 */
export async function migrationDigestOf(input: {
  doClasses: readonly string[];
  migrations: readonly {
    moduleId: string;
    version: string;
    sql: string;
    moves?: Readonly<Record<string, string>>;
    discards?: Readonly<Record<string, string>>;
  }[];
  unresolvedIndexes?: readonly unknown[];
}): Promise<string> {
  const sql = await Promise.all(
    input.migrations.map(async ({ moduleId, version, sql, moves, discards }) => ({
      moduleId,
      version,
      sqlHash: await sha256Hex(sql),
      ...(moves ? { moves } : {}),
      ...(discards ? { discards } : {}),
    })),
  );
  const framed = stableJson({
    doClasses: input.doClasses,
    sql,
    ...(input.unresolvedIndexes ? { unresolvedIndexes: input.unresolvedIndexes } : {}),
  });
  return (await sha256Hex(framed)).slice(0, 32);
}

/**
 * The stored migration digest of a version whose migrations the control plane does not hold
 * (#2339): pushed before manifests carried them, over the caps a manifest carries, or with no
 * manifest at all. Nothing can re-derive its digest, and the gate never trusts the pushed one,
 * so it is stored as a value that equals no other version's: a promote to or over it always asks
 * for the migration acknowledgement, and the review shows its SQL as not available. Not hex, so
 * it can never collide with a derived digest.
 */
export function unheldMigrationDigest(versionId: string): string {
  return `${UNHELD_MIGRATION_DIGEST_PREFIX}${versionId}`;
}
export const UNHELD_MIGRATION_DIGEST_PREFIX = 'unheld:';

export const deployManifest = z.object({
  version: z.string().min(1),
  /** Display name for a first-time register; defaults to the slug. */
  name: z.string().min(1).optional(),
  /** Filename of the main module among the uploaded parts. */
  entry: z.string().min(1),
  compatibilityDate: z.string().min(1),
  compatibilityFlags: z.array(z.string().min(1)).default([]),
  doClasses: z.array(z.string().min(1)).default([]),
  bindings: z.array(declaredBinding).default([]),
  /** Per-tenant relational stores the platform provisions per tenant (#301) — carried so
   *  admission surfaces them and the tenant lifecycle knows what to mint. NOT `bindings`:
   *  there is no static binding for a per-tenant store, so it never rides the sandbox
   *  allowlist; the platform mints one database per tenant and injects the id. */
  tenantStores: z.array(tenantStoreNeed).default([]),
  /** Per-tenant blob stores (#473) — same carry-for-provisioning rule as `tenantStores`:
   *  never a static binding; the platform mints one bucket per tenant and injects it. */
  blobStores: z.array(blobStoreNeed).default([]),
  /** Platform-run objects, one per scope (#2207). Never a binding on the vertical's upload
   *  (L1): the vertical reaches one only through the platform's hop. An unregistered driver is
   *  refused. */
  scopeStores: z.array(scopeStoreNeed).default([]),
  /** The vertical's static files (#340): routing config + the full path/hash/size/type
   *  manifest. Never a binding — native assets are a top-level upload path, so they do not
   *  ride the §4 allowlist. Optional ⇒ a vertical that ships none is unaffected. */
  assets: deployAssets.optional(),
  /** The vertical's declared env-spec (from its package.json `substrat.envSpec`), stored on
   *  the registry so a host/console renders a config form for it. Optional + validated here. */
  envSpec: z.array(envVarSpec).optional(),
  /** Registry-driven install (marketplace-publish.md §3), from package.json `substrat.*` —
   *  carried so the dashboard installs without a hardcoded catalog entry. Validated here. */
  ownerGrants: z.array(permissionKey).optional(),
  entitlements: z.array(z.string()).optional(),
  provides: z.array(capability).optional(),
  requires: z.array(capability).optional(),
  /** DECLARED provisioner intent (#455): the target verticals this manager provisions
   *  tenants of (package.json `substrat.provisions`). A request, never a grant — the
   *  tenant-provisioner capability stays a staff-flipped registry flag; this feeds the
   *  console's requested/granted review surface and bounds `provision-tenant` targets. */
  provisions: z.array(verticalSlug).optional(),
  /** The vertical's DECLARED outbound surface (#303, D-46): the third-party hosts its
   *  worker `fetch()`es directly. Versioned with the code (each version's manifest carries
   *  its own list, lifted onto the version record), so widening it is visible at the admit
   *  checkpoint — a policy change ships only by shipping a version. The dispatch
   *  egress worker enforces it per subrequest: platform hosts always loop back through the
   *  router (K-27), declared hosts pass, anything else is refused with a pointer here.
   *  `[]` = no direct third-party egress (the right answer for most verticals — connectors
   *  and the email relay are platform-side and need no declaration). ABSENT = pushed by a
   *  pre-#303 CLI: unenforced (metered only) until the next push, which always carries it. */
  outbound: z.array(outboundHost).max(32).optional(),
  /** The vertical's DECLARED outgoing PEER calls (#1706): the other verticals of the same
   *  tenant whose operations this one invokes. Versioned with the code exactly as `outbound`
   *  is, and enforced by the platform on both legs — the router refuses a synchronous call to
   *  a vertical this list does not name, and the drain refuses an asynchronous one. It is the
   *  caller's half; what the TARGET allows is its own manifest's `peers`, which is where the
   *  permissions live and where the permission diff reviews them. `[]` = this vertical calls
   *  no sibling. ABSENT = a version pushed before #1706: unenforced until the next push. */
  calls: z.array(verticalSlug).max(32).optional(),
  /** DECLARED email-sender intent (#303): this vertical wants to send transactional mail
   *  (password-reset, verification, invites) — package.json `substrat.sendsEmail`. Outbound
   *  is a platform concern (deploy.ts §4 keeps `send_email` OUT of the sandbox allowlist and
   *  WfP dispatch scripts cannot bind it anyway), so a vertical NEVER sends directly: it POSTs
   *  to the control plane's `/internal/email/send` relay, which sends on its behalf ONLY when
   *  the staff-flipped `emailSender` grant is set. A request, never a grant — refreshed on
   *  every re-push, feeds the console's requested/granted review surface. */
  sendsEmail: z.boolean().optional(),
  /** Where this vertical's scope lifecycle is held (package.json `substrat.lifecycle`) —
   *  `lifecycleHold` says what the one value means. */
  lifecycle: lifecycleHold.optional(),
  /** DECLARED model-runtime intent (#1054): this vertical answers with a language model and
   *  wants the platform's model runtime bound as `env.AI` — package.json
   *  `substrat.usesModels`. Versioned with the code, like `outbound` and for the same
   *  reason: the binding is a CAPABILITY on the platform's own AI account, so widening who
   *  holds it must ship as a version and be visible at the admit checkpoint rather than
   *  being granted to every script by default. A vertical that does not declare it gets no
   *  binding at all and falls back to whatever credential its own env carries (usually
   *  none, which is the extractive path).
   *
   *  Least privilege, not a sandbox: a vertical that declares it can call `env.AI.run()`
   *  outside the metered path. That is the honest bound, and #1073 removes it by running
   *  inference platform-side. */
  usesModels: z.boolean().optional(),
  /** The surfaces the vertical serves (package.json `substrat.surfaces`, K-26 multi-surface) —
   *  labels only, carried to the registry for the hostname-binding picker. Metadata, not code. */
  surfaces: z.array(declaredSurface).optional(),
  /** The vertical's emitted entity model (#1214): the checked-in `model.json` — entities,
   *  their field schemas, parent edges, and declared lifecycles (#844) — carried so the
   *  dashboard can render the DEPLOYED version's model, the way `registry` already carries
   *  the permission surface. Metadata, not code, and not in any digest: it describes what
   *  the migrations built, it does not build anything. Optional twice over — a vertical
   *  with no `model.json` beside its package.json pushes without one, and versions pushed
   *  by a pre-#1214 CLI stay readable. */
  model: emittedModel.optional(),
  /**
   * What each operation DECLARES it returns (#1321), derived from the emitted
   * `openapi.json`: the operation id and the field names of its 200/201 response
   * schema (a paged read contributes its ENTRY's fields, not the envelope's).
   *
   * Carried for the same reason as `model` and `schedules`: the fact exists only
   * inside the vertical's bundle — `openapi.json` is built by each vertical and
   * never sent — and the dashboard cannot otherwise answer "is this declared field
   * named by anything at all". Metadata, not code, and in no digest.
   *
   * Deliberately field NAMES, not schemas: the question is reachability, and
   * carrying the shapes again would duplicate `model` at several times the size.
   */
  outputSurface: z.array(declaredOperationOutput).max(500).optional(),
  /**
   * What each module DECLARES it emits and consumes (#1234), flattened across
   * modules with the owning module beside each type.
   *
   * Carried for the reason `schedules` and `freshness` are: the fact lives only in
   * a module manifest inside the bundle, and the platform has no other way to ask
   * "what is this app supposed to produce" — which is the declared half of every
   * declared-vs-observed finding. A consumer that has not fired in thirty days is
   * only a finding if something knew it was supposed to.
   *
   * Metadata, in no digest, and optional twice over: a vertical whose modules
   * declare no events pushes without it, and a version pushed by an earlier CLI
   * stays readable.
   */
  declaredEvents: z.array(declaredEventSurface).max(500).optional(),
  /**
   * True when the surface above was CUT at its cap, so it is a sample rather than the
   * whole declaration (#1234).
   *
   * Absent means complete, which is the ordinary case and keeps the field off almost
   * every manifest. It matters because the reader's own sentence is a completeness
   * claim: "N of M declared types checked" is a different statement from "N of the M we
   * could carry". Without this a truncated push reads as an exhaustive check, and the
   * one thing a findings view may never do is claim to have looked at something it did
   * not.
   *
   * Distinct from an EMPTY surface, which is `[]` and says the modules declare no
   * events — a fact, and not the same as a version pushed before the field existed
   * (the field absent entirely).
   */
  declaredEventsTruncated: z.boolean().optional(),
  /** The vertical's declared schedules (#1232), flattened across modules with each
   *  spec's owning module beside it — carried so the dashboard can render the DEPLOYED
   *  version's schedule health (next due needs `everyMinutes`, and the manifest is the
   *  only place it exists off the runtime). Metadata, not code, and not in any digest,
   *  exactly as `model` above; optional twice over for the same two reasons. */
  schedules: z.array(scheduleSpec.extend({ moduleId })).optional(),
  /** The vertical's declared freshness expectations (#1232), flattened like `schedules`
   *  and for the same reason: `within.hours` exists nowhere off the manifest, and the
   *  dashboard's declared-vs-observed read needs it. Metadata, in no digest, optional
   *  twice over. */
  freshness: z.array(freshnessSpec.extend({ moduleId })).optional(),
  /**
   * The Durable Object classes the worker entry exports as its OWN scope sweeper — the
   * names bound to a `defineScopeSweeperDO(...)` call, as the push read them from source
   * (#1902). The control plane decides from this, once at push, whether the version's
   * uploads carry the platform's sweeper (recorded as the stored manifest's
   * `platformSweeper`) when it declares `schedules`: `[]` means the vertical brings none, so it is given
   * one; a name here means it brings its own, which is kept, and a binding must name it or
   * the push is refused.
   *
   * ABSENT means a CLI from before the field: the decision then reads the conventional
   * names instead (`SWEEPER` bound to `SweeperDO`), and refuses what it cannot tell apart.
   * Never inferred from the bundle's bytes — an export's name says nothing about its class.
   */
  sweeperClasses: z.array(z.string().min(1)).max(16).optional(),
  /**
   * Every SQL migration the vertical's modules ship (#1677), module by module in
   * registration order and each module's own order, with its SQL verbatim. It is what the
   * promote dialog and `substrat promote` read to show the migrations a promote would run.
   *
   * The push hashes each migration's module ID, version, and SQL into
   * `digests.migration`, alongside the Durable Object classes. The promotion gate
   * compares that digest, including when manifest size limits omit this readable list.
   * The SQL itself is readable only by the owner because it describes a schema.
   *
   * `[]` means the modules ship no SQL migrations. ABSENT means the version was pushed
   * before the field existed, or the set was over the caps below and the push left it out.
   * A reader must treat absence as "cannot show", never as "no migrations".
   */
  migrations: z
    .array(declaredMigration)
    .max(DECLARED_MIGRATIONS_MAX)
    .refine((ms) => sqlBytes(ms) <= DECLARED_MIGRATIONS_SQL_BYTES_MAX, {
      message: `migrations carry more than ${DECLARED_MIGRATIONS_SQL_BYTES_MAX} bytes of SQL`,
    })
    .optional(),
  /** The vertical's declared permission surface (D-39/D-41): keys+descriptions, role templates,
   *  entity-grant shapes — the machine-readable twin of PERMISSIONS.md, derived at push from the
   *  vertical's `definePermissions(...)` entry. REQUIRED: a deployable vertical must declare its
   *  surface (an explicit empty registry for one that genuinely exposes nothing), so absence is a
   *  parse error at the trust boundary rather than a silent empty surface. `digests.permission` is
   *  its content hash. */
  registry: pushedPermissionRegistry,
  /** Computed by the builder's toolchain; what the promotion checkpoint compares. */
  digests: z.object({
    manifest: z.string().min(1),
    /** Content hash of `registry` (D-39) — the promotion checkpoint's "permissions changed"
     *  signal. A pure function of the declared surface, so it moves iff a key, description,
     *  role, or grant shape moves. */
    permission: z.string().min(1),
    migration: z.string().min(1),
  }),
});
export type DeployManifest = z.infer<typeof deployManifest>;

/**
 * The same manifest for **reading persisted history**, where `registry` may be absent — a
 * version pushed before it was carried (D-39) or before it was required (D-41). The push trust
 * boundary always parses with the strict {@link deployManifest} (registry required), so a NEW
 * push cannot omit it; only re-reads of already-stored manifests use this lenient form, so an
 * old version stays readable and re-deployable in place (#286) instead of failing to parse.
 */
export const storedDeployManifest = deployManifest.extend({
  registry: permissionRegistry.optional(),
  /**
   * The control plane's own decision, recorded at push (#1902): whether this version's
   * uploads carry the platform's scope sweeper. Made ONCE, when the version is pushed, from
   * `schedules` and `sweeperClasses`, and reused by every later upload of the version —
   * promote, re-serve, backout — so none of them re-decides, and none can refuse a version
   * that was accepted. Never read from the push: `deployManifest` has no such field, so a CLI
   * cannot claim it. ABSENT means a version pushed before the decision existed, which keeps
   * exactly what it had: no platform sweeper.
   */
  platformSweeper: z.boolean().optional(),
  // The caps are the push boundary's, not history's: lowering one must never make a
  // stored version unreadable.
  migrations: z.array(declaredMigration).optional(),
});
export type StoredDeployManifest = z.infer<typeof storedDeployManifest>;
