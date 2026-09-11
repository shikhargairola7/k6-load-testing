# vikexpress load test — token → routing-number query cycle

Load test for a 2-call API cycle against the **authorized sandbox**
`https://sandbox.api.vikexpress.com`, built with [k6](https://k6.io/).

```
Cycle Start
    │
    ▼
POST /rest-api/profile-access/token        ← API 1, returns access token
    │  token
    ▼
POST /rest-api/wallet/report/routing-number/query   ← API 2, Bearer <token>
    │
    ▼
Cycle End      cycle_latency = tokenEnd..queryEnd  (token + query + client work)
```

**Model:** 1 user = 1 k6 VU (thread). Each user runs its cycles **sequentially**;
users run **concurrently** and never wait for each other. A fresh token is
generated for every cycle (no reuse unless you opt in).

Current default: **1 user × 100 cycles** = 100 cycles / 200 HTTP requests.
Scale to 3 users with config only (see [Scaling](#scaling-to-3-users)).

📖 **Docs:**
- [docs/RUN-COMMANDS.md](docs/RUN-COMMANDS.md) — exact commands for 1 user, 2 users, 3 users (wrapper + direct k6), and the CSV outputs.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — step-by-step guide to running the test from a Linux server.
- [docs/DEPLOY-WINDOWS.md](docs/DEPLOY-WINDOWS.md) — same, for a Windows Server / VM.
- [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) — runbook + internals: concurrency model, one cycle line-by-line, what every file does, how each metric is produced.

---

## 1. Prerequisites

- k6 installed and on `PATH` (`k6 version` — tested with v2.1.0).
- Sandbox credentials for each user.

Optional (editor autocomplete only): `npm install`.

---

## 2. Configure

```bash
cp .env.example .env      # PowerShell: Copy-Item .env.example .env
```

Edit `.env` and fill in **user 1**:

```ini
USERS=1
CYCLES_PER_USER=100

USER1_UID=wingcash:4649143802
USER1_MANAGER_UID=wingcash:5715093111
USER1_USERNAME=<sandbox username>
USER1_PASSWORD=<sandbox password>
USER1_ROUTING_NUMBER=096016931
```

`.env` is git-ignored. Never commit real credentials.

### Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `BASE_URL` | `https://sandbox.api.vikexpress.com` | API host |
| `TOKEN_PATH` | `/rest-api/profile-access/token` | API 1 path |
| `QUERY_PATH` | `/rest-api/wallet/report/routing-number/query` | API 2 path |
| `USERS` | `1` | Number of concurrent simulated users (VUs) |
| `CYCLES_PER_USER` | `100` | Cycles each user runs, sequentially |
| `TOKEN_JSON_PATH` | `access_token` | Field in the token response holding the token (dot-path ok, e.g. `data.access_token`) |
| `TOKEN_AUTH_MODE` | `basic` | `basic` (Authorization: Basic), `none`, or `body` (creds in JSON) |
| `TOKEN_REUSE` | `false` | `true` = one token per user reused for all cycles |
| `TOKEN_SOURCE` | `` (empty) | `source` field in the token payload; set `web` for the old value |
| `ROUTING_STRATEGY` | `random` | `random` / `sequential` (pick from `ROUTING_NUMBERS_FILE`) or `per-user` (`USER<n>_ROUTING_NUMBER`) |
| `ROUTING_NUMBERS_FILE` | `./routing_numbers.csv` | CSV of routing numbers; last all-digits column per line is used (header ok) |
| `PERMISSIONS` | the 5 spec permissions | Comma-separated permissions in the token payload |
| `HTTP_TIMEOUT` | `60s` | Per-request timeout |
| `SLEEP_BETWEEN_CYCLES` | `0` | Seconds to pause between cycles |
| `REQUEST_LOG` | `true` | Write `results/requests-*.csv` (one row per HTTP request) |
| `RESPONSE_BODY_MAX` | `500` | Max chars kept from request/response bodies in that log (`0` = none) |
| `EMBED_REQUESTS_IN_JSON` | `true` | Also fold the request rows into `summary-*.json` (run.ps1 only) |
| `APPEND_SUMMARY_CSV` | `true` | Append the full run summary to the bottom of `requests-*.csv` |
| `RUN_SUMMARY_CSV` | `false` | Also write `run-summary-*.csv` (one flat row per run, for comparing runs) |
| `ENV_LABEL` | first label of `BASE_URL` host | Value for the `environment` column in the request log |
| `THRESH_CYCLE_P95` | `2000` | Fail if cycle p95 ≥ this (ms) |
| `THRESH_CYCLE_P99` | `5000` | Fail if cycle p99 ≥ this (ms) |
| `THRESH_TOKEN_P95` | `1000` | Fail if token p95 ≥ this (ms) |
| `THRESH_QUERY_P95` | `1000` | Fail if query p95 ≥ this (ms) |
| `THRESH_ERROR_RATE` | `0.01` | Fail if cycle error rate ≥ this (1%) |
| `USER<n>_UID` / `_MANAGER_UID` / `_USERNAME` / `_PASSWORD` / `_ROUTING_NUMBER` | — | Per-user credentials; required for `n = 1..USERS` |

---

## 3. Run

### With the wrapper (loads `.env` for you)

```bash
# Windows PowerShell  (extra args are forwarded to `k6 run`)
.\run.ps1
.\run.ps1 -e CYCLES_PER_USER=2      # override for one run
```

```bash
# macOS / Linux / Git Bash
chmod +x run.sh
./run.sh
# different env file:  ENV_FILE=.env.user1 ./run.sh
```

### Or call k6 directly

k6 reads real environment variables, not `.env`. Either export them, or pass `-e`:

```bash
k6 run \
  -e USERS=1 \
  -e CYCLES_PER_USER=100 \
  -e USER1_UID=wingcash:4649143802 \
  -e USER1_MANAGER_UID=wingcash:5715093111 \
  -e USER1_USERNAME=... \
  -e USER1_PASSWORD=... \
  -e USER1_ROUTING_NUMBER=096016931 \
  load-test.js
```

### Static validation (no load generated)

```bash
k6 version
k6 inspect load-test.js
```

### Smoke test (2 cycles, real API)

```bash
k6 run -e CYCLES_PER_USER=2 load-test.js
```

---

## 4. Output

Console prints the summary block below. Each run also writes to `results/`
(git-ignored), both a `-latest` copy and a run-stamped copy named
**`<type>-<U>u-<C>c-<timestamp>`** (`U` = users, `C` = cycles per user), e.g.
`requests-3u-100c-2026-09-10T19-16-32.csv`:

**4 files per run** — 2 reports, each as `-latest` + run-stamped:

| File | What |
|---|---|
| `requests-latest.csv` | **one row per HTTP request** (`index,userId,environment,api,routingNumber,requestUrl,requestBody,status,ok,responseTimeMs,timestamp,errorMessage,responseBody`), then a blank line, then the **full run summary block** appended at the bottom — everything in one sheet |
| `summary-latest.json` | same data, machine-readable, + embedded `requests` array |

Optional extras:
- `RUN_SUMMARY_CSV=true` → also `run-summary-*.csv` (one flat row per run — turn on only when comparing several runs, e.g. 1u vs 3u vs 5u)
- A bare `k6 run load-test.js` (no wrapper) instead leaves `report-<runId>.csv` — the summary block as its own CSV

Tune in `.env`: `REQUEST_LOG`, `RESPONSE_BODY_MAX`, `EMBED_REQUESTS_IN_JSON`,
`APPEND_SUMMARY_CSV`, `ENV_LABEL` (all also work as `-e FLAG=value`). For a row
**per metric sample**, add `--out csv=results/raw-metrics.csv` (k6 built-in).

```
==================== LOAD TEST SUMMARY ====================
  Cycles     expected / completed / succeeded / failed  (+ token & query errors)
  HTTP       requests, req/sec, error rate
  Latency (ms)  token API / query API / full cycle
             min  avg  p50  p90  p95  p99  max
  HTTP status distribution   per api (token / query)
  Thresholds [PASS|FAIL] per rule
  RESULT: all thresholds passed | FAIL - N threshold(s) breached
==========================================================
```

### Metrics collected

| Metric | Type | Meaning |
|---|---|---|
| `token_latency` | Trend (ms) | API 1 server round-trip |
| `query_latency` | Trend (ms) | API 2 server round-trip |
| `cycle_latency` | Trend (ms) | token start → query response (incl. client processing) |
| `cycles_total` / `cycles_succeeded` / `cycles_failed` | Counter | cycle outcomes |
| `token_errors` / `query_errors` | Counter | failures per step |
| `http_status` | Counter `{api,status}` | status-code distribution |
| `cycle_error_rate` | Rate | fraction of failed cycles (error-rate threshold) |

Trend percentiles reported: **min, avg, p50, p90, p95, p99, max**.
Derived totals in the summary: total/succeeded/failed cycles, total HTTP
requests, requests/sec, cycles/sec, overall error rate.

Exit code is non-zero if any threshold fails — failures are not hidden.

---

## 5. Error handling

- **Token step fails** (non-2xx, non-JSON, missing/empty token) → cycle marked
  failed, `token_errors++`, **query API is not called**, run continues.
- **Query step fails** (non-2xx, empty body, non-JSON) → cycle marked failed,
  `query_errors++`, run continues.
- One failing cycle never aborts the test.
- Passwords and tokens are never written to logs — only HTTP status codes and
  the failing step.

---

## Scaling to 3 users

No code changes. In `.env`:

```ini
USERS=3

USER2_UID=...
USER2_MANAGER_UID=...
USER2_USERNAME=...
USER2_PASSWORD=...
USER2_ROUTING_NUMBER=...

USER3_UID=...
USER3_MANAGER_UID=...
USER3_USERNAME=...
USER3_PASSWORD=...
USER3_ROUTING_NUMBER=...
```

Then `./run.ps1` → 3 concurrent VUs × 100 sequential cycles = **300 cycles /
600 HTTP requests** (300 token + 300 query).

---

## Assumptions made

1. **Token field is `access_token`.** Configurable via `TOKEN_JSON_PATH`; a
   dot-path is supported if the token is nested.
2. **Token endpoint needs HTTP Basic auth.** Observed on the sandbox: with no
   `Authorization` header the endpoint returns a misleading `404`; with a Basic
   header it performs real auth (`401` on bad creds). Switch with
   `TOKEN_AUTH_MODE` (`basic` | `none` | `body`).
3. **k6 VU = user/thread.** Executor `per-vu-iterations` guarantees exactly
   `CYCLES_PER_USER` sequential iterations per VU, VUs concurrent.
4. **Cycle latency** is a client-side monotonic-clock delta
   (`exec.instance.currentTestRunDuration`, sub-ms) wrapping both calls, so it
   includes client JSON work; individual API latencies come from k6
   `res.timings.duration`.
5. **HTTP connection reuse** left at the k6 default (on). Disable with
   `K6_NO_CONNECTION_REUSE=true` for a cold-connection measurement.
6. **No think-time** between cycles by default (`SLEEP_BETWEEN_CYCLES=0`).

## Project layout

```
load-test.js      k6 entry: options, scenario, thresholds, the cycle, handleSummary
config.js         env → typed config + validated users[]
lib/token.js      API 1 request + token extraction
lib/query.js      API 2 request
lib/metrics.js    custom Trend / Counter / Rate definitions
summary.js        end-of-test report (stdout + results/*.json)
run.ps1 / run.sh  load .env then run k6
.env.example      documented fake config
```
