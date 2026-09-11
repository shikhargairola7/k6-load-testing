// load-test.js
// -----------------------------------------------------------------------------
// k6 entry point.
//
// Model
//   1 user  = 1 k6 VU (thread).
//   Executor "per-vu-iterations": each VU runs exactly `cyclesPerUser`
//   iterations, sequentially. VUs run concurrently and never wait for each
//   other. So USERS x CYCLES_PER_USER cycles, 2 HTTP requests per cycle.
//
// One cycle (the default function)
//   cycleStart = nowMs()   (monotonic clock)
//     1. token request  (API 1)   -> checks -> on failure: mark cycle failed, STOP (no query)
//     2. routing query  (API 2)   -> checks -> on failure: mark cycle failed
//   cycleEnd = nowMs()
//   cycle_latency = cycleEnd - cycleStart   (token + query + client work between them)
//
// A failing cycle never aborts the run.
// Secrets (password, token) are never logged.
// -----------------------------------------------------------------------------

import exec from 'k6/execution';
import { check, sleep } from 'k6';

import { config, userForVU } from './config.js';
import { generateToken } from './lib/token.js';
import { routingNumberQuery } from './lib/query.js';
import { parseRoutingPool, pickRoutingNumber } from './lib/routingNumbers.js';
import {
  tokenLatency,
  queryLatency,
  cycleLatency,
  cyclesTotal,
  cyclesSucceeded,
  cyclesFailed,
  tokenErrors,
  queryErrors,
  httpStatus,
  cycleErrorRate,
} from './lib/metrics.js';
import { buildSummary } from './summary.js';
import { emitRequestLogHeader, logRequest } from './lib/requestLog.js';

// --- routing-number pool -----------------------------------------------------
// open() only works in the init context. Path is relative to THIS file.
let routingFileText = '';
if (config.routingStrategy !== 'per-user') {
  try {
    routingFileText = open(config.routingNumbersFile);
  } catch (e) {
    routingFileText = '';
  }
}
const routingPool = parseRoutingPool(routingFileText);

// --- no-op submetrics so handleSummary can report a status-code distribution ---
// `count>=0` is always true, so these never cause a failure; they only make k6
// track the {api,status} breakdown and expose it to handleSummary.
const statusThresholds = {};
for (const api of ['token', 'query']) {
  for (const sc of config.statusCodes) {
    statusThresholds[`http_status{api:${api},status:${sc}}`] = ['count>=0'];
  }
}

export const options = {
  scenarios: {
    cycle: {
      executor: 'per-vu-iterations',
      vus: config.users,
      iterations: config.cyclesPerUser,
      maxDuration: '2h',
    },
  },
  summaryTrendStats: ['min', 'avg', 'max', 'p(50)', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    cycle_latency: [
      `p(95)<${config.thresholds.cycleP95}`,
      `p(99)<${config.thresholds.cycleP99}`,
    ],
    token_latency: [`p(95)<${config.thresholds.tokenP95}`],
    query_latency: [`p(95)<${config.thresholds.queryP95}`],
    cycle_error_rate: [`rate<${config.thresholds.errorRate}`],
    ...statusThresholds,
  },
};

export function setup() {
  const cycles = config.users * config.cyclesPerUser;
  console.log(
    `[setup] ${config.users} user(s) x ${config.cyclesPerUser} cycle(s) = ` +
      `${cycles} cycles / ${cycles * 2} HTTP requests`
  );
  console.log(
    `[setup] base=${config.baseUrl}  authMode=${config.tokenAuthMode}  ` +
      `tokenField=${config.tokenJsonPath}  tokenReuse=${config.tokenReuse}  requestLog=${config.requestLog}`
  );
  console.log(
    `[setup] routingStrategy=${config.routingStrategy}  ` +
      (config.routingStrategy === 'per-user'
        ? 'source=USER<n>_ROUTING_NUMBER'
        : `pool=${routingPool.length} from ${config.routingNumbersFile}`)
  );
  if (config.routingStrategy !== 'per-user' && routingPool.length === 0) {
    throw new Error(
      `ROUTING_STRATEGY=${config.routingStrategy} but no routing numbers were loaded from ` +
        `"${config.routingNumbersFile}". Check the file path/contents or set ROUTING_STRATEGY=per-user.`
    );
  }
  emitRequestLogHeader(); // header row for results/requests-*.csv
  return {};
}

// VU-scoped cache, only used when TOKEN_REUSE=true.
let cachedToken = null;

const QUERY_URL = `${config.baseUrl}${config.queryPath}`;

// Monotonic, sub-millisecond clock for measuring durations. This k6 build has no
// global `performance`, so we use exec.instance.currentTestRunDuration (ms since
// test start). Unlike Date.now() it can't jump if the system clock is adjusted
// mid-run, which is what you want for a latency delta.
function nowMs() {
  return exec.instance.currentTestRunDuration;
}

