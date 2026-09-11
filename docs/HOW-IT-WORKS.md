# How the load test works — runbook + internals

A complete guide to running the vikexpress token → routing-number load test and
understanding every moving part.

- [1. TL;DR run](#1-tldr-run)
- [2. What the test does](#2-what-the-test-does)
- [3. The concurrency model (threads / users)](#3-the-concurrency-model-threads--users)
- [4. One cycle, line by line](#4-one-cycle-line-by-line)
- [5. File-by-file responsibilities](#5-file-by-file-responsibilities)
- [6. How configuration flows](#6-how-configuration-flows)
- [7. How each metric is produced](#7-how-each-metric-is-produced)
- [8. How the summary + result files are made](#8-how-the-summary--result-files-are-made)
- [9. Running: every option](#9-running-every-option)
- [10. Scaling to 3 users](#10-scaling-to-3-users)
- [11. Troubleshooting](#11-troubleshooting)
- [12. Assumptions](#12-assumptions)

---

## 1. TL;DR run

```powershell
# from the "load testing app" folder, in PowerShell

k6 version                      # 1. sanity check (expect v2.1.0)
Copy-Item .env.example .env     # 2. make your local config
notepad .env                    # 3. fill USER1_* with real sandbox values, keep USERS=1

.\run.ps1 -e CYCLES_PER_USER=2   # 4. 2-cycle smoke test
.\run.ps1                        # 5. real run: 1 user x 100 cycles
```

Output: a summary block in the console + JSON at `results/summary-latest.json`.

---

## 2. What the test does

One **cycle** = two chained HTTP calls against `https://sandbox.api.vikexpress.com`:

```
        cycle start  ── t0 = nowMs() (monotonic)
             │
             ▼
   ┌───────────────────────────────┐
   │ API 1  POST /rest-api/         │   Content-Type: application/json
   │        profile-access/token    │   Authorization: Basic base64(user:pass)
   │                                │   body: { uid, manager_uid, concurrent,
   │                                │           device_name, device_uuid,
   │                                │           source, permissions[] }
   └───────────────────────────────┘
             │  response → extract  access_token
             ▼
   ┌───────────────────────────────┐
   │ API 2  POST /rest-api/wallet/  │   Content-Type: application/json
   │        report/routing-number/  │   Authorization: Bearer <access_token>
   │        query                   │   body: { routing_number }
   └───────────────────────────────┘
             │
             ▼
        cycle end  ── t1 = nowMs()

   cycle_latency = t1 - t0   (API 1 + API 2 + client JSON work between them)
```

The token for API 2 **must** be the one API 1 just returned in the same cycle
(no shared token, no reuse across cycles — unless `TOKEN_REUSE=true`).

Target volume for the initial test: **1 user × 100 cycles = 100 cycles / 200
requests** (100 token + 100 query). Scaling to 3 users → 300 cycles / 600 requests.

---

## 3. The concurrency model (threads / users)

**1 user = 1 k6 VU (virtual user = a thread of execution).**

k6 is configured with the `per-vu-iterations` executor
([`load-test.js:52-60`](../load-test.js)):

```js
scenarios: {
  cycle: {
    executor: 'per-vu-iterations',
    vus: config.users,            // USERS  → how many threads
    iterations: config.cyclesPerUser,  // CYCLES_PER_USER → cycles each thread runs
    maxDuration: '2h',
  },
}
```

What this guarantees:

| Requirement | How `per-vu-iterations` satisfies it |
|---|---|
| Exactly N cycles per user | `iterations` is **per VU**, not shared. 3 VUs × 100 = exactly 300. |
| Cycles sequential *within* a user | k6 runs a VU's `default()` function, waits for it to return, then runs the next iteration. No overlap inside one VU. |
| Users run *concurrently* | All VUs are started together and progress independently. |
| Users never wait for each other | There is no barrier/sync between VUs. VU 2 starting cycle 5 doesn't care where VU 1 is. |

```
                       START (all VUs launch together)
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
     VU 1 (USER1)         VU 2 (USER2)         VU 3 (USER3)
   cycle 1: T→Q          cycle 1: T→Q          cycle 1: T→Q
   cycle 2: T→Q          cycle 2: T→Q          cycle 2: T→Q
      ...                   ...                   ...
   cycle 100: T→Q        cycle 100: T→Q        cycle 100: T→Q
        │                    │                    │
        └────────────────────┴────────────────────┘
                             ▼
                     handleSummary(data)
```

**VU → user mapping** ([`config.js:112-115`](../config.js), used at
[`load-test.js:91`](../load-test.js)):

```js
export function userForVU(vuId) {
  return users[(vuId - 1) % users.length];
}
// exec.vu.idInTest is 1-based: VU 1 → users[0] → USER1_*, VU 2 → users[1] → USER2_*, ...
```

---

## 4. One cycle, line by line

This is the `default()` function in [`load-test.js:90-161`](../load-test.js). It
runs once per iteration per VU.

| Line(s) | What happens | Why |
|---|---|---|
| `91` | `user = userForVU(exec.vu.idInTest)` | pick this thread's credentials |
| `92` | `cycleStart = nowMs()` | **start the cycle clock** — before anything else |
| `95` | `token = tokenReuse ? cachedToken : null` | reuse mode short-circuits step 1 |
| `98` | `generateToken(user)` → `{ res, token }` | API 1 call (see [`lib/token.js`](../lib/token.js)) |
| `99` | `httpStatus.add(1, { api:'token', status })` | feed the status-code distribution |
| `104` | `if (res.status > 0) tokenLatency.add(res.timings.duration)` | record API 1 latency — but only if a real HTTP response came back (status 0 = connection refused/DNS/TLS, ~0 ms, would skew the trend) |
| `106-111` | 4 `check()`s: 2xx, body present, token present, token non-empty | pass/fail assertions, counted in k6's `checks` metric |
| `113-121` | **token failed path**: `token_errors++`, `cycles_failed++`, `cycles_total++`, `cycle_error_rate.add(true)`, `console.warn`, `return` | mark the cycle failed and **stop — never call API 2 with a bad token**. `return` ends this iteration; k6 starts the next one. |
| `123-124` | `token = fresh`; cache it if reuse mode | hand the fresh token to step 2 |
| `~128` | `pickRoutingNumber(pool, strategy, user)` then `routingNumberQuery(token, routingNumber)` → `qRes` | routing number chosen per cycle from `routing_numbers.csv` (see [`lib/routingNumbers.js`](../lib/routingNumbers.js)); API 2 call in [`lib/query.js`](../lib/query.js) |
| `129` | `httpStatus.add(...)` for `api:'query'` | status distribution |
| `130` | `if (qRes.status > 0) queryLatency.add(qRes.timings.duration)` | record API 2 latency |
| `132-143` | 3 `check()`s: 2xx, body present, response is a JSON object | query assertions |
| `146` | `cycleLatency.add(nowMs() - cycleStart)` | **stop the cycle clock** — right after the query response is in hand |
| `147` | `cyclesTotal.add(1)` | this cycle completed (regardless of pass/fail) |
| `149-151` | query OK → `cycles_succeeded++`, `cycle_error_rate.add(false)` | success |
| `152-158` | query failed → `query_errors++`, `cycles_failed++`, `cycle_error_rate.add(true)`, `console.warn` | failure, run continues |
| `160` | `maybeSleep()` | optional pause (`SLEEP_BETWEEN_CYCLES`, default 0) |

**Key timing point:** `cycleStart` is captured *before* the token request
([line 92](../load-test.js)) and `cycleLatency` is recorded *after* the query
response ([line 146](../load-test.js)). So cycle latency =
`token time + client processing + query time` — exactly as specified, never just
the query.

---

## 5. File-by-file responsibilities

```
load testing app/
├── load-test.js      ← THE ENTRY POINT. k6 runs this file.
├── config.js         ← reads environment variables → one config object + users[]
├── lib/
│   ├── token.js      ← API 1: build request, send it, extract the token
│   ├── query.js      ← API 2: build request, send it
│   ├── metrics.js    ← declares every custom metric (Trend/Counter/Rate)
│   ├── requestLog.js ← emits one base64 console line per HTTP request (detail log)
│   └── routingNumbers.js ← parse routing_numbers.csv + pick one per cycle
routing_numbers.csv  ← pool of routing numbers (random pick per cycle by default)
├── summary.js        ← builds the end-of-test report (console + JSON files)
├── run.ps1           ← Windows: load .env into env vars, then `k6 run`
├── run.sh            ← macOS/Linux/Git Bash: same
├── .env.example      ← template config with fake values (committed)
├── .env              ← your real config (git-ignored, you create it)
├── .gitignore        ← keeps .env and results/*.json out of git
├── package.json      ← optional: `npm i` for @types/k6 editor autocomplete
├── results/          ← summary JSON written here (git-ignored except .gitkeep)
└── README.md         ← short reference
```

### `load-test.js` — orchestrator
- Declares `options` (scenario, thresholds, `summaryTrendStats`).
- `setup()` — logs the plan once before the run.
- `default()` — the cycle (section 4 above).
- `handleSummary()` — delegates to `summary.js`.
- Owns the flow logic: *what* order, *when* to stop a cycle, *which* metric to bump.
- Imports everything else; contains no HTTP or config-parsing details itself.

### `config.js` — single source of configuration
- `env()` / `envInt()` / `envFloat()` / `envBool()` helpers read `__ENV.*` with defaults.
- `buildUser(n)` reads `USER<n>_*`, **throws a clear error** if a required field is
  missing (so a misconfigured run fails instantly, not halfway).
- Exports:
  - `config` — flat object: URLs, `users`, `cyclesPerUser`, `tokenJsonPath`,
    `tokenAuthMode`, `tokenReuse`, `permissions`, `statusCodes`, `httpTimeout`,
    `sleepBetweenCycles`, `thresholds{}`.
  - `users` — array of validated user objects (only as many as `USERS`).
  - `userForVU(vuId)` — maps a k6 VU id to a user.
- Runs at k6 **init time** (before any VU starts), so config errors abort the whole run.

### `lib/token.js` — API 1
- `buildTokenRequest(user)` — assembles URL, JSON body, and headers. Adds
  `Authorization: Basic …` when `TOKEN_AUTH_MODE=basic` (uses `k6/encoding`
  `b64encode`), or puts creds in the body when `=body`, or nothing when `=none`.
- `extractToken(res)` — parses the response JSON and pulls the token from
  `config.tokenJsonPath` (supports a dot-path like `data.access_token`). Returns
  `undefined` if not JSON / field missing / not a non-empty string.
- `generateToken(user)` — sends the POST, returns `{ res, token }`; `token` is
  `undefined` on any non-2xx or extraction failure.

### `lib/routingNumbers.js` — routing-number pool
- `parseRoutingPool(text)` — reads the CSV text (opened by `load-test.js` at init),
  keeps the last all-digits field of each line (skips the `ID` / header).
- `pickRoutingNumber(pool, strategy, user)` — per cycle: `random` (default),
  `sequential` (file order, per VU), or `per-user` (`user.routingNumber`).

### `lib/query.js` — API 2
- `routingNumberQuery(token, routingNumber)` — POST to the query endpoint with
  `Authorization: Bearer <token>` and `{ routing_number }`. Returns the raw k6
  response.

### `lib/metrics.js` — metric declarations
- Creates the custom metric objects once (module scope) so every VU shares the
  same metric handles:
  - `Trend` (distribution): `token_latency`, `query_latency`, `cycle_latency`
  - `Counter` (running total): `cycles_total`, `cycles_succeeded`, `cycles_failed`,
    `token_errors`, `query_errors`, `http_status`
  - `Rate` (true/false ratio): `cycle_error_rate`

### `summary.js` — reporting
- `buildSummary(data, config)` receives k6's aggregated `data` and returns an
  object whose keys are output destinations:
  - `stdout` → the text block you see in the console
  - `results/summary-<timestamp>.json` → timestamped machine-readable report
  - `results/summary-latest.json` → same, overwritten each run
- Helpers pull counts, rates, and Trend percentiles out of `data.metrics`, build
  the status-code distribution from `http_status{…}` submetrics, and list every
  threshold with PASS/FAIL.

### `run.ps1` / `run.sh` — launchers
- k6 does **not** read `.env`. These scripts parse `.env` line by line, set each
  `KEY=VALUE` as a process environment variable, `mkdir results`, then `k6 run
  load-test.js`. Any extra arguments you pass are forwarded to `k6 run`
  (`.\run.ps1 -e USERS=3`). They report the k6 exit code (0 = all thresholds
  passed, 99 = a threshold failed).
- **`run.sh` under Git Bash:** MSYS mangles env-var values that start with `/`
  (e.g. `TOKEN_PATH=/rest-api/...` becomes a Windows path). `run.sh` sets
  `MSYS2_ENV_CONV_EXCL='*'` to prevent this. On Windows, prefer `run.ps1`.

---

## 6. How configuration flows

```
.env  ──(run.ps1 / run.sh sets each line as an OS env var)──►  process env
                                                                    │
                                          k6 exposes them as __ENV.* │
                                                                    ▼
                                    config.js  (init time, once)
                                      env('USERS', 1)          → config.users
                                      env('CYCLES_PER_USER',…)  → config.cyclesPerUser
                                      buildUser(1..USERS)       → users[]
                                      env('THRESH_CYCLE_P95',…) → config.thresholds.cycleP95
                                                                    │
                     ┌──────────────────────────────────────────────┼───────────────┐
                     ▼                        ▼                      ▼               ▼
             load-test.js options      lib/token.js           lib/query.js      summary.js
             (scenario, thresholds)  (URL, auth, extract)   (URL, bearer)     (labels in report)
```

You never edit source to change users, cycles, URLs, timeouts, thresholds, auth
mode, or the token field — all of it is environment-driven. Precedence: an
explicit `-e KEY=VALUE` on the k6 command line overrides `.env`, which overrides
the built-in default in `config.js`.

---

## 7. How each metric is produced

| Metric | Type | Where it's fed | Meaning |
|---|---|---|---|
| `token_latency` | Trend (ms) | `load-test.js:104` — `res.timings.duration` of the token POST | server round-trip time for API 1 |
| `query_latency` | Trend (ms) | `load-test.js:130` — `res.timings.duration` of the query POST | server round-trip time for API 2 |
| `cycle_latency` | Trend (ms) | `nowMs() - cycleStart` (monotonic clock) | full cycle: API 1 + client work + API 2 |
| `cycles_total` | Counter | `:116` and `:147` | every cycle that ran (pass or fail) |
| `cycles_succeeded` | Counter | `:150` | cycles where the query check passed |
| `cycles_failed` | Counter | `:115` and `:154` | cycles that failed at token or query |
| `token_errors` | Counter | `:114` | cycles that failed specifically at the token step |
| `query_errors` | Counter | `:153` | cycles that failed specifically at the query step |
| `http_status` | Counter `{api,status}` | `:99` and `:129` | one increment per request, tagged e.g. `{api:token,status:200}` |
| `cycle_error_rate` | Rate | `:117`, `:151`, `:155` — `true` on fail, `false` on success | fraction of cycles that failed → drives the error-rate threshold |

**Percentiles** come from `summaryTrendStats` in `options`
([`load-test.js:61`](../load-test.js)):
`['min','avg','max','p(50)','p(90)','p(95)','p(99)']` — computed by k6 over all
recorded samples for each Trend.

**Derived numbers** in the summary (computed in `summary.js`):
- `requests/sec` = `http_reqs.rate` (k6 built-in metric)
- `cycles/sec` = `cycles_total.rate`
- `error rate %` = `cycle_error_rate.rate × 100`
- `test duration` = `data.state.testRunDurationMs / 1000`

**Status-code distribution:** k6 only exposes tagged submetrics to `handleSummary`
if they were referenced in `thresholds`. So `load-test.js:42-50` registers
harmless `http_status{api:…,status:…}: ['count>=0']` thresholds (always pass) for
common codes. `summary.js` then reads back any `http_status{…}` submetric with
`count > 0` and prints the breakdown.

---

## 8. How the summary + result files are made

1. k6 finishes all iterations and aggregates every metric into a `data` object.
2. k6 calls `handleSummary(data)` ([`load-test.js:167`](../load-test.js)).
3. That calls `buildSummary(data, config)` ([`summary.js`](../summary.js)).
4. `buildSummary` returns (`<id>` = `<U>u-<C>c-<timestamp>`):
   ```js
   {
     stdout: "<the text block>",
     "results/summary-<id>.json": "<json>",   "results/summary-latest.json": "<json>",
     "results/report-<id>.csv": "<csv>",      // append source; wrappers delete it after folding it into requests-*.csv
     // + run-summary-<id>.csv / run-summary-latest.csv only when RUN_SUMMARY_CSV=true
   }
   ```
5. k6 prints `stdout` and writes each other key as a file.

**CSV outputs** (built in `summary.js`, `buildReportCsv` / `buildRunSummaryCsv`):
- `report-<id>.csv` — the tall run-summary block; the wrappers append it to the
  bottom of `requests-<id>.csv` and then delete it (a bare `k6 run` keeps it).
- `run-summary-<id>.csv` — one flat row per run, **only when `RUN_SUMMARY_CSV=true`**.
  Stack rows from several runs to compare 1-user / 3-user / 5-user.

**Per-request detail log — `results/requests-<runId>.csv`**

Columns: `index, userId, environment, api, routingNumber, requestUrl, requestBody,
status, ok, responseTimeMs, timestamp, errorMessage, responseBody` — one row per
HTTP request (so 2 rows per cycle: `token` then `query`).

How it gets out of k6 (a VU cannot write files or share memory with
`handleSummary`):
1. `lib/requestLog.js` builds a CSV row, base64-encodes it, and `console.log`s
   `@@REQ@@ <base64>` — **after** the cycle timer stops, so logging never inflates
   the latency numbers. `setup()` emits `@@REQHDR@@ <base64>` once for the header.
2. `run.ps1` / `run.sh` watch k6's output, decode those lines, and stream them
   into `results/requests-<runId>.csv` (+ `requests-latest.csv`). base64 keeps the
   payload immune to k6's `msg="..."` log wrapping.
3. `run.ps1` also folds the rows (typed) into `results/summary-*.json` as
   `requests` / `requestCount` / `requestLogFile`. Set `EMBED_REQUESTS_IN_JSON=false`
   to skip.
4. `summary.js` emits `results/report-<id>.csv` — a tall, readable block (run
   info, totals, latency table, status distribution, thresholds, result). The
   wrappers append it to the bottom of `requests-*.csv` (after a blank line) so
   the whole picture is one sheet, then delete `report-<id>.csv`;
   `APPEND_SUMMARY_CSV=false` keeps it separate instead.
   All of `REQUEST_LOG` / `RESPONSE_BODY_MAX` / `EMBED_REQUESTS_IN_JSON` /
   `APPEND_SUMMARY_CSV` / `ENV_LABEL` also work as `-e FLAG=value` (the wrappers
   mirror `-e` args into the environment).

Safety: credentials in the token body are masked (`***`); the token response body
is never logged (`<2xx: access_token redacted>`); the Bearer token lives in a
header and headers are never logged. `RESPONSE_BODY_MAX` (default 500) caps body
text; `RESPONSE_BODY_MAX=0` stores none. `REQUEST_LOG=false` disables the whole
feature (and its tiny per-request cost) for very large runs.

For a k6-native row **per metric sample**, add `.\run.ps1 --out csv=results/raw-metrics.csv`.

> ⚠️ k6 does **not** create the `results/` directory. `run.ps1` / `run.sh` do
> (`mkdir results`). If you call `k6 run` directly, make sure `results/` exists
> (it's kept in the repo via `results/.gitkeep`), otherwise the run still
> completes and the console summary still prints — only the JSON files are skipped
> with a warning.

The JSON report structure:
```json
{
  "generatedAt": "...",
  "config": { "baseUrl", "users", "cyclesPerUser", "tokenAuthMode", "tokenJsonPath", "tokenReuse" },
  "totals": { "testDurationSeconds", "cyclesExpected", "cyclesTotal", "cyclesSucceeded",
              "cyclesFailed", "httpRequestsTotal", "requestsPerSecond", "cyclesPerSecond",
              "errorRate", "tokenErrors", "queryErrors" },
  "latencyMs": { "token": {min,avg,max,p50,p90,p95,p99}, "query": {…}, "cycle": {…} },
  "httpStatusDistribution": [ { "api": "token", "status": "200", "count": 100 }, … ],
  "thresholds": [ { "metric": "cycle_latency", "threshold": "p(95)<2000", "ok": true }, … ]
}
```

---

## 9. Running: every option

### A. Wrapper script (recommended — loads `.env`)

```powershell
.\run.ps1                                  # .env + load-test.js
$env:ENV_FILE=".env.staging"; .\run.ps1    # a different env file
.\run.ps1 -e CYCLES_PER_USER=2             # override one value for this run
.\run.ps1 --out json=results/raw.json      # also dump raw k6 samples

# extra args after the script name are forwarded straight to `k6 run`
```

```bash
# macOS / Linux / Git Bash
chmod +x run.sh
./run.sh
ENV_FILE=.env.staging ./run.sh
./run.sh --out json=results/raw.json
```

### B. Plain k6 (no `.env` — pass values with `-e`)

```powershell
k6 run `
  -e USERS=1 -e CYCLES_PER_USER=100 `
  -e USER1_UID=wingcash:4649143802 `
  -e USER1_MANAGER_UID=wingcash:5715093111 `
  -e USER1_USERNAME=<username> `
  -e USER1_PASSWORD=<password> `
  -e USER1_ROUTING_NUMBER=096016931 `
  load-test.js
```

### C. Static validation (no traffic)

```powershell
k6 version
k6 inspect load-test.js -e USER1_UID=x -e USER1_MANAGER_UID=y -e USER1_USERNAME=u -e USER1_PASSWORD=p -e USER1_ROUTING_NUMBER=r
```

### D. npm shortcuts (if you ran `npm install`)

```powershell
npm run inspect      # k6 inspect
npm run smoke        # 2 cycles
npm test             # k6 run load-test.js
```

### PowerShell execution-policy error on `.\run.ps1`

Run once per terminal session:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

---

## 10. Scaling to 3 users

No code changes. In `.env`:

```ini
USERS=3
CYCLES_PER_USER=100

USER1_UID=...
USER1_MANAGER_UID=...
USER1_USERNAME=...
USER1_PASSWORD=...
USER1_ROUTING_NUMBER=...

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

```powershell
.\run.ps1
```

k6 launches 3 VUs. VU1↔USER1, VU2↔USER2, VU3↔USER3. Each runs 100 sequential
cycles concurrently → **300 cycles, 600 requests** (300 token + 300 query).

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing env vars for user N: …` | `USERS` higher than the user blocks you filled in | add the block, or lower `USERS` |
| All cycles fail at TOKEN, `http 404` | no `Authorization` header reaching the endpoint | ensure `TOKEN_AUTH_MODE=basic` and `USER1_USERNAME`/`PASSWORD` are set |
| All cycles fail at TOKEN, `http 401` | wrong username/password | check the sandbox credentials |
| Cycles fail at TOKEN, status 2xx but `token: access token present` check fails | token is under a different JSON key | inspect the response, set `TOKEN_JSON_PATH=<key>` (dot-path ok) |
| All cycles fail at QUERY, `http 401` | token rejected by API 2 | token field is wrong, or token expired between calls — check `TOKEN_JSON_PATH`; keep `TOKEN_REUSE=false` |
| `could not open 'results/summary-…json'` | `results/` doesn't exist and you ran `k6` directly | use `.\run.ps1`, or `mkdir results` first |
| `.\run.ps1 : cannot be loaded because running scripts is disabled` | PowerShell execution policy | `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` |
| RESULT: FAIL — threshold breached | latency/error-rate over the limit (this is the test doing its job) | investigate the API, or adjust `THRESH_*` in `.env` if the limit was wrong |

Nothing sensitive is logged — only HTTP status codes and which step failed.

---

## 12. Assumptions

1. **Token field is `access_token`.** Override with `TOKEN_JSON_PATH`. Not yet
   confirmed against a real 2xx response — verify on your first successful run.
2. **Token endpoint requires HTTP Basic auth.** Observed on the sandbox: no
   `Authorization` header → misleading `404`; Basic header + bad creds → `401`.
   Hence `TOKEN_AUTH_MODE=basic` default (also supports `none`, `body`).
3. **k6 VU = one user = one thread.** `per-vu-iterations` gives exactly
   `CYCLES_PER_USER` sequential cycles per VU, VUs concurrent, no cross-user wait.
4. **Cycle latency is measured client-side** with a monotonic clock
   (`exec.instance.currentTestRunDuration`, sub-ms, can't jump if the system
   clock is adjusted) wrapping both calls, so it includes client JSON processing.
   Per-API latency uses k6 `res.timings.duration`. Connection-level failures
   (status 0) are excluded from latency trends but still counted as errors.
5. **Connection reuse: k6 default (on).** Set `K6_NO_CONNECTION_REUSE=true` for
   cold-connection numbers.
6. **No think-time between cycles** (`SLEEP_BETWEEN_CYCLES=0`).
