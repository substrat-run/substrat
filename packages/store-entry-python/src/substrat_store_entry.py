"""The platform's Python store entry (#2290).

The kind's class is imported on the line marked below. The upload replaces that
one line. This copy imports the counter so the package's own probe can run.

The default entry addresses SubstratStoreObject by the envelope's name. The
object checks the envelope and the first name it accepted before it constructs
the kind. Ed25519 goes through the worker's WebCrypto, which Pyodide exposes
as ``crypto.subtle``.
"""

import base64
import hashlib
import json

from js import Object, TextEncoder, crypto
from pyodide.ffi import to_js
from workers import DurableObject, Request, Response, WorkerEntrypoint

# __SUBSTRAT_STORE_KIND_IMPORT__
from kind_counter import CounterStore as StoreKind

NAME_KEY = "__substrat_store_name"
WINDOW_SECONDS = 60


def _b64url(value: str) -> bytes | None:
    if not value or any(ch not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for ch in value):
        return None
    try:
        pad = "=" * ((4 - len(value) % 4) % 4)
        return base64.urlsafe_b64decode(value + pad)
    except Exception:
        return None


def _vertical(name: str) -> str | None:
    parts = name.split("/")
    if len(parts) < 4 or any(part == "" for part in parts):
        return None
    return "/".join(parts[1:-2])


def _parse(canonical: str) -> dict | None:
    lines = canonical.split("\n")
    if len(lines) != 7:
        return None
    version, aud, name, op, digest, iat_text, nonce = lines
    if version != "1" or aud not in ("caller", "platform"):
        return None
    if not name or not op or not nonce or len(digest) != 64:
        return None
    if any(ch not in "0123456789abcdef" for ch in digest):
        return None
    if not iat_text.lstrip("-").isdigit():
        return None
    return {"aud": aud, "name": name, "op": op, "digest": digest, "iat": int(iat_text)}


async def _verify(public_key: str, canonical: str, signature: str) -> bool:
    raw = _b64url(public_key)
    sig = _b64url(signature)
    if raw is None or sig is None:
        return False
    algorithm = to_js({"name": "Ed25519"}, dict_converter=Object.fromEntries)
    key = await crypto.subtle.importKey("raw", to_js(raw), algorithm, False, to_js(["verify"]))
    return bool(await crypto.subtle.verify("Ed25519", key, to_js(sig), TextEncoder.new().encode(canonical)))


async def _accepted(request, body: str, env) -> dict | None:
    header = request.headers.get("x-substrat-store-envelope")
    signature = request.headers.get("x-substrat-store-signature")
    if not header or not signature:
        return None
    raw = _b64url(header)
    if raw is None:
        return None
    canonical = raw.decode("utf-8")
    envelope = _parse(canonical)
    if envelope is None:
        return None
    reserved = envelope["op"].startswith("substrat.")
    if reserved != (envelope["aud"] == "platform"):
        return None
    now = int(__import__("time").time())
    if abs(now - envelope["iat"]) > WINDOW_SECONDS:
        return None
    if hashlib.sha256(body.encode("utf-8")).hexdigest() != envelope["digest"]:
        return None
    if _vertical(envelope["name"]) != getattr(env, "SUBSTRAT_STORE_VERTICAL", None):
        return None
    public = env.SUBSTRAT_STORE_PLATFORM_KEY if envelope["aud"] == "platform" else env.SUBSTRAT_STORE_CALLER_KEY
    if not public or not await _verify(public, canonical, signature):
        return None
    try:
        parsed = json.loads(body)
    except Exception:
        return None
    if not isinstance(parsed, dict) or parsed.get("operation") != envelope["op"]:
        return None
    return envelope


def _unauthorized():
    return Response("unauthorized", status=401)


class SubstratStoreObject(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)

    async def fetch(self, request):
        body = await request.text()
        accepted = await _accepted(request, body, self.env)
        if accepted is None:
            return _unauthorized()
        remembered = await self.ctx.storage.get(NAME_KEY)
        if remembered is None:
            await self.ctx.storage.put(NAME_KEY, accepted["name"])
        elif remembered != accepted["name"]:
            return _unauthorized()
        kind = StoreKind(self.ctx, self.env)
        return await kind.fetch(
            Request(
                "https://kind/",
                method="POST",
                headers={"content-type": "application/json"},
                body=body,
            )
        )


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        body = await request.text()
        accepted = await _accepted(request, body, self.env)
        if accepted is None:
            return _unauthorized()
        # The probe sets this to deliver a valid envelope for one name to the
        # object that remembers another. An upload does not set it.
        target = accepted["name"]
        if getattr(self.env, "SUBSTRAT_STORE_ALLOW_ADDRESS", None) == "1":
            from urllib.parse import parse_qs, urlparse

            asked = (parse_qs(urlparse(request.url).query).get("object") or [None])[0]
            if asked:
                target = asked
        stub = self.env.SUBSTRAT_STORE.get(self.env.SUBSTRAT_STORE.idFromName(target))
        return await stub.fetch(
            request.url,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-substrat-store-envelope": request.headers.get("x-substrat-store-envelope"),
                "x-substrat-store-signature": request.headers.get("x-substrat-store-signature"),
            },
            body=body,
        )
