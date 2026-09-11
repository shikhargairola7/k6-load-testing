# Deploying the load test on a Windows VM

Step-by-step guide to running this test from a Windows Server / Windows VM
instead of your laptop. (For a Linux server instead, see
[DEPLOYMENT.md](DEPLOYMENT.md).)

## Why put it on a VM?

Same reasons as any server: a stable/fast network path to the API, more CPU for
bigger user counts, scheduled runs, or a run that keeps going after you
disconnect. If none of that applies, your laptop is fine — everything below is
exactly what you've already been doing locally, just on a different machine.

## What you need

- A Windows VM you can RDP into — Windows Server 2019/2022 or Windows 10/11.
  2 vCPU / 2 GB RAM is plenty for up to ~200 users.
- RDP access with an admin (or at least a normal) account.
- The test users' credentials (kept only on the VM, never in git).

---

## Step 1 — Install k6

RDP into the VM, open **PowerShell**, then pick one:

**winget** (built into Windows 10/11 and Server 2022):
```powershell
winget install GrafanaLabs.k6
```

**Chocolatey** (if already installed on the VM):
```powershell
choco install k6
```

**Manual** (no admin rights / no package manager):
1. Download the Windows zip from https://github.com/grafana/k6/releases/latest
   (`k6-vX.Y.Z-windows-amd64.zip`)
