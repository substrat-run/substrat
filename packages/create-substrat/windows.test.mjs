// The long-path offer `npm create substrat` makes on Windows (windows.js), with a stand-in
// system: no test reads or writes the real registry, or raises a permission prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELEVATE_LONG_PATHS_SCRIPT, offerLongPaths, parseLongPaths } from './windows.js';

const ON = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\r\n    LongPathsEnabled    REG_DWORD    0x1\r\n';
const OFF = ON.replace('0x1', '0x0');

function system(opts = {}) {
  const { platform = 'win32', registry = OFF, interactive = true, elevate = (set) => set(ON) } = opts;
  // Not a default parameter: an `answer` of undefined (input ended) must stay undefined, not Enter.
  const answer = 'answer' in opts ? opts.answer : '';
  let value = registry;
  const sys = {
    platform,
    interactive,
    asked: 0,
    elevations: 0,
    query: () => value,
    ask: async () => {
      sys.asked++;
      return answer;
    },
    elevate: () => {
      sys.elevations++;
      elevate((v) => (value = v));
    },
  };
  return sys;
}

test('parseLongPaths reads reg query, and an absent value is off', () => {
  assert.equal(parseLongPaths(ON), true);
  assert.equal(parseLongPaths(OFF), false);
  assert.equal(parseLongPaths(undefined), false);
});

test('macOS, Linux, and a Windows that already has them on: nothing asked, nothing printed', async () => {
  for (const sys of [system({ platform: 'darwin' }), system({ platform: 'linux' }), system({ registry: ON })]) {
    assert.deepEqual(await offerLongPaths(sys), []);
    assert.equal(sys.asked + sys.elevations, 0);
  }
});

test('Enter (yes): Windows is asked once, and success is said only after the registry shows it', async () => {
  const sys = system({ answer: '' });
  const lines = await offerLongPaths(sys);
  assert.equal(sys.elevations, 1);
  assert.match(lines.join('\n'), /✓ Windows long paths turned on/);
});

test('yes, then the permission prompt declined: still off, and how to do it later', async () => {
  const sys = system({ answer: 'y', elevate: () => { throw new Error('The operation was canceled by the user.'); } });
  const lines = await offerLongPaths(sys);
  assert.equal(sys.elevations, 1);
  assert.match(lines.join('\n'), /still off[\s\S]*doctor --fix/);
});

test('no, or input that ends: nothing changed, and how to do it later', async () => {
  for (const answer of ['n', 'no', undefined]) {
    const sys = system({ answer });
    const lines = await offerLongPaths(sys);
    assert.equal(sys.elevations, 0, String(answer));
    assert.match(lines.join('\n'), /Left off[\s\S]*doctor --fix/);
  }
});

test('no terminal (a coding agent): never asks, never elevates, says how', async () => {
  const sys = system({ interactive: false });
  const lines = await offerLongPaths(sys);
  assert.equal(sys.asked + sys.elevations, 0);
  assert.match(lines.join('\n'), /long paths are off[\s\S]*npx @substrat-run\/cli doctor --fix/);
});

test('the elevated command is fixed text, the same one `substrat doctor --fix` runs', () => {
  assert.equal(
    ELEVATE_LONG_PATHS_SCRIPT,
    "Start-Process -FilePath reg.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList 'add','HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem','/v','LongPathsEnabled','/t','REG_DWORD','/d','1','/f'",
  );
});
