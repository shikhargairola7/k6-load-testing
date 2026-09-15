// summary.js
// -----------------------------------------------------------------------------
// Custom end-of-test report. Returns:
//   - stdout                  : a readable summary block
//   - results/summary-<ts>.json  : machine-readable report (timestamped)
//   - results/summary-latest.json: same, overwritten each run
//
// Defining handleSummary() replaces k6's built-in end-of-test table, so this
// module reproduces the useful parts (totals, percentiles, thresholds) plus the
// cycle-level view the test is about.
// -----------------------------------------------------------------------------

// cycle_latency = cycleEnd - cycleStart (see load-test.js header comment). It
// covers the token call + query call + whatever JS runs between them (checks,
// token extraction, etc.), so it's not a pure network/server number the way
// token_latency and query_latency are. Called out explicitly in both the
// stdout summary and the report CSV so it isn't mistaken for pure server RTT.
const CYCLE_LATENCY_NOTE =
  'cycle_latency includes client-side JS work between the token and query calls ' +
  '(checks, token extraction, etc.), not pure network/server latency — see token_latency / query_latency for that.';

function n2(x) {
  return x === undefined || x === null || Number.isNaN(x) ? 'n/a' : Number(x).toFixed(2);
}

function count(data, name) {
  const m = data.metrics[name];
  return m && m.values && m.values.count !== undefined ? m.values.count : 0;
}

function rate(data, name) {
  const m = data.metrics[name];
  return m && m.values && m.values.rate !== undefined ? m.values.rate : 0;
}

function trendStats(data, name) {
  const m = data.metrics[name];
  if (!m || !m.values) return null;
  const v = m.values;
  // k6 still reports a Trend with all-zero values when it never got a sample.
  if (!v.max && !v.avg && !v.min && !v['p(95)']) return null;
  return {
    min: v.min,
    avg: v.avg,
    max: v.max,
    p50: v['p(50)'],
    p90: v['p(90)'],
    p95: v['p(95)'],
    p99: v['p(99)'],
  };
}

function trendLine(label, s) {
  if (!s) return `    ${label.padEnd(11)} (no data)`;
  return (
    `    ${label.padEnd(11)}` +
    `min=${n2(s.min)}  avg=${n2(s.avg)}  p50=${n2(s.p50)}  p90=${n2(s.p90)}  ` +
    `p95=${n2(s.p95)}  p99=${n2(s.p99)}  max=${n2(s.max)}`
  );
}

function statusDistribution(data) {
  const rows = [];
  for (const key of Object.keys(data.metrics)) {
    const m = key.match(/^http_status\{api:([^,]+),status:([^}]+)\}$/);
    if (!m) continue;
    const c = count(data, key);
    if (c > 0) rows.push({ api: m[1], status: m[2], count: c });
  }
  rows.sort((a, b) => (a.api === b.api ? a.status.localeCompare(b.status) : a.api.localeCompare(b.api)));
  return rows;
}

function tokenFailureBreakdown(data) {
  const rows = [];
  for (const key of Object.keys(data.metrics)) {
    const m = key.match(/^token_failure_reason\{reason:([^}]+)\}$/);
    if (!m) continue;
    const c = count(data, key);
    if (c > 0) rows.push({ reason: m[1], count: c });
  }
  rows.sort((a, b) => b.count - a.count);
  return rows;
}

function thresholdResults(data) {
  const out = [];
  for (const [name, m] of Object.entries(data.metrics)) {
    if (!m.thresholds) continue;
    // internal no-op submetrics, not user-facing
    if (name.startsWith('http_status') || name.startsWith('token_failure_reason')) continue;
    for (const [expr, res] of Object.entries(m.thresholds)) {
      out.push({ metric: name, threshold: expr, ok: !!res.ok });
    }
  }
  return out;
}

