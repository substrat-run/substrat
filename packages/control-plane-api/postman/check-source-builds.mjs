import assert from 'node:assert/strict';
import { sourceBuildService } from '../dist/source-builds.js';
const base = process.argv[2];
if (!base) throw new Error('pass the simulation member URL');
const service = sourceBuildService({
  fetch: (request) => fetch(new Request(`${base}${new URL(request.url).pathname}`, request)),
}, 'fixture-service-token');
const revision = 'a'.repeat(40);
const result = await service.build('tenant-a', 'acme/demo', { version: '1.0.0', revision });
assert.equal(result.projectId, 'project-tenant-a');
assert.equal(result.revision, revision);
assert.equal(await result.form.get('worker.js').text(), 'export default {}');
assert.equal(result.form.has('buildResult'), false);
for (const [version, status, message] of [
  ['failed', 422, /dependency installation failed/],
  ['unavailable', 503, /sandbox capacity unavailable/],
  ['malformed', 502, /release identity/],
]) {
  await assert.rejects(() => service.build('tenant-a', 'acme/demo', { version, revision }), (error) => error.status === status && message.test(error.message));
}
const projects = await service.projects('tenant-b', new Request('https://source/projects'));
assert.equal((await projects.json()).tenant, 'tenant-b');
await assert.rejects(() => sourceBuildService(undefined, undefined).build('tenant-a', 'demo', { version: '1.0.0', revision }), (error) => error.status === 503);
console.log('source build HTTP checks passed: multipart, tenant context, 422, 503, malformed output and missing binding');