export default function () {
  const user = userForVU(exec.vu.idInTest);
  const cycleIndex = exec.vu.iterationInScenario + 1; // 1-based cycle number for this user
  const cycleStart = nowMs();

  // Request-log rows are built now but EMITTED after the cycle timer stops, so
  // console I/O never inflates the latency numbers.
  let tokenRow = null;
  let queryRow = null;

  // ----------------------------- Step 1: token ------------------------------
  let token = config.tokenReuse ? cachedToken : null;

  if (!token) {
    const { res, token: fresh, request } = generateToken(user);
    httpStatus.add(1, { api: 'token', status: String(res.status) });
    // Only record latency when an HTTP response actually came back. status 0 =
    // connection-level failure (refused / DNS / TLS) with a ~0ms duration that
    // would otherwise skew the trend down. Such cycles are still counted as
    // failures below.
    if (res.status > 0) tokenLatency.add(res.timings.duration);

    const tokenOk = check(res, {
      'token: status is 2xx': (r) => r.status >= 200 && r.status < 300,
      'token: body is present': (r) => !!r.body && r.body.length > 0,
      'token: access token present': () => fresh !== undefined,
      'token: access token non-empty': () => typeof fresh === 'string' && fresh.length > 0,
    });
    const tokenPassed = tokenOk && !!fresh;

    tokenRow = {
      index: cycleIndex,
      userId: user.uid,
      api: 'token',
      routingNumber: '',
      requestUrl: request.url,
      requestBody: request.logBody,
      status: res.status,
      ok: tokenPassed,
      responseTimeMs: res.status > 0 ? res.timings.duration : undefined,
      timestamp: new Date().toISOString(),
      errorMessage: tokenPassed ? '' : `token step failed (http ${res.status})`,
      // never log the access token; on error the body is an error object (safe)
      responseBody:
        res.status >= 200 && res.status < 300 ? '<2xx: access_token redacted>' : res.body || '',
    };

    if (!tokenPassed) {
      tokenErrors.add(1);
      cyclesFailed.add(1);
      cyclesTotal.add(1);
      cycleErrorRate.add(true);
      console.warn(`[user ${user.index}] cycle ${cycleIndex} failed at TOKEN step (http ${res.status})`);
      logRequest(tokenRow);
      maybeSleep();
      return; // never call the query API with an invalid token
    }

    token = fresh;
    if (config.tokenReuse) cachedToken = token;
  }

  // ------------------------ Step 2: routing query --------------------------
  const routingNumber = pickRoutingNumber(routingPool, config.routingStrategy, user);
  const qRes = routingNumberQuery(token, routingNumber);
  httpStatus.add(1, { api: 'query', status: String(qRes.status) });
  if (qRes.status > 0) queryLatency.add(qRes.timings.duration);

  const queryOk = check(qRes, {
    'query: status is 2xx': (r) => r.status >= 200 && r.status < 300,
    'query: body is present': (r) => !!r.body && r.body.length > 0,
    'query: response is JSON object': (r) => {
      try {
        const j = r.json();
        return typeof j === 'object' && j !== null;
      } catch (e) {
        return false;
      }
    },
  });

  // ------------------------------ cycle end -------------------------------
  cycleLatency.add(nowMs() - cycleStart);
  cyclesTotal.add(1);

  if (queryOk) {
    cyclesSucceeded.add(1);
    cycleErrorRate.add(false);
  } else {
    queryErrors.add(1);
    cyclesFailed.add(1);
    cycleErrorRate.add(true);
    if (config.tokenReuse) cachedToken = null; // drop a possibly-stale reused token
    console.warn(`[user ${user.index}] cycle ${cycleIndex} failed at QUERY step (http ${qRes.status})`);
  }

  queryRow = {
    index: cycleIndex,
    userId: user.uid,
    api: 'query',
    routingNumber: routingNumber,
    requestUrl: QUERY_URL,
    requestBody: JSON.stringify({ routing_number: routingNumber }),
    status: qRes.status,
    ok: queryOk,
    responseTimeMs: qRes.status > 0 ? qRes.timings.duration : undefined,
    timestamp: new Date().toISOString(),
    errorMessage: queryOk ? '' : `query step failed (http ${qRes.status})`,
    responseBody: qRes.body || '',
  };

  // Emit both rows now that timing is locked in.
  if (tokenRow) logRequest(tokenRow);
  logRequest(queryRow);

  maybeSleep();
}

function maybeSleep() {
  if (config.sleepBetweenCycles > 0) sleep(config.sleepBetweenCycles);
}

export function handleSummary(data) {
  return buildSummary(data, config);
}