export function buildSummary(data, config) {
  const durationS = ((data.state && data.state.testRunDurationMs) || 0) / 1000;

  const cyclesExpected = config.users * config.cyclesPerUser;
  const cyclesTotal = count(data, 'cycles_total');
  const cyclesSucceeded = count(data, 'cycles_succeeded');
  const cyclesFailed = count(data, 'cycles_failed');
  const httpReqs = count(data, 'http_reqs');
  const tokenErr = count(data, 'token_errors');
  const queryErr = count(data, 'query_errors');
  const errRate = rate(data, 'cycle_error_rate');

  const token = trendStats(data, 'token_latency');
  const query = trendStats(data, 'query_latency');
  const cycle = trendStats(data, 'cycle_latency');

  const statuses = statusDistribution(data);
  const tokenFailures = tokenFailureBreakdown(data);
  const thresholds = thresholdResults(data);
  const failed = thresholds.filter((t) => !t.ok);

  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      baseUrl: config.baseUrl,
      users: config.users,
      cyclesPerUser: config.cyclesPerUser,
      tokenAuthMode: config.tokenAuthMode,
      tokenJsonPath: config.tokenJsonPath,
      tokenReuse: config.tokenReuse,
    },
    totals: {
      testDurationSeconds: Number(durationS.toFixed(2)),
      cyclesExpected,
      cyclesTotal,
      cyclesSucceeded,
      cyclesFailed,
      httpRequestsTotal: httpReqs,
      requestsPerSecond: Number(rate(data, 'http_reqs').toFixed(3)),
      cyclesPerSecond: Number(rate(data, 'cycles_total').toFixed(3)),
      errorRate: Number(errRate.toFixed(5)),
      tokenErrors: tokenErr,
      queryErrors: queryErr,
    },
    latencyMs: { token, query, cycle },
    httpStatusDistribution: statuses,
    tokenFailureReasons: tokenFailures,
    thresholds,
  };

  const L = [];
  L.push('');
  L.push('==================== LOAD TEST SUMMARY ====================');
  L.push(`  base URL      ${config.baseUrl}`);
  L.push(`  model         ${config.users} user(s) x ${config.cyclesPerUser} cycle(s)   (1 user = 1 VU / thread)`);
  L.push(`  auth mode     ${config.tokenAuthMode}   token field: ${config.tokenJsonPath}   token reuse: ${config.tokenReuse}`);
  L.push(`  duration      ${n2(durationS)}s`);
  L.push('');
  L.push('  Cycles');
  L.push(`    expected    ${cyclesExpected}`);
  L.push(`    completed   ${cyclesTotal}`);
  L.push(`    succeeded   ${cyclesSucceeded}`);
  L.push(`    failed      ${cyclesFailed}   (token errors: ${tokenErr}, query errors: ${queryErr})`);
  L.push(`    cycles/sec  ${n2(rate(data, 'cycles_total'))}`);
  L.push('');
  if (tokenFailures.length) {
    L.push('  Token failure reasons');
    for (const f of tokenFailures) L.push(`    ${f.reason.padEnd(16)} ${f.count}`);
    L.push('');
  }
  L.push('  HTTP');
  L.push(`    requests    ${httpReqs}`);
  L.push(`    req/sec     ${n2(rate(data, 'http_reqs'))}`);
  L.push(`    error rate  ${n2(errRate * 100)}%`);
  L.push('');
  L.push('  Latency (ms)');
  L.push(trendLine('token API', token));
  L.push(trendLine('query API', query));
  L.push(trendLine('full cycle', cycle));
  L.push(`    note: ${CYCLE_LATENCY_NOTE}`);
  L.push('');
  if (statuses.length) {
    L.push('  HTTP status distribution');
    for (const s of statuses) L.push(`    ${s.api.padEnd(6)} ${String(s.status).padEnd(4)} ${s.count}`);
    L.push('');
  }
  L.push('  Thresholds');
  if (!thresholds.length) {
    L.push('    (none evaluated)');
  } else {
    for (const t of thresholds) L.push(`    [${t.ok ? 'PASS' : 'FAIL'}] ${t.metric}  ${t.threshold}`);
  }
  L.push('');
  L.push(
    failed.length
      ? `  RESULT: FAIL - ${failed.length} threshold(s) breached`
      : '  RESULT: all thresholds passed'
  );
  L.push('==========================================================');
  L.push('');

  // Output files are named  <type>-<U>u-<C>c-<timestamp>.  The wrapper passes a
  // ready-made RUN_ID; a bare `k6 run` builds the same shape here.
  const stamp =
    config.runId ||
    `${config.users}u-${config.cyclesPerUser}c-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const json = JSON.stringify(report, null, 2);

  const out = {
    stdout: L.join('\n'),
    [`results/summary-${stamp}.json`]: json,
    'results/summary-latest.json': json,
    // report-<stamp>.csv is the source the wrappers append to the bottom of
    // requests-*.csv; run.ps1 / run.sh delete it afterwards. On a bare `k6 run`
    // (no wrapper) it stays as the standalone CSV summary.
    [`results/report-${stamp}.csv`]: buildReportCsv(report),
  };

  // One flat row per run, for stacking several runs to compare. Off by default;
  // set RUN_SUMMARY_CSV=true when doing a load-scaling comparison.
  if (config.runSummaryCsv) {
    const runCsv = buildRunSummaryCsv(report);
    out[`results/run-summary-${stamp}.csv`] = runCsv;
    out['results/run-summary-latest.csv'] = runCsv;
  }

  return out;
}

// --- CSV builders -----------------------------------------------------------

function csvCell(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

function r2(x) {
  return x === undefined || x === null || Number.isNaN(x) ? '' : Number(Number(x).toFixed(2));
}

// A tall, human-readable block: run info + totals + latency table + status
// distribution + thresholds + result. Written as results/report-*.csv and
// appended to the bottom of results/requests-*.csv by run.ps1 / run.sh, so the
// whole picture is in one sheet with no need to open the JSON.
function buildReportCsv(report) {
  const t = report.totals;
  const lt = report.latencyMs;
  const failed = report.thresholds.filter((x) => !x.ok).length;
  const rows = [];

  rows.push('# RUN SUMMARY');
  rows.push(csvRow(['generated_at', report.generatedAt]));
  rows.push(csvRow(['base_url', report.config.baseUrl]));
  rows.push(csvRow(['model', `${report.config.users} users x ${report.config.cyclesPerUser} cycles`]));
  rows.push(csvRow(['auth_mode', report.config.tokenAuthMode]));
  rows.push(csvRow(['token_reuse', report.config.tokenReuse]));
  rows.push(csvRow(['test_duration_s', t.testDurationSeconds]));
  rows.push('');

  rows.push('# CYCLES');
  rows.push(csvRow(['expected', t.cyclesExpected]));
  rows.push(csvRow(['total', t.cyclesTotal]));
  rows.push(csvRow(['succeeded', t.cyclesSucceeded]));
  rows.push(csvRow(['failed', t.cyclesFailed]));
  rows.push(csvRow(['token_errors', t.tokenErrors]));
  rows.push(csvRow(['query_errors', t.queryErrors]));
  rows.push(csvRow(['cycles_per_sec', t.cyclesPerSecond]));
  rows.push('');

  rows.push('# HTTP');
  rows.push(csvRow(['requests_total', t.httpRequestsTotal]));
  rows.push(csvRow(['requests_per_sec', t.requestsPerSecond]));
  rows.push(csvRow(['error_rate_pct', r2(t.errorRate * 100)]));
  rows.push('');

  rows.push('# LATENCY (ms)');
  rows.push(csvRow(['stage', 'min', 'avg', 'p50', 'p90', 'p95', 'p99', 'max']));
  for (const [stage, s] of [
    ['token_api', lt.token],
    ['query_api', lt.query],
    ['full_cycle', lt.cycle],
  ]) {
    rows.push(
      s
        ? csvRow([stage, r2(s.min), r2(s.avg), r2(s.p50), r2(s.p90), r2(s.p95), r2(s.p99), r2(s.max)])
        : csvRow([stage, '', '', '', '', '', '', ''])
    );
  }
  rows.push(csvRow(['note', CYCLE_LATENCY_NOTE]));
  rows.push('');

  rows.push('# HTTP STATUS');
  rows.push(csvRow(['api', 'status', 'count']));
  for (const s of report.httpStatusDistribution) rows.push(csvRow([s.api, s.status, s.count]));
  rows.push('');

  rows.push('# TOKEN FAILURE REASONS');
  rows.push(csvRow(['reason', 'count']));
  for (const f of report.tokenFailureReasons) rows.push(csvRow([f.reason, f.count]));
  rows.push('');

  rows.push('# THRESHOLDS');
  rows.push(csvRow(['threshold', 'result']));
  for (const x of report.thresholds) {
    rows.push(csvRow([`${x.metric} ${x.threshold}`, x.ok ? 'PASS' : 'FAIL']));
  }
  rows.push('');

  rows.push(
    csvRow(['RESULT', failed ? `FAIL - ${failed} threshold(s) breached` : 'all thresholds passed'])
  );

  return rows.join('\n') + '\n';
}

// One header + one data row for the whole run. Append rows from several runs
// (1-user, 2-user, 3-user ...) into one sheet to compare them.
function buildRunSummaryCsv(report) {
  const t = report.totals;
  const lt = report.latencyMs;
  const g = (o, k) => (o ? r2(o[k]) : '');
  const cols = {
    generated_at: report.generatedAt,
    base_url: report.config.baseUrl,
    users: report.config.users,
    cycles_per_user: report.config.cyclesPerUser,
    token_reuse: report.config.tokenReuse,
    test_duration_s: t.testDurationSeconds,
    cycles_expected: t.cyclesExpected,
    cycles_total: t.cyclesTotal,
    cycles_succeeded: t.cyclesSucceeded,
    cycles_failed: t.cyclesFailed,
    token_errors: t.tokenErrors,
    query_errors: t.queryErrors,
    http_requests_total: t.httpRequestsTotal,
    requests_per_sec: t.requestsPerSecond,
    cycles_per_sec: t.cyclesPerSecond,
    error_rate: t.errorRate,
    token_min: g(lt.token, 'min'),
    token_avg: g(lt.token, 'avg'),
    token_p50: g(lt.token, 'p50'),
    token_p90: g(lt.token, 'p90'),
    token_p95: g(lt.token, 'p95'),
    token_p99: g(lt.token, 'p99'),
    token_max: g(lt.token, 'max'),
    query_min: g(lt.query, 'min'),
    query_avg: g(lt.query, 'avg'),
    query_p50: g(lt.query, 'p50'),
    query_p90: g(lt.query, 'p90'),
    query_p95: g(lt.query, 'p95'),
    query_p99: g(lt.query, 'p99'),
    query_max: g(lt.query, 'max'),
    cycle_min: g(lt.cycle, 'min'),
    cycle_avg: g(lt.cycle, 'avg'),
    cycle_p50: g(lt.cycle, 'p50'),
    cycle_p90: g(lt.cycle, 'p90'),
    cycle_p95: g(lt.cycle, 'p95'),
    cycle_p99: g(lt.cycle, 'p99'),
    cycle_max: g(lt.cycle, 'max'),
    thresholds_failed: report.thresholds.filter((x) => !x.ok).length,
    result: report.thresholds.some((x) => !x.ok) ? 'FAIL' : 'PASS',
  };
  return csvRow(Object.keys(cols)) + '\n' + csvRow(Object.values(cols)) + '\n';
}
