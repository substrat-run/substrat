/**
 * The scope host a deployed Meridian runs on — its own file so a workerd suite can build
 * the very host the worker does without importing the worker (its Durable Object classes
 * are the pool's to load, not a test module's).
 */
import { CloudflareScopeHost, type CloudflareScopeHostOptions } from '@substrat-run/adapter-cloudflare';
import { defaultAttachmentExtractors } from '@substrat-run/attachment-extractors';
import { declareScriveConnector } from '@substrat-run/connector-scrive';
import { MODULES } from './provision.js';

/**
 * The coordinator is stateless — rebuilt per request; durable state is in the DOs.
 * CP-less: NO control plane. Permissions evaluate from each scope's own storage; the
 * router asserts the node, so this vertical trusts it rather than reading a directory it
 * has no binding to. Its only durable stores are its own `SCOPE` DO class and `AUTH_DB`.
 */
export function hostFor(
  env: { SCOPE: CloudflareScopeHostOptions['scope'] },
  /** A seam for the workerd suite, which has no per-tenant bucket to resolve (nothing here declares one yet). */
  extra: Pick<CloudflareScopeHostOptions, 'attachmentBuckets'> = {},
): CloudflareScopeHost {
  // K-43: the kernel parses no file format; the parsers are passed in here, so an
  // uploaded DOCX on an `employee` is searchable by its text. Without them every
  // upload records `unsupported`.
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    attachmentExtractors: defaultAttachmentExtractors(),
    ...extra,
  });
  for (const m of MODULES) host.registerModule(m);
  // #574 phase 3: the SAME registration the node self-host makes (seed.ts) — but on
  // this CP-less host the handler never runs. Registering it is what tells the host
  // which events are connector deliveries, so the drain routes each one onto the
  // platform-requests surface as a `connector:scrive` intent and the platform (which
  // holds the directory, the sealed credential and the egress) dispatches it. Options
  // like `baseUrl`/`callbackUrl` are deliberately absent: they are the DISPATCHING
  // host's concern, configured where the handler actually executes — which is why this
  // is `declare…` and not `register…` with an empty options bag (#990).
  declareScriveConnector(host);
  return host;
}
