"""The Python probe driver, the twin of probe-driver.js.

Loaded by the supervisor through the Worker Loader and run as a facet of its object. The mark is
module-level on purpose: it shows which isolate answered.
"""

import json
import random

from js import Object, fetch as js_fetch
from workers import DurableObject, Response, import_from_javascript

from version import VERSION

_MARK = []


def _mark():
    """Set on the isolate's first call, kept after: which isolate answered."""
    if not _MARK:
        _MARK.append("%032x" % random.getrandbits(128))
    return _MARK[0]


def _json(value):
    return Response(json.dumps(value), headers={"content-type": "application/json"})


async def _attempt(run):
    try:
        return {"ok": True, "value": await run()}
    except Exception as err:  # noqa: BLE001 - the spike reports whatever the runtime raises
        return {"ok": False, "error": str(err)}


async def _fetch():
    response = await js_fetch("https://example.com/")
    return response.status


async def _connect():
    sockets = import_from_javascript("cloudflare:sockets")
    socket = sockets.connect("example.com:80")
    await socket.opened
    await socket.close()
    return "opened"


def _heap_bytes():
    try:
        import pyodide_js

        return pyodide_js._module.HEAP8.length
    except Exception as err:  # noqa: BLE001
        return str(err)


class ProbeDriver(DurableObject):
    async def fetch(self, request):
        op = request.url.rsplit("/", 1)[-1]
        sql = self.ctx.storage.sql
        if op == "mark":
            return _json({"mark": _mark(), "version": VERSION, "heap": _heap_bytes()})
        if op == "network":
            return _json({"fetch": await _attempt(_fetch), "connect": await _attempt(_connect)})
        if op == "env":
            try:
                keys = [str(k) for k in Object.keys(self.env._env)]
            except Exception as err:  # noqa: BLE001
                keys = str(err)
            return _json({"env": keys})
        if op == "write":
            sql.exec("CREATE TABLE IF NOT EXISTS facet_rows (n INTEGER)")
            sql.exec("INSERT INTO facet_rows (n) VALUES (1)")
            return _json({"rows": sql.exec("SELECT count(*) AS c FROM facet_rows").one().c})
        if op == "read":
            tables = [r.name for r in sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_cf_*' ORDER BY name").toArray()]
            rows = sql.exec("SELECT count(*) AS c FROM facet_rows").one().c if "facet_rows" in tables else 0
            return _json({"tables": tables, "rows": rows, "version": VERSION})
        return _json({"error": "unknown operation " + op})


class HeapProbe(DurableObject):
    """A second class in the same loaded worker: the heap of the isolate the driver runs in."""

    async def fetch(self, request):
        return _json({"heap": _heap_bytes()})
