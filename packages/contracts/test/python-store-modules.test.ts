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
    // The twins of the reserved names: a package that only starts like one is its own name.
    'python_modules/jsonschema/__init__.py',
    'python_modules/typing_extensions.py',
    'python_modules/asyncio_helpers/__init__.py',
    'python_modules/workersx/__init__.py',
    'python_modules/asgiref/__init__.py',
    'python_modules/pyodide_helpers/__init__.py',
    'python_modules/sitecustomize_tools/x.py',
    'python_modules/_cffi_backend.cpython-313-wasm32-emscripten.so',
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
    // #2391 finding 4: the rest of what the runtime and the SDK provide, and the standard library.
    ['python_modules/workers.cpython-312-wasm32-emscripten.so', /top-level name 'workers'/],
    ['python_modules/asgi.py', /top-level name 'asgi': it is the workers runtime SDK/],
    ['python_modules/_cloudflare_compat_flags.pyi', /top-level name '_cloudflare_compat_flags'/],
    ['python_modules/_pyodide/__init__.py', /top-level name '_pyodide': the Python workers runtime provides it/],
    ['python_modules/_pyodide_entrypoint_helper.pyi', /top-level name '_pyodide_entrypoint_helper'/],
    ['python_modules/pyodide_js.py', /top-level name 'pyodide_js'/],
    ['python_modules/sitecustomize.py', /top-level name 'sitecustomize': the interpreter runs it when it starts/],
    ['python_modules/usercustomize.py', /top-level name 'usercustomize'/],
    ['python_modules/__main__.py', /top-level name '__main__'/],
    ['python_modules/json/__init__.py', /top-level name 'json': it is in Python's standard library/],
    ['python_modules/json.py', /top-level name 'json'/],
    ['python_modules/hashlib.py', /top-level name 'hashlib'/],
    ['python_modules/asyncio/__init__.py', /top-level name 'asyncio'/],
    ['python_modules/_json.cpython-313-wasm32-emscripten.so', /top-level name '_json'/],
    ['python_modules/typing.py', /top-level name 'typing'/],
    ['python_modules/__future__.py', /top-level name '__future__'/],
    ['python_modules/_sysconfigdata__emscripten_wasm32-emscripten.py', /top-level name '_sysconfigdata__emscripten_wasm32': it is in Python's standard library/],
    ['python_modules/pkg/extra.pth', /a path file runs code/],
    ['python_modules/pyvenv.cfg', /virtual environment/],
    ['python_modules/pkg/marker.synced', /sync marker/],
    // The two markers `substrat store-driver upload` skips are still refused by the upload's own rule.
    ['python_modules/.synced', /sync marker/],
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
