# Runbook: the scope no-network spike on a real dispatch namespace

This is run by a person who holds a Cloudflare credential, on a **test** account. It is never run on
the production account, and never against the platform's own namespace or scripts. Everything it
creates has a name starting `substrat-spike-scope-net`, and step 7 removes all of it. No tenant data
is involved. The probes reach `example.com` and `example.org` only.

It answers what [README.md](README.md) could not show locally:

| # | Question | Step |
| --- | --- | --- |
| 1 | The outbound worker refuses a worker-context `fetch()` and not a Durable Object's (D-46's limit, re-shown on one run) | 4a, 4b |
| 2 | Whether the outbound worker also closes `connect()` for a Durable Object, or only for worker context | 4a, 4b |
| 3 | A facet loaded with `globalOutbound: null` refuses every exit on the edge (D-70 showed `fetch` and `connect`; this adds the rest) | 4c |
| 4 | `ctx.exports` works in a namespace script, and a policy entrypoint as `globalOutbound` passes a declared host and refuses another | 4d |
| 5 | Whether a facet may hold its own alarm on the edge, and that the supervisor-held alarm reaches it | 4e |
| 6 | A hibernatable WebSocket accepted by the facet answers through the namespace | 4f |
| 7 | The loader env is cached with the code on the edge too | 4g |
| 8 | The facet hop, and the cold start of a 2 MB JavaScript scope bundle, on the edge | 4h |
| 9 | Whether Dynamic Workers bill per loader id or per isolate | 6 |

## 0. Before you start

- Node 22 and pnpm 10, from `spikes/scope-no-network/`, after `pnpm install --ignore-workspace`.
- A test account on Workers Paid with Workers for Platforms. Dynamic Workers need the Paid plan.
- `npx wrangler login`, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment, with
  Workers Scripts edit and Workers for Platforms edit.
- `node run-local.mjs` passes. A `FAIL` there is a problem with the spike: stop, and report it.

```
export T=$(node -e "console.log(crypto.randomUUID())")
```

## 1. The outbound worker

```
cd outbound && npx wrangler deploy && cd ..
```

## 2. The namespace and its two scripts

Pad the scope bundle to 2 MB for step 4h, deploy, then put the placeholder back:

```
npx wrangler dispatch-namespace create substrat-spike-scope-net
node -e "require('fs').writeFileSync('src/pad.js','export default '+JSON.stringify('x'.repeat(2*1024*1024))+';\n')"
npx wrangler deploy -c wrangler.plain.jsonc --dispatch-namespace substrat-spike-scope-net
npx wrangler deploy -c wrangler.supervisor.jsonc --dispatch-namespace substrat-spike-scope-net --var DECLARED_HOST:example.com
git checkout src/pad.js
```

**Expect** the supervisor's deploy to list `env.LOADER` and both Durable Objects. **If it is refused**,
paste the refusal: it answers question 4.

## 3. The dispatcher

```
cd dispatcher && npx wrangler deploy --var SPIKE_TOKEN:$T && cd ..
export U=https://substrat-spike-scope-net-dispatcher.<subdomain>.workers.dev
p() { curl -s -X POST -H "x-spike-token: $T" "$U$1"; echo; }
```

A new script can take about 15 seconds to answer everywhere (K-28). If the first call reads
`Worker not found`, wait a minute.

## 4. Probe

`S` is the probe target. The probe's `http` and `tcp` ports are both 80, because raw TCP to port 80 is
enough to show a socket opened.

```
S='host=example.com&http=80&tcp=80'
```

**a. Worker context, behind the outbound worker.**
`p "/worker-exits?script=plain&label=w&$S"`. Expect `fetch` → `403` with *refused by the namespace
outbound worker*, and `connect` failing.

**b. The plain Durable Object, behind the same outbound worker.**
`p "/exits?script=plain&object=p1&label=p&$S"`. Expect `fetch` → `200`, which is D-46's limit. **Paste
back `connect` and `node-net` whatever they say.** They answer question 2.

