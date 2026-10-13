"""The same counter store as src/store.mjs, in the Python Workers runtime.

Same envelope, same reserved operations, including substrat.size via the
object's SQLite databaseSize. No signature and no cross-script binding:
this file only answers whether a Python Durable Object can be that store.
"""

import json
from urllib.parse import parse_qs, urlparse

from workers import DurableObject, Response, WorkerEntrypoint


def _json(body, status=200):
    return Response(json.dumps(body), status=status, headers={"content-type": "application/json"})


class CounterStore(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.sql = ctx.storage.sql
        self.sql.exec(
            "CREATE TABLE IF NOT EXISTS counter ("
            "id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)"
        )
        self.sql.exec("INSERT OR IGNORE INTO counter (id, n) VALUES (1, 0)")

    async def fetch(self, request):
        try:
            payload = await request.json()
        except Exception:
            return _json({"error": {"code": "validation_failed", "status": 400, "body": {"reason": "json"}}}, 400)
        operation = payload.get("operation")
        incoming = payload.get("input") or {}
        try:
            if operation == "increment":
                by = incoming.get("by", 1)
                if not isinstance(by, int):
                    return _json({"error": {"code": "validation_failed", "status": 400, "body": {"reason": "by"}}}, 400)
                self.sql.exec("UPDATE counter SET n = n + ? WHERE id = 1", by)
                return _json({"result": {"count": self._count()}})
            if operation == "read":
                return _json({"result": {"count": self._count()}})
            if operation == "substrat.size":
                return _json({"result": {"bytes": self.sql.databaseSize}})
            if operation == "substrat.wipe":
                self.sql.exec("DELETE FROM counter")
                self.sql.exec("INSERT INTO counter (id, n) VALUES (1, 0)")
                return _json({"result": {"wiped": True}})
            return _json(
                {"error": {"code": "not_found", "status": 404, "body": {"operation": operation}}},
                404,
            )
        except Exception as err:
            return _json({"error": {"code": "internal", "status": 500, "body": {"message": str(err)}}}, 500)

    def _count(self):
        return self.sql.exec("SELECT n FROM counter WHERE id = 1").one().n


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        parsed = urlparse(request.url)
        query = parse_qs(parsed.query)
        name = (query.get("name") or [None])[0]
        operation = (query.get("op") or [None])[0]
        if not name or not operation:
            return _json({"error": {"code": "validation_failed", "status": 400, "body": {"reason": "name and op"}}}, 400)
        by = int((query.get("by") or ["1"])[0])
        stub = self.env.STORE.get(self.env.STORE.idFromName(name))
        return await stub.fetch(
            "https://store/",
            method="POST",
            headers={"content-type": "application/json"},
            body=json.dumps({"operation": operation, "input": {"by": by}}),
        )
