// config.js
// -----------------------------------------------------------------------------
// Central configuration. EVERY value comes from an environment variable (__ENV).
// Nothing user-specific is hardcoded. See .env.example for the full list.
//
// Why a single config module:
//  - one place to read/validate env vars
//  - the k6 script and the lib/* helpers all import the same typed object
//  - changing users / cycles / URLs / thresholds never requires editing source
// -----------------------------------------------------------------------------

function env(name, fallback) {
  const v = __ENV[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(name, fallback) {
  const v = env(name, undefined);
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env ${name} must be an integer, got "${v}"`);
  return n;
}

function envFloat(name, fallback) {
  const v = env(name, undefined);
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  if (Number.isNaN(n)) throw new Error(`Env ${name} must be a number, got "${v}"`);
  return n;
}

function envBool(name, fallback) {
  const v = env(name, undefined);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const USERS = envInt('USERS', 1);
const CYCLES_PER_USER = envInt('CYCLES_PER_USER', 100);
const TOKEN_AUTH_MODE = env('TOKEN_AUTH_MODE', 'basic').toLowerCase(); // basic | none | body
// random | sequential -> pick from ROUTING_NUMBERS_FILE ; per-user -> use USER<n>_ROUTING_NUMBER
const ROUTING_STRATEGY = env('ROUTING_STRATEGY', 'random').toLowerCase();

const PERMISSIONS = env(
  'PERMISSIONS',
  'view_history,view_wallet,send_to_account,withdraw_from_account,send_cash'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const STATUS_CODES = env('STATUS_CODES', '200,400,401,403,404,429,500,502,503')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Build a single user's config from USER<n>_* env vars, failing fast if a
// required field is missing so the run never starts half-configured.
function buildUser(n) {
  const prefix = `USER${n}_`;
  const required = ['UID', 'MANAGER_UID'];
  if (TOKEN_AUTH_MODE !== 'none') required.push('USERNAME', 'PASSWORD');
  // A per-user routing number is only mandatory when we're not pulling from the file.
  if (ROUTING_STRATEGY === 'per-user') required.push('ROUTING_NUMBER');

  const missing = required.filter((f) => env(prefix + f, undefined) === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Missing env vars for user ${n}: ${missing.map((f) => prefix + f).join(', ')}. ` +
        `Set them in .env (see .env.example), or lower USERS if you configured fewer users.`
    );
  }

  return {
    index: n,
    uid: env(prefix + 'UID'),
    managerUid: env(prefix + 'MANAGER_UID'),
    username: env(prefix + 'USERNAME', ''),
    password: env(prefix + 'PASSWORD', ''),
    routingNumber: env(prefix + 'ROUTING_NUMBER', ''), // fallback only; see ROUTING_STRATEGY
  };
}

const BASE_URL = env('BASE_URL', 'https://sandbox.api.vikexpress.com');
const ENV_LABEL =
  env('ENV_LABEL', undefined) ||
  BASE_URL.replace(/^https?:\/\//, '').split(/[./:]/).filter(Boolean)[0] ||
  'env';

export const config = {
  baseUrl: BASE_URL,
  tokenPath: env('TOKEN_PATH', '/rest-api/profile-access/token'),
  queryPath: env('QUERY_PATH', '/rest-api/wallet/report/routing-number/query'),

  users: USERS,
  cyclesPerUser: CYCLES_PER_USER,

  tokenJsonPath: env('TOKEN_JSON_PATH', 'access_token'), // dot-path allowed, e.g. data.access_token
  tokenAuthMode: TOKEN_AUTH_MODE,
  tokenReuse: envBool('TOKEN_REUSE', false),
  tokenSource: env('TOKEN_SOURCE', ''), // "source" field in the token payload (was "web"; set TOKEN_SOURCE=web to restore)

  permissions: PERMISSIONS,
  statusCodes: STATUS_CODES,
  httpTimeout: env('HTTP_TIMEOUT', '60s'),
  sleepBetweenCycles: envFloat('SLEEP_BETWEEN_CYCLES', 0),

  // Routing number source. random/sequential pull from the CSV file (path
  // relative to load-test.js); per-user uses USER<n>_ROUTING_NUMBER.
  routingStrategy: ROUTING_STRATEGY,
  routingNumbersFile: env('ROUTING_NUMBERS_FILE', './routing_numbers.csv'),

  // One-flat-row-per-run CSV for comparing several runs. Off by default.
  runSummaryCsv: envBool('RUN_SUMMARY_CSV', false),

  // Per-request detail log (results/requests-*.csv, built by the wrapper).
  requestLog: envBool('REQUEST_LOG', true),
  responseBodyMax: envInt('RESPONSE_BODY_MAX', 500), // chars kept from bodies; 0 = none
  envLabel: ENV_LABEL,
  runId: env('RUN_ID', undefined), // set by run.ps1/run.sh so all output files share a stamp

  thresholds: {
    cycleP95: envInt('THRESH_CYCLE_P95', 2000),
    cycleP99: envInt('THRESH_CYCLE_P99', 5000),
    tokenP95: envInt('THRESH_TOKEN_P95', 1000),
    queryP95: envInt('THRESH_QUERY_P95', 1000),
    errorRate: envFloat('THRESH_ERROR_RATE', 0.01),
  },
};

// Only the users that will actually run are built (and validated).
export const users = [];
for (let n = 1; n <= USERS; n++) users.push(buildUser(n));

// Map a k6 VU id (1-based, from exec.vu.idInTest) onto a configured user.
// With USERS VUs and USERS users this is a 1:1 mapping; the modulo keeps it
// safe if someone runs more VUs than configured users.
export function userForVU(vuId) {
  return users[(vuId - 1) % users.length];
}
