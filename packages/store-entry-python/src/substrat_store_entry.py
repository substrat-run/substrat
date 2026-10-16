"""The platform's Python store entry (#2290), the twin of store-entry/entry.ts.

Uploaded as the store script's main module when the driver is Python. The driver's class is
imported through the two placeholders below, which the upload replaces with the driver's module
name and class name, as it does for the JavaScript entry. The driver is reached only through
this module, after the call is verified.

There is one verifier. Every call is checked by store-entry/verify.ts, bundled as an ES module
the upload ships beside this one and imported through the runtime's JavaScript bridge. It runs
contracts' verifyScopeStoreCall (RFC scope-stores section 10.3, checks 1-4) against the script
name and both audiences' public keys this upload was given. This module parses no envelope, so
it cannot disagree with the JavaScript entry about one. The default entrypoint addresses
SubstratStoreObject by idFromName of the signed name. The object checks the call again, and
refuses unless its own id is the id of that name (check 5), before the driver is constructed: an
object is bound to one name by construction, with nothing stored that the driver could rewrite.

The body is read once, verified as that string, and that same string is what the driver receives.
The driver is constructed once per object instance with the object's ctx and an env with none of
the entry's SUBSTRAT_STORE* bindings. The upload sets disallow_importable_env and
disable_ctx_exports, and both apply to a Python script: `from workers import env` then reads an
empty env, and ctx.exports is absent.

What this is not: a boundary against a hostile driver, and it is weaker here than in JavaScript.
Python has no private fields. The driver's module is imported by this one, before this module's
body has finished, and runs in the same interpreter: it can reach this module through
sys.modules and replace its functions, and it can reach the entry's object, its full env and the
store namespace in it, through the garbage collector. The env strip and the cached driver keep a
careless driver away from the entry's bindings, not a hostile one. A driver written to interfere is
stopped by the review of its release (D-63), not by this module.
"""

from workers import DurableObject, Request, Response, WorkerEntrypoint, import_from_javascript
from js import Object

from __SUBSTRAT_STORE_DRIVER__ import __SUBSTRAT_STORE_CLASS__ as StoreDriver

# Each of these is a name in store-entry/names.ts; test/python-entry.test.ts holds them equal.
VERIFIER_MODULE = "./substrat-store-verify.js"
OBJECT_BINDING = "SUBSTRAT_STORE"
RESERVED_BINDING_PREFIX = "SUBSTRAT_STORE"


def _raw_env(env):
    """The JavaScript env the runtime handed over. The SDK wraps it, and has no public unwrap."""
    return env._env


def _driver_env(env):
    """The env the driver is constructed with: everything but the entry's own bindings."""
    entries = [entry for entry in Object.entries(_raw_env(env)) if not str(entry[0]).startswith(RESERVED_BINDING_PREFIX)]
    return Object.fromEntries(entries)


async def _verified(request, body, env):
    """The verified envelope's object name, or the response that refuses the call."""
    verifier = import_from_javascript(VERIFIER_MODULE)
    verdict = await verifier.storeCallVerdict(request.js_object.headers, body, _raw_env(env))
    if not verdict.ok:
        return Response(verdict.message, status=verdict.status)
    return verdict.envelope.name


def _driver_request(url, body):
    return Request(url, method="POST", headers={"content-type": "application/json"}, body=body)


class SubstratStoreObject(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self._driver = None

    def _driver_object(self):
        """Constructed once per object instance, on first use, so the driver keeps its in-memory state."""
        if self._driver is None:
            self._driver = StoreDriver(self.ctx, _driver_env(self.env))
        return self._driver

    async def fetch(self, request):
        body = await request.text()
        name = await _verified(request, body, self.env)
        if isinstance(name, Response):
            return name
        namespace = getattr(self.env, OBJECT_BINDING)
        if not self.ctx.id.equals(namespace.idFromName(name)):
            return Response("unauthorized: object", status=401)
        return await self._driver_object().fetch(_driver_request(request.url, body))

    async def alarm(self, alarm_info=None):
        """An alarm is the object's own timer, which only the driver sets. It goes to the driver."""
        driver = self._driver_object()
        if hasattr(driver, "alarm"):
            await driver.alarm(alarm_info)


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        body = await request.text()
        name = await _verified(request, body, self.env)
        if isinstance(name, Response):
            return name
        namespace = getattr(self.env, OBJECT_BINDING)
        stub = namespace.get(namespace.idFromName(name))
        return await stub.fetch(request.url, method="POST", headers=request.js_object.headers, body=body)
