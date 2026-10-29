/** Scriptable, person-only approval commands for already uploaded store-driver releases (D-65). */
import { readFileSync, statSync } from 'node:fs';
import { storeCatalogOperation } from '@substrat-run/contracts';
import {
  ControlPlaneError,
  type StoreDriverApprovalBody,
  type StoreDriverApprovalResultView,
  type StoreDriverRevokeResultView,
  type StoreDriverView,
} from '@substrat-run/control-plane-client';

const nonPrinting = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const commitShape = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const classShape = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reviewKeys = [
  'separateScriptPerTenant', 'noOutboundAccess', 'envelopeVerifiedOutsideDriver',
  'envelopeChecked', 'reservedOperationsChecked', 'noModuleStateChecked',
] as const;
const MAX_REVIEW_FILE_BYTES = 128 * 1024;

const record = (value: unknown, field: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field}: expected an object`);
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, keys: readonly string[], field: string): void => {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${field}: expected exactly ${keys.join(', ')}`);
  }
};

/** The same printable, bounded text rule as the approval and revoke routes. Values stay exact. */
export function storeDriverReviewText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || value.trim().length === 0 || nonPrinting.test(value)) {
    throw new Error(`${field}: expected 1–2048 printable characters`);
  }
  return value;
}

/** Validate the full body before the client sends it; no text is silently normalised. */
export function validateStoreDriverApproval(value: unknown): StoreDriverApprovalBody {
  const body = record(value, 'approval');
  exactKeys(body, ['reason', 'sourceReferences', 'isolationReview', 'schema', 'className', 'operations'], 'approval');
  const reason = storeDriverReviewText(body.reason, 'reason');
  if (!Array.isArray(body.sourceReferences) || body.sourceReferences.length < 1 || body.sourceReferences.length > 64) {
    throw new Error('sourceReferences: expected 1–64 repository and commit pairs');
  }
  const sourceReferences = body.sourceReferences.map((entry, i) => {
    const ref = record(entry, `sourceReferences.${i}`);
    exactKeys(ref, ['repository', 'commit'], `sourceReferences.${i}`);
    const repository = ref.repository;
    if (typeof repository !== 'string' || repository.length < 1 || repository.length > 1024 ||
        !repository.startsWith('https://') || /[\s\\?#]/u.test(repository) || nonPrinting.test(repository)) {
      throw new Error(`sourceReferences.${i}.repository: expected an HTTPS URL with host and path`);
    }
    let url: URL;
    try { url = new URL(repository); } catch { throw new Error(`sourceReferences.${i}.repository: expected an HTTPS URL with host and path`); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash ||
        !url.pathname.split('/').some(Boolean)) {
      throw new Error(`sourceReferences.${i}.repository: expected an HTTPS URL with host and path`);
    }
    if (typeof ref.commit !== 'string' || !commitShape.test(ref.commit)) {
      throw new Error(`sourceReferences.${i}.commit: expected 40 or 64 lowercase hex characters`);
    }
    return { repository, commit: ref.commit };
  });
  const review = record(body.isolationReview, 'isolationReview');
  exactKeys(review, reviewKeys, 'isolationReview');
  const checked = (key: string) => {
    const part = record(review[key], `isolationReview.${key}`);
    exactKeys(part, ['checked', 'evidence'], `isolationReview.${key}`);
    if (part.checked !== true) throw new Error(`isolationReview.${key}.checked: expected true`);
    return { checked: true as const, evidence: storeDriverReviewText(part.evidence, `isolationReview.${key}.evidence`) };
  };
  const met = (key: string) => {
    const part = record(review[key], `isolationReview.${key}`);
    exactKeys(part, ['met', 'evidence'], `isolationReview.${key}`);
    if (typeof part.met !== 'boolean') throw new Error(`isolationReview.${key}.met: expected a boolean`);
    return { met: part.met, evidence: storeDriverReviewText(part.evidence, `isolationReview.${key}.evidence`) };
  };
  const isolationReview = {
    separateScriptPerTenant: met('separateScriptPerTenant'),
    noOutboundAccess: met('noOutboundAccess'),
    envelopeVerifiedOutsideDriver: met('envelopeVerifiedOutsideDriver'),
    envelopeChecked: checked('envelopeChecked'),
    reservedOperationsChecked: checked('reservedOperationsChecked'),
    noModuleStateChecked: checked('noModuleStateChecked'),
  };
  if (typeof body.schema !== 'number' || !Number.isSafeInteger(body.schema) || body.schema < 0) {
    throw new Error('schema: expected a non-negative integer');
  }
  if (typeof body.className !== 'string' || body.className.length > 256 || !classShape.test(body.className)) {
    throw new Error('className: expected a Python class identifier');
  }
  if (!Array.isArray(body.operations) || body.operations.length > 256 ||
      body.operations.some((name) => typeof name !== 'string' || nonPrinting.test(name) || !storeCatalogOperation.safeParse(name).success)) {
    throw new Error('operations: expected at most 256 fixed catalog labels');
  }
  return { reason, sourceReferences, isolationReview, schema: body.schema, className: body.className, operations: body.operations as string[] };
}

function readReviewJson(path: string): unknown {
  if (statSync(path).size > MAX_REVIEW_FILE_BYTES) throw new Error(`${path}: review JSON exceeds ${MAX_REVIEW_FILE_BYTES} bytes`);
  const text = readFileSync(path, 'utf8');
  if (Buffer.byteLength(text) > MAX_REVIEW_FILE_BYTES) throw new Error(`${path}: review JSON exceeds ${MAX_REVIEW_FILE_BYTES} bytes`);
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error(`${path}: expected JSON`); }
}

