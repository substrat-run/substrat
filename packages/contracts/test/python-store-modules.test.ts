import { describe, expect, it } from 'vitest';
import { classifyPythonStoreModule } from '../src/deploy.js';

/** The module rule of a Python store-driver release (#2390), refused by table and admitted by twin. */
describe('classifyPythonStoreModule', () => {
  it.each([
    ['driver_graph/store.py', 'driver_graph'],
    ['driver_graph/sub/mod.py', 'driver_graph'],
  ])('reads %s as a driver module of %s', (name, packageName) => {
    expect(classifyPythonStoreModule(name)).toEqual({ kind: 'driver', packageName });
  });

  it.each([
    'python_modules/six.py',
    'python_modules/vendor_probe/__init__.py',
    'python_modules/vendor_probe/payload.txt',
    'python_modules/vendor_probe-1.0.dist-info/METADATA',
    'python_modules/attrs/__init__.py',
    // A reserved name further down a vendored package is that package's own module, not a top-level one.
    'python_modules/vendor_probe/workers.py',
    'python_modules/vendor_probe/json/__init__.py',
    'python_modules/my_driver_helpers/x.py',
  ])('admits %s as vendored', (name) => {
    expect(classifyPythonStoreModule(name)).toEqual({ kind: 'vendored' });
  });

  it.each([
    ['python_modules/driver_other/x.py', /top-level name 'driver_other': it takes the driver package prefix/],
    ['python_modules/driver_other.py', /top-level name 'driver_other'/],
    ['python_modules/substrat_store/x.py', /top-level name 'substrat_store': it takes the entry's prefix/],
    ['python_modules/workers/__init__.py', /top-level name 'workers': it is the workers runtime SDK/],
    ['python_modules/workers.py', /top-level name 'workers'/],
    ['python_modules/workers/workflows.js', /top-level name 'workers'/],
    ['python_modules/workers-py/x.py', /top-level name 'workers'/],
    ['python_modules/workers_runtime_sdk-1.9.3.dist-info/METADATA', /top-level name 'workers_runtime_sdk'/],
    ['python_modules/_workers_sdk_patch_loader.py', /top-level name '_workers_sdk_patch_loader'/],
    ['python_modules/js/ffi.py', /top-level name 'js': the Python workers runtime provides it/],
    ['python_modules/pyodide/ffi.py', /top-level name 'pyodide'/],
    ['python_modules/pkg/extra.pth', /a path file runs code/],
    ['python_modules/pyvenv.cfg', /virtual environment/],
    ['python_modules/pkg/marker.synced', /sync marker/],
    ['python_modules/../store.py', /does not climb/],
    ['/python_modules/six.py', /relative/],
    ['C:/python_modules/six.py', /relative/],
    ['python_modules\\six.py', /backslash/],
    ['python_modules/.hidden/x.py', /relative segments/],
    ['wrangler.toml', /a dependency is python_modules/],
  ])('refuses %s', (name, why) => {
    expect(() => classifyPythonStoreModule(name)).toThrow(why);
  });
});
