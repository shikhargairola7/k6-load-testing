# Deploying the load test on a server

A step-by-step guide to running this test from a Linux server instead of your
laptop. (For a Windows Server / VM instead, see
[DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md).)

## Why put it on a server?

This is **not a service that runs 24/7**. It's a test you run on demand. You'd
put it on a server to:

- run from a machine with a **stable, fast network** to the API
- run **big tests** (many users) on a box with more CPU than a laptop
- **schedule** runs (nightly, etc.)
- keep long runs going after you disconnect

If none of that applies, running from your laptop is fine.

---

## What you need

- A Linux server you can SSH into (Ubuntu 22.04 / Debian 12 / Amazon Linux — any
  recent distro). 2 vCPU / 2 GB RAM is plenty for up to ~200 users.
- SSH access.
- The credentials for the test users (kept **only** on the server, never in git).

---

## Step 1 — Install k6

SSH into the server, then:

**Ubuntu / Debian**
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

**RHEL / Amazon Linux / Fedora**
```bash
sudo dnf install https://dl.k6.io/rpm/repo.rpm
sudo dnf install k6
```

**Any distro (no root / quick)**
```bash
curl -L https://github.com/grafana/k6/releases/latest/download/k6-latest-linux-amd64.tar.gz | tar xz
sudo mv k6-*/k6 /usr/local/bin/
```

Check it:
```bash
k6 version
```

---

## Step 2 — Get the project onto the server

**Option A — git** (if the project is in a repo):
```bash
cd ~
git clone <your-repo-url> load-test
cd load-test
```

**Option B — copy from your machine** (run this on your **laptop**, not the server):
```bash
scp -r "load testing app" user@your-server:~/load-test
```
Then on the server: `cd ~/load-test`

You should now see `load-test.js`, `run.sh`, `.env.example`, `routing_numbers.csv`, etc.

---

## Step 3 — Configure

```bash
cp .env.example .env
nano .env          # or vi
```

Fill in at least:
```ini
BASE_URL=https://dev.api.vikexpress.com
USERS=3
CYCLES_PER_USER=100

USER1_UID=wingcash:...
USER1_MANAGER_UID=wingcash:...
USER1_USERNAME=...
USER1_PASSWORD=...

USER2_UID=...
USER2_MANAGER_UID=...
USER2_USERNAME=...
USER2_PASSWORD=...

USER3_UID=...
USER3_MANAGER_UID=...
USER3_USERNAME=...
USER3_PASSWORD=...
```

Lock the file down so other users on the box can't read the passwords:
```bash
chmod 600 .env
```

`.env` is in `.gitignore` — it will never be committed.

---

## Step 4 — Routing numbers

`routing_numbers.csv` ships with the project. To use your own list, replace it:
```bash
nano routing_numbers.csv
```
Format (header optional, last all-digits column is used):
```csv
ID,Routing Number
1,096016930
2,021000021
```

---

## Step 5 — Smoke test (30 seconds)

Make the runner executable, then do a tiny run to confirm auth + connectivity:
```bash
chmod +x run.sh
./run.sh -e USERS=1 -e CYCLES_PER_USER=2
```

Expect: `succeeded 2 / failed 0`, `token 200`, `query 200`. If you see token
errors, the credentials or `BASE_URL` are wrong — fix `.env` and retry.

---

## Step 6 — Run the real test

```bash
./run.sh                              # uses USERS / CYCLES_PER_USER from .env
# or override for one run:
./run.sh -e USERS=3 -e CYCLES_PER_USER=100
```

For a run that takes more than a minute, start it so it survives your SSH session
dropping — use **tmux**:
```bash
tmux new -s loadtest
./run.sh -e USERS=3 -e CYCLES_PER_USER=100
#   detach:  Ctrl+b then d
#   come back later:  tmux attach -t loadtest
```

Or **nohup** (no live output, check the log after):
```bash
nohup ./run.sh -e USERS=3 -e CYCLES_PER_USER=100 > run.log 2>&1 &
tail -f run.log
```

