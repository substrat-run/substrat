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

Inside the object, a call passes the fence (store-entry/fence.ts, D-70) before it reaches the
driver, the same fence the JavaScript entry runs, from the same module. An object a deletion path
has fenced refuses it, whenever it was signed.

The body stays in JavaScript (#2811). The verifier module reads it once, bounded by STORE_CALL_MAX_BYTES
(a declared Content-Length over the limit is refused with 413 before the body is read, and a stream
that goes past it is refused at the limit), verifies it as the text those bytes decode to, and hands
back the bytes as an ArrayBuffer. That buffer is what the default entrypoint forwards to the object
and what the driver's Request is built over, so this module makes no Python string of the body: the
driver reads it as text only if it asks for text.
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
FENCE_OPERATION = "substrat.fence"
RESERVED_BINDING_PREFIX = "SUBSTRAT_STORE"


def _raw_env(env):
    """The JavaScript env the runtime handed over. The SDK wraps it, and has no public unwrap."""
    return env._env


def _driver_env(env):
    """The env the driver is constructed with: everything but the entry's own bindings."""
    entries = [entry for entry in Object.entries(_raw_env(env)) if not str(entry[0]).startswith(RESERVED_BINDING_PREFIX)]
    return Object.fromEntries(entries)


def _refusal(verified):
    """The response for a refused call. A 410, a 413 and a fence's 503 are the store envelope's error, which names its content type."""
    content_type = getattr(verified, "contentType", None)
    headers = {"content-type": content_type} if content_type else None
    return Response(verified.message, status=verified.status, headers=headers)


async def _verified(request, env):
    """The call read once and verified (its envelope and its body as a JavaScript ArrayBuffer), or the refusal."""
    verifier = import_from_javascript(VERIFIER_MODULE)
    verified = await verifier.verifiedStoreCall(request.js_object, _raw_env(env))
    return verified if verified.ok else _refusal(verified)


def _driver_request(url, body):
    return Request(url, method="POST", headers={"content-type": "application/json"}, body=body)


class SubstratStoreObject(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self._driver = None
        self._fence = None

    def _driver_object(self):
        """Constructed once per object instance, on first use, so the driver keeps its in-memory state."""
        if self._driver is None:
            self._driver = StoreDriver(self.ctx, _driver_env(self.env))
        return self._driver

    def _fence_of(self):
        """One fence per object instance, as in the JavaScript entry. The verifier module holds it.

        The fence is JavaScript and calls this storage after this function has returned, so it is
        handed the JavaScript object. Under workers-runtime-sdk's DurableObjectContext, ctx.storage is
        a Python wrapper that reaches JavaScript as a borrowed proxy, destroyed when the call returns,
        and every call would then fail. create_proxy is not the answer: a proxy's .get may be Python's
        __getitem__, so the mark would read as absent and the fence would fail open.
        """
        if self._fence is None:
            state = getattr(self.ctx, "_ctx", self.ctx)
            self._fence = import_from_javascript(VERIFIER_MODULE).storeObjectFence(state.storage)
        return self._fence

    async def fetch(self, request):
        call = await _verified(request, self.env)
        if isinstance(call, Response):
            return call
        namespace = getattr(self.env, OBJECT_BINDING)
        if not self.ctx.id.equals(namespace.idFromName(call.envelope.name)):
            return Response("unauthorized: object", status=401)
        fence = self._fence_of()
        if call.envelope.op == FENCE_OPERATION:
            closed = await fence.close()
            if not closed.ok:
                return _refusal(closed)
            body = import_from_javascript(VERIFIER_MODULE).storeFenceWipeBody(call.body)
            try:
                return await self._driver_object().fetch(_driver_request(request.url, body))
            finally:
                await fence.reassert()
        admitted = await fence.admit(call.envelope)
        if not admitted.ok:
            return _refusal(admitted)
        try:
            return await self._driver_object().fetch(_driver_request(request.url, call.body))
        finally:
            await fence.leave()

    async def alarm(self, alarm_info=None):
        """An alarm is the object's own timer, which only the driver sets. It goes to the driver, unless the object is fenced."""
        fence = self._fence_of()
        if not await fence.admitAlarm():
            return
        try:
            driver = self._driver_object()
            if hasattr(driver, "alarm"):
                await driver.alarm(alarm_info)
        finally:
            await fence.leave()


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        call = await _verified(request, self.env)
        if isinstance(call, Response):
            return call
        namespace = getattr(self.env, OBJECT_BINDING)
        stub = namespace.get(namespace.idFromName(call.envelope.name))
        return await stub.fetch(request.url, method="POST", headers=request.js_object.headers, body=call.body)
