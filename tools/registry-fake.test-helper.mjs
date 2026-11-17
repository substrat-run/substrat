/**
 * A registry that serves a version on its own clock, as npm does (#3260): `publish` makes
 * the packument list it `listAfterMs` later and the tarball answer 200 `tarballAfterMs` later.
 * Time moves only through `sleep`, so a test waits for nothing real. No network is touched.
 */
export const REGISTRY = 'https://registry.test';

export function fakeRegistry() {
  let clock = 0;
  const versions = new Map(); // name → Map(version → { listedAt, tarballAt })
  const requests = [];
  const tarballUrl = (name, version) => `${REGISTRY}/${name}/-/${name.split('/').pop()}-${version}.tgz`;

  const publish = (name, version, { listAfterMs = 0, tarballAfterMs = listAfterMs } = {}) => {
    if (!versions.has(name)) versions.set(name, new Map());
    versions.get(name).set(version, { listedAt: clock + listAfterMs, tarballAt: clock + tarballAfterMs });
  };

  const fetch = async (url, init = {}) => {
    requests.push({ url, method: init.method ?? 'GET', at: clock });
    if (url.endsWith('.tgz')) {
      for (const [name, byVersion] of versions) {
        for (const [version, at] of byVersion) {
          if (tarballUrl(name, version) === url) return { status: clock >= at.tarballAt ? 200 : 404, ok: clock >= at.tarballAt };
        }
      }
      return { status: 404, ok: false };
    }
    const name = decodeURIComponent(url.slice(REGISTRY.length + 1));
    const byVersion = versions.get(name);
    if (!byVersion) return { status: 404, ok: false };
    const listed = Object.fromEntries(
      [...byVersion].filter(([, at]) => clock >= at.listedAt).map(([version]) => [version, { dist: { tarball: tarballUrl(name, version) } }]),
    );
    return { status: 200, ok: true, json: async () => ({ name, versions: listed }) };
  };

  return {
    publish,
    fetch,
    requests,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
}

/** A members map the way `pnpmMembers` returns one, from `{ name: [version, deps, extra] }`. */
export function membersOf(spec) {
  return new Map(
    Object.entries(spec).map(([name, [version, dependencies = {}, extra = {}]]) => [
      name,
      { version, private: extra.private === true, manifest: { name, version, dependencies, ...extra } },
    ]),
  );
}