2. Extract it, e.g. to `C:\k6\`
3. Add `C:\k6` to your `PATH`:
   ```powershell
   [Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\k6", "User")
   ```
4. Open a **new** PowerShell window (PATH changes need a fresh shell).

Check it:
```powershell
k6 version
```

---

## Step 2 — Get the project onto the VM

**Option A — Git for Windows** (install it first if missing: `winget install Git.Git`):
```powershell
cd C:\
git clone <your-repo-url> load-test
cd load-test
```

**Option B — copy over RDP**
If clipboard/drive redirection is enabled on your RDP client, just copy the
`load testing app` folder on your laptop and paste it into the VM (e.g. into
`C:\load-test`).

**Option C — from a Linux jump host / your laptop, via scp**
(needs the OpenSSH Server optional feature enabled on the VM):
```powershell
# on the VM, one-time:
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
```
```bash
# from your laptop:
scp -r "load testing app" administrator@vm-ip:C:/load-test
```

You should end up with `load-test.js`, `run.ps1`, `.env.example`,
`routing_numbers.csv`, etc. in `C:\load-test`.

---

## Step 3 — Configure

```powershell
cd C:\load-test
Copy-Item .env.example .env
notepad .env
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

Restrict who can read it (removes inherited access, grants only you + admins):
```powershell
icacls .env /inheritance:r /grant:r "$env:USERNAME:F" /grant:r "Administrators:F"
```

`.env` is in `.gitignore` — it will never be committed.

---

## Step 4 — Routing numbers

`routing_numbers.csv` ships with the project. To use your own list, edit it:
```powershell
notepad routing_numbers.csv
```
Format (header optional, last all-digits column is used):
```csv
ID,Routing Number
1,096016930
2,021000021
```

---

## Step 5 — Smoke test (30 seconds)

If this is the first PowerShell script you've run on this VM:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

Then:
```powershell
.\run.ps1 -e USERS=1 -e CYCLES_PER_USER=2
```

Expect: `succeeded 2 / failed 0`, `token 200`, `query 200`. If you see token
errors, the credentials or `BASE_URL` are wrong — fix `.env` and retry.

---

## Step 6 — Run the real test

```powershell
.\run.ps1                              # uses USERS / CYCLES_PER_USER from .env
# or override for one run:
.\run.ps1 -e USERS=3 -e CYCLES_PER_USER=100
```

### Keeping it running if you disconnect RDP

Good news: on Windows, if you just **disconnect** your RDP session (don't sign
out), everything you started keeps running in the background. Reconnect later
and your PowerShell window — and the run — is still there.

If the session might get **signed out** (not just disconnected) or you want it
to survive a reboot, run it detached instead:
```powershell
Start-Process powershell -ArgumentList '-NoExit','-Command',".\run.ps1 -e USERS=3 -e CYCLES_PER_USER=100" -WindowStyle Hidden
```
Or, more robustly, use **Task Scheduler** (see below) — that survives logoffs
and reboots.

---

## Step 7 — Get the results

Results land in `results\` on the VM:
```
results\requests-3u-100c-<timestamp>.csv   <- main file: every request + summary at the bottom
results\summary-3u-100c-<timestamp>.json
results\requests-latest.csv                <- always the newest run
results\summary-latest.json
```

Get them back to your laptop:
- **RDP drive redirection**: if your local drive is mapped in the RDP session,
  just copy-paste the file(s).
- **RDP clipboard**: copy the file in the VM's Explorer, paste on your laptop.
- **scp** (if OpenSSH Server is set up, see Step 2 Option C):
  ```bash
  scp administrator@vm-ip:C:/load-test/results/requests-latest.csv .
  ```

Open `requests-latest.csv` in Excel — per-request rows plus the full run summary
(totals, latency percentiles, thresholds) at the bottom.

---

## Optional — scheduled runs (Task Scheduler)

Run every night at 2:00 AM, surviving logoffs/reboots:

```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\load-test\run.ps1" -e USERS=3 -e CYCLES_PER_USER=100' `
  -WorkingDirectory "C:\load-test"
$trigger = New-ScheduledTaskTrigger -Daily -At 2:00AM
Register-ScheduledTask -TaskName "LoadTest-Nightly" -Action $action -Trigger $trigger -RunLevel Highest
```

The timestamped files in `results\` accumulate, one set per run, so you get a
history automatically. Check it any time:
```powershell
Get-ScheduledTask -TaskName "LoadTest-Nightly"
Start-ScheduledTask -TaskName "LoadTest-Nightly"   # run it right now, to test
```

---

## Security checklist

- [ ] `.env` access restricted (Step 3's `icacls`), never committed (it's git-ignored).
- [ ] `results\` is git-ignored — the request log can contain response bodies.
      Don't push it anywhere without checking.
- [ ] The test only ever talks to `BASE_URL`. Confirm that's the sandbox/dev host.
- [ ] Passwords and tokens are never written to logs by the test itself
      (credentials are masked, tokens redacted).
- [ ] If the VM is shared with other people, keep the project under your own
      profile, not a shared path.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `k6 : The term 'k6' is not recognized` | close and reopen PowerShell (PATH change needs a fresh shell), or re-check Step 1 |
| `.\run.ps1 : cannot be loaded because running scripts is disabled` | `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` |
| `Missing env vars for user N` | `USERS` is higher than the `USER<n>_*` blocks you filled in |
| all cycles fail at TOKEN, `http 404` | `BASE_URL` wrong, or `TOKEN_AUTH_MODE` not `basic` |
| all cycles fail at TOKEN, `http 401` | wrong username/password in `.env` |
| `no routing numbers were loaded` | `routing_numbers.csv` missing or empty; check `ROUTING_NUMBERS_FILE` |
| VM is behind a corporate proxy | set `$env:HTTPS_PROXY = "http://proxy:port"` before running — k6 respects it |
| run stops when I sign out (not just disconnect) | use Task Scheduler (above) instead of an interactive session |
| latency thresholds FAIL but nothing errored | expected on shared dev — raise `THRESH_*` in `.env`, or ignore exit code 99 |

---

## One-page quick version

```powershell
# on the VM, once:
winget install GrafanaLabs.k6
git clone <repo> C:\load-test; cd C:\load-test
Copy-Item .env.example .env; notepad .env
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

# smoke:
.\run.ps1 -e USERS=1 -e CYCLES_PER_USER=2

# real run:
.\run.ps1 -e USERS=3 -e CYCLES_PER_USER=100
# safe to disconnect RDP - it keeps running; reconnect to check on it

# from your laptop, get results (via RDP drive/clipboard, or scp):
scp administrator@vm-ip:C:/load-test/results/requests-latest.csv .
```