export function approvalFromFiles(input: {
  reason: string; sourceReferencesFile: string; isolationReviewFile: string;
  schema: string; className: string; operations: string[];
}): StoreDriverApprovalBody {
  if (!/^(?:0|[1-9][0-9]*)$/.test(input.schema)) throw new Error('schema: expected a non-negative integer');
  return validateStoreDriverApproval({
    reason: input.reason,
    sourceReferences: readReviewJson(input.sourceReferencesFile),
    isolationReview: readReviewJson(input.isolationReviewFile),
    schema: Number(input.schema), className: input.className, operations: input.operations,
  });
}

export function approvalLines(result: StoreDriverApprovalResultView): string[] {
  const { approval, currentSchema } = result;
  return [
    `✓ approved ${approval.driver} ${approval.sha256} (approval ${approval.approvalId})`,
    `  schema ${approval.schema}; current good schema ${currentSchema ?? 'none'}`,
  ];
}

export function approvalStatusLines(view: StoreDriverView): string[] {
  if (!view.approvals) return [];
  if (view.approvals.length === 0) return ['  approvals: none'];
  return view.approvals.map((approval) => approval.revokedAt
    ? `  approval ${approval.approvalId} ${approval.sha256}: revoked ${approval.revokedAt} by ${approval.revokedBy}${approval.revokedEmergency ? ' (emergency)' : ''}; reason: ${approval.revokedReason}`
    : `  approval ${approval.approvalId} ${approval.sha256}: live, approved ${approval.approvedAt} by ${approval.approvedBy}; schema ${approval.schema}, class ${approval.className}, operations ${approval.operations.join(', ') || 'none'}`);
}

export function uploadApprovalLine(driver: string, sha256: string): string {
  return `  upload alone does not make these bytes runnable; a staff person approves them with: ` +
    `substrat store-driver approve --driver ${driver} --sha256 ${sha256} --reason <reason> ` +
    '--source-references <json-file> --isolation-review <json-file> --schema <n> --class-name <Class> [--operation <name> ...]';
}

/** Resume every server page; a busy or lost hold can be retried with the same command. */
export async function revokeStoreDriverUntilComplete(input: {
  client: { revokeStoreDriverRelease(driver: string, sha256: string, body: { reason: string; emergency?: boolean }): Promise<StoreDriverRevokeResultView> };
  driver: string; sha256: string; reason: string; emergency: boolean;
  progress: (line: string) => void;
}): Promise<StoreDriverRevokeResultView> {
  let result: StoreDriverRevokeResultView;
  do {
    try {
      result = await input.client.revokeStoreDriverRelease(input.driver, input.sha256,
        { reason: input.reason, ...(input.emergency ? { emergency: true } : {}) });
    } catch (error) {
      if (error instanceof ControlPlaneError && error.status === 409 && /hold|held|busy|rollout or push/i.test(error.message)) {
        throw new Error(`${error.message}; retry the same store-driver revoke command`);
      }
      throw error;
    }
    input.progress(result.complete
      ? `✓ revoked approval ${result.approval.approvalId} for ${input.driver} ${input.sha256}`
      : `  revoke walk paused: ${result.remaining} script(s) remaining; continuing`);
  } while (!result.complete);
  return result;
}
