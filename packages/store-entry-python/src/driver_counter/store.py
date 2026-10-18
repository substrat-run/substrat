"""The Python twin of the counter driver, for the probe only. It reports what the entry gave it.

Module-level state is what a real driver may not keep (D-63). This one keeps, per object, how
often it was constructed and when, so the probe can see that the entry constructs it once, and
not for a call it refused.
"""

import json

from js import Date, Object
from workers import DurableObject, Response

CONSTRUCTED = {}


def _json(value):
    return Response(json.dumps({"result": value}), headers={"content-type": "application/json"})


class CounterStore(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        seen = CONSTRUCTED.setdefault(ctx.id.toString(), {"count": 0, "at": None, "first_fetch": None})
        seen["count"] += 1
        seen["at"] = Date.now()
        self.sql = ctx.storage.sql
        self.sql.exec("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL, alarms INTEGER NOT NULL)")
        self.sql.exec("INSERT OR IGNORE INTO counter (id, n, alarms) VALUES (1, 0, 0)")

    async def fetch(self, request):
        seen = CONSTRUCTED[self.ctx.id.toString()]
        if seen["first_fetch"] is None:
            seen["first_fetch"] = Date.now()
        body = await request.text()
        payload = json.loads(body)
        operation = payload.get("operation")
        if operation in ("read", "substrat.size"):
            return _json(self._row().n)
        if operation == "increment":
            self.sql.exec("UPDATE counter SET n = n + 1 WHERE id = 1")
            return _json(self._row().n)
        if operation == "body":
            return _json(body)
        if operation == "constructed":
            # How often, and how long before the first call it served the last construction was.
            seen = CONSTRUCTED[self.ctx.id.toString()]
            return _json({"count": seen["count"], "lead_ms": seen["first_fetch"] - seen["at"]})
        if operation == "env":
            from workers import env as importable

            return _json({
                "given": sorted(str(key) for key in Object.keys(self.env._env)),
                "importable": sorted(str(key) for key in Object.keys(importable._env)),
                "exports": getattr(self.ctx, "exports", None) is not None,
            })
        if operation == "set-alarm":
            await self.ctx.storage.setAlarm(Date.now() + 200)
            return _json(True)
        if operation == "alarms":
            return _json(self._row().alarms)
        if operation == "vendored":
            import vendor_probe

            return _json({"label": vendor_probe.label(), "payload": vendor_probe.payload()})
        return Response("unknown operation", status=400)

    async def alarm(self, alarm_info=None):
        self.sql.exec("UPDATE counter SET alarms = alarms + 1 WHERE id = 1")

    def _row(self):
        return self.sql.exec("SELECT n, alarms FROM counter WHERE id = 1").one()