---

## Step 7 — Get the results

Results land in `results/` on the server:
```
results/requests-3u-100c-<timestamp>.csv   <- main file: every request + summary at the bottom
results/summary-3u-100c-<timestamp>.json
results/requests-latest.csv                <- always the newest run
results/summary-latest.json
```

Copy them to your machine (run on your **laptop**):
```bash
scp user@your-server:~/load-test/results/requests-latest.csv .
# or grab everything:
scp -r user@your-server:~/load-test/results .
```

Open `requests-latest.csv` in Excel — it has the per-request rows **and** the full
run summary (totals, latency percentiles, thresholds) at the bottom.

---

## Optional — scheduled runs (cron)

Run every night at 2:00 AM and keep each run's output:
```bash
crontab -e
```
Add:
```cron
0 2 * * * cd /home/USER/load-test && ./run.sh -e USERS=3 -e CYCLES_PER_USER=100 >> /home/USER/load-test/cron.log 2>&1
```
The timestamped files in `results/` accumulate, one set per run, so you get a
history automatically.

---

## Optional — Docker (no k6 install)

If the server has Docker and you'd rather not install k6:
```bash
cd ~/load-test
set -a; . ./.env; set +a          # load .env into the shell
docker run --rm -i \
  -v "$PWD:/src" -w /src \
  -e USERS -e CYCLES_PER_USER -e BASE_URL \
  -e USER1_UID -e USER1_MANAGER_UID -e USER1_USERNAME -e USER1_PASSWORD \
  -e USER2_UID -e USER2_MANAGER_UID -e USER2_USERNAME -e USER2_PASSWORD \
  -e USER3_UID -e USER3_MANAGER_UID -e USER3_USERNAME -e USER3_PASSWORD \
  grafana/k6 run load-test.js
```
Note: with plain `docker run` you don't get the `run.sh` post-processing (the
per-request CSV + appended summary). You get k6's console summary and
`results/summary-*.json` / `report-*.csv`. Use the `run.sh` path (Steps 5–6) if
you want the full `requests-*.csv`.

---

## Security checklist

- [ ] `.env` is `chmod 600` and never committed (it's git-ignored).
- [ ] `results/` is git-ignored — the request log can contain response bodies.
      Don't push it anywhere without checking.
- [ ] The test only ever talks to `BASE_URL`. Confirm that's the sandbox/dev host.
- [ ] Passwords and tokens are never written to logs by the test itself
      (credentials are masked, tokens redacted).
- [ ] If multiple people use the server, keep the project in your home dir, not a
      shared path.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `k6: command not found` | Step 1 didn't finish, or `/usr/local/bin` isn't on `PATH` |
| `./run.sh: Permission denied` | `chmod +x run.sh` |
| `Missing env vars for user N` | `USERS` is higher than the `USER<n>_*` blocks you filled in |
| all cycles fail at TOKEN, `http 404` | `BASE_URL` wrong, or `TOKEN_AUTH_MODE` not `basic` |
| all cycles fail at TOKEN, `http 401` | wrong username/password in `.env` |
| `no routing numbers were loaded` | `routing_numbers.csv` missing or empty; check `ROUTING_NUMBERS_FILE` |
| run stops when I disconnect SSH | use `tmux` or `nohup` (Step 6) |
| latency thresholds FAIL but nothing errored | expected on shared dev — raise `THRESH_*` in `.env` or ignore exit code 99 |

---

## One-page quick version

```bash
# on the server, once:
sudo apt-get install k6                       # or see Step 1
git clone <repo> load-test && cd load-test    # or scp the folder
cp .env.example .env && nano .env && chmod 600 .env
chmod +x run.sh

# smoke:
./run.sh -e USERS=1 -e CYCLES_PER_USER=2

# real run (survives disconnect):
tmux new -s lt
./run.sh -e USERS=3 -e CYCLES_PER_USER=100
# Ctrl+b d to detach

# from your laptop, get results:
scp user@server:~/load-test/results/requests-latest.csv .
```
