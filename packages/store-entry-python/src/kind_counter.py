"""The Python twin of the counter kind. Its count moves only after the entry constructed it."""

import json

from workers import DurableObject, Response


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
        payload = await request.json()
        operation = payload.get("operation")
        incoming = payload.get("input") or {}
        if operation == "read":
            return Response(json.dumps({"result": self._count()}), headers={"content-type": "application/json"})
        by = incoming.get("by", 1)
        if not isinstance(by, int):
            return Response("bad by", status=400)
        self.sql.exec("UPDATE counter SET n = n + ? WHERE id = 1", by)
        return Response(json.dumps({"result": self._count()}), headers={"content-type": "application/json"})

    def _count(self):
        return self.sql.exec("SELECT n FROM counter WHERE id = 1").one().n
