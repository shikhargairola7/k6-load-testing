# Run commands — 1 user and 2 users

Exact commands for every way to run the test. Run them from the project root
(`load testing app/`).

- [Setup (once)](#setup-once)
- [1 user](#1-user)
- [2 users](#2-users)
- [3 users](#3-users)
- [Output files (incl. CSV)](#output-files-incl-csv)
- [Quick reference table](#quick-reference-table)

---

## Setup (once)

```powershell
k6 version                       # expect v2.1.0
Copy-Item .env.example .env      # create local config
notepad .env                     # fill in credentials (see below)
```

`.env` is git-ignored. Two ways to run each scenario:

- **Wrapper** `.\run.ps1` — reads `.env`, creates `results/`, runs k6. Any extra
  args are forwarded to `k6 run`.
- **Direct** `k6 run ... load-test.js` — k6 does not read `.env`, so pass every
  value with `-e`.

`USERS` and `CYCLES_PER_USER` decide the shape:
`total cycles = USERS x CYCLES_PER_USER`, `total requests = total cycles x 2`.

---

## 1 user

**`.env` needs:** `USER1_*` (UID, MANAGER_UID, USERNAME, PASSWORD, ROUTING_NUMBER).

Set in `.env`:
```ini
USERS=1
CYCLES_PER_USER=100
```

### A. Smoke — 2 cycles (verify auth before the real run)

```powershell
# wrapper
.\run.ps1 -e CYCLES_PER_USER=2
```
```powershell
# direct
k6 run -e USERS=1 -e CYCLES_PER_USER=2 `
  -e USER1_UID=wingcash:4649143802 `
  -e USER1_MANAGER_UID=wingcash:5715093111 `
  -e USER1_USERNAME=7076838061-DEV `
  -e USER1_PASSWORD=<password> `
  -e USER1_ROUTING_NUMBER=096016931 `
  load-test.js
```

### B. Full run — 1 user x 100 cycles  (100 cycles, 200 requests)

```powershell
# wrapper  (uses USERS / CYCLES_PER_USER from .env)
.\run.ps1
```
```powershell
# direct
k6 run -e USERS=1 -e CYCLES_PER_USER=100 `
  -e USER1_UID=wingcash:4649143802 `
  -e USER1_MANAGER_UID=wingcash:5715093111 `
  -e USER1_USERNAME=7076838061-DEV `
  -e USER1_PASSWORD=<password> `
  -e USER1_ROUTING_NUMBER=096016931 `
  load-test.js
```

### macOS / Linux / Git Bash

```bash
chmod +x run.sh
./run.sh                        # full run
./run.sh -e CYCLES_PER_USER=2   # smoke
```

---

## 2 users

Two threads run **concurrently**; each thread runs its 100 cycles **sequentially**.
Total: **200 cycles, 400 requests** (200 token + 200 query).

**`.env` needs:** `USER1_*` **and** `USER2_*`. Each user should be a distinct
sandbox identity (own `uid` / `manager_uid` / `routing_number`; `username` /
`password` may be shared if the account allows concurrent tokens — the payload
sends `"concurrent": true`).

Set in `.env`:
```ini
USERS=2
CYCLES_PER_USER=100

USER1_UID=wingcash:4649143802
USER1_MANAGER_UID=wingcash:5715093111
USER1_USERNAME=7076838061-DEV
USER1_PASSWORD=<password>
USER1_ROUTING_NUMBER=096016931

USER2_UID=<user 2 uid>
USER2_MANAGER_UID=<user 2 manager uid>
USER2_USERNAME=<user 2 username>
USER2_PASSWORD=<user 2 password>
USER2_ROUTING_NUMBER=<user 2 routing number>
```

### A. Smoke — 2 users x 2 cycles  (4 cycles, 8 requests)

```powershell
.\run.ps1 -e USERS=2 -e CYCLES_PER_USER=2
```

### B. Full run — 2 users x 100 cycles  (200 cycles, 400 requests)

```powershell
# wrapper  (USERS=2 in .env)
.\run.ps1
```
```powershell
# wrapper, overriding .env for this run only
.\run.ps1 -e USERS=2 -e CYCLES_PER_USER=100
```
```powershell
# direct — every value on the command line
k6 run -e USERS=2 -e CYCLES_PER_USER=100 `
  -e USER1_UID=wingcash:4649143802 `
  -e USER1_MANAGER_UID=wingcash:5715093111 `
  -e USER1_USERNAME=7076838061-DEV `
  -e USER1_PASSWORD=<password> `
  -e USER1_ROUTING_NUMBER=096016931 `
  -e USER2_UID=<uid2> `
  -e USER2_MANAGER_UID=<manager2> `
  -e USER2_USERNAME=<username2> `
  -e USER2_PASSWORD=<password2> `
  -e USER2_ROUTING_NUMBER=<routing2> `
  load-test.js
```

### macOS / Linux / Git Bash

```bash
./run.sh -e USERS=2 -e CYCLES_PER_USER=100
```

> If you only have one credential set and just want to check 2-thread
> concurrency, point `USER2_*` at the same values as `USER1_*`. Confirmed working:
> `2/2 VUs`, both cycles ran in parallel.

---

## 3 users

Total: **300 cycles, 600 requests** (300 token + 300 query).
Add a `USER3_*` block to `.env`, then:

```powershell
.\run.ps1 -e USERS=3 -e CYCLES_PER_USER=100
```
```bash
./run.sh -e USERS=3 -e CYCLES_PER_USER=100
```

---

## Output files (incl. CSV)

Every run writes to `results/` (git-ignored). Each file has a **`-latest`** copy
and a run-stamped copy named **`<type>-<U>u-<C>c-<timestamp>`** — `U` = users,
`C` = cycles per user — e.g. `requests-3u-100c-2026-09-10T19-16-32.csv`.

**4 files per run** (2 reports × `-latest` + run-stamped):

| File | Format | Contents |
|---|---|---|
| `results/requests-latest.csv` | CSV | **one row per HTTP request** — `index,userId,environment,api,routingNumber,requestUrl,requestBody,status,ok,responseTimeMs,timestamp,errorMessage,responseBody` — then a blank line then the **full run summary appended at the bottom** |
| `results/summary-latest.json` | JSON | same data machine-readable — config, totals, percentiles, status distribution, thresholds — **plus** the `requests` array (embedded by `run.ps1`) |

Optional:
- `RUN_SUMMARY_CSV=true` → also `run-summary-*.csv` (one flat row per run — turn
  on only when comparing several runs).
- A bare `k6 run` (no wrapper) instead leaves `report-<runId>.csv` — the summary
  block as its own CSV.

`requests-latest.csv` example:
```csv
index,userId,environment,api,routingNumber,requestUrl,requestBody,status,ok,responseTimeMs,timestamp,errorMessage,responseBody
1,wingcash:7648560309,dev,token,,https://.../profile-access/token,"{""uid"":""...""}",200,true,737.56,2026-09-10T12:42:51Z,,<2xx: access_token redacted>
1,wingcash:7648560309,dev,query,072000326,https://.../routing-number/query,"{""routing_number"":""072000326""}",200,true,848.88,2026-09-10T12:42:11Z,,"{""status"":""success"",""rdfi_name"":""JPMorgan Chase"",...}"
```

**Routing numbers** come from `routing_numbers.csv` (project root), picked
**randomly per cycle** by default. Change with `ROUTING_STRATEGY`:
`random` (default) · `sequential` (in file order) · `per-user` (use
`USER<n>_ROUTING_NUMBER`). Point at a different file with `ROUTING_NUMBERS_FILE`.
The chosen number is in the `routingNumber` column (query rows).

Credentials are masked, token response bodies redacted. Tune with `.env` **or `-e`**:
`REQUEST_LOG=false` (disable), `RESPONSE_BODY_MAX=0` (drop body text),
`APPEND_SUMMARY_CSV=false` (don't append the summary block),
`EMBED_REQUESTS_IN_JSON=false` (keep JSON lean), `ENV_LABEL=…` (the `environment` column).

`run-summary-*.csv` (only when `RUN_SUMMARY_CSV=true`) is a single wide row per
run (`generated_at, users, cycles_per_user, cycles_total/succeeded/failed,
requests_per_sec, error_rate, token_p50…max, query_p50…max, cycle_p50…max,
result`). Turn it on when scaling load (1u → 3u → 5u …) and paste the data rows
into one sheet to compare side by side.

### Raw per-request CSV (optional, k6 built-in)

For a row **per HTTP request** (every sample, not a summary), add k6's own CSV
output:

```powershell
.\run.ps1 --out csv=results/raw-metrics.csv
```
```powershell
k6 run --out csv=results/raw-metrics.csv -e USERS=1 -e CYCLES_PER_USER=100 ... load-test.js
```

This produces a large file with columns `metric_name,timestamp,metric_value,url,
status,method,scenario,...` — useful for deep analysis, overkill for a quick read.

---

## Quick reference table

| Scenario | `.env` | Command | Cycles | Requests |
|---|---|---|---|---|
| 1 user smoke | `USERS=1` | `.\run.ps1 -e CYCLES_PER_USER=2` | 2 | 4 |
| **1 user full** | `USERS=1`, `CYCLES_PER_USER=100` | `.\run.ps1` | 100 | 200 |
| 2 user smoke | `USERS=2` + `USER2_*` | `.\run.ps1 -e USERS=2 -e CYCLES_PER_USER=2` | 4 | 8 |
| **2 user full** | `USERS=2`, `CYCLES_PER_USER=100` + `USER2_*` | `.\run.ps1 -e USERS=2` | 200 | 400 |
| 3 user full | `USERS=3` + `USER2_*` `USER3_*` | `.\run.ps1 -e USERS=3` | 300 | 600 |

Exit code: `0` = all thresholds passed, `99` = a threshold failed (see the
`Thresholds` block in the summary; adjust `THRESH_*` in `.env` if a limit is wrong).