**c. The facet, network closed.**
`p "/exits?script=supervisor&net=closed&object=c1&label=c&$S"`. Expect every one of `fetch`,
`fetch-prototype`, `fetch-upgrade`, `websocket`, `connect`, `node-net` to be `ok: false`, `node-http`
to fail, and `envKeys` to be `["CONTROL_PLANE","SCOPE_WORK"]`.

**d. The facet, policy egress.**
`p "/exits?script=supervisor&net=policy&object=d1&label=d&$S"`, then the same with
`host=example.org&http=80&tcp=80` and `object=d2`. Expect `fetch` → `200` for `example.com` and `403`
with *egress refused: example.org is not in acme's declared outbound hosts* for `example.org`.

**e. Alarms.**
`p "/alarm-set?script=supervisor&net=closed&object=e1"`: **paste back the answer**, success or the
error text. Then `p "/supervised-alarm-set?script=supervisor&net=closed&object=e2"`, wait five
seconds, and `p "/alarm-read?script=supervisor&net=closed&object=e2"`. Expect `fired` ≥ 1. Do the same
read for `e1` if its set succeeded.

**f. A hibernatable WebSocket through the facet.**

```
node -e "const ws=new WebSocket(process.argv[1]);ws.onopen=()=>ws.send('hello');ws.onmessage=e=>{console.log(e.data);ws.close()};ws.onerror=e=>console.log('error',e.message)" \
  "${U/https/wss}/ws?script=supervisor&net=closed&object=f1&token=$T"
```

Expect `echo:hello`.

**g. The loader env, cached with the code.**
`p "/whoami-env?script=supervisor&object=g1"` and `p "/whoami-env?script=supervisor&object=g2"`, then
`p "/whoami-arg?script=supervisor&object=g1"` and the same for `g2`. Expect `viaEnv.scope` to name
something other than the object asking, at least for one of the two, and `viaArgument.scope` to name
the object asking, every time. **Paste back all four.**

**h. Timing.**
`p "/bench?script=supervisor&object=h1&n=200"`. Then, for the cold start, time three fresh objects:

```
for o in h2 h3 h4; do curl -s -o /dev/null -w "$o %{time_total}\n" -X POST -H "x-spike-token: $T" "$U/ping?script=supervisor&net=closed&pad=1&object=$o"; done
for i in 1 2 3; do curl -s -o /dev/null -w "warm %{time_total}\n" -X POST -H "x-spike-token: $T" "$U/ping?script=supervisor&net=closed&pad=1&object=h4"; done
```

Run step 4 twice more, about five minutes apart, with fresh object names (`c2`, `d3`, … `h5`…).

**Paste back** every answer from all three runs.

## 5. Errors

In the dashboard, open Workers for Platforms → `substrat-spike-scope-net` → the supervisor → Metrics.
**Paste back** any `exceededMemory`, `exceededCpu` or error outcome over the runs.

## 6. Cost

The day after, open Billing → Usage, or read `GET /client/v4/accounts/<account>/paygo-usage`, and paste
back the number of Dynamic Workers billed and the amount. To compare: the probes use three loader ids
(`closed`, `policy`, and the padded `closed`) across about twenty objects. A count near three says the
bill counts ids. A count near the number of objects says it counts isolates.

## 7. Remove everything

```
npx wrangler delete --name substrat-spike-scope-net-dispatcher
for s in plain supervisor; do curl -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/dispatch/namespaces/substrat-spike-scope-net/scripts/substrat-spike-scope-net-$s?force=true"; done
npx wrangler dispatch-namespace delete substrat-spike-scope-net
npx wrangler delete --name substrat-spike-scope-net-outbound
```

`force=true` because both scripts hold a Durable Object class. Then `dispatch-namespace list` should no
longer name it.
