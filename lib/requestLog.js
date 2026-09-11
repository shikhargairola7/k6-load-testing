// lib/requestLog.js
// -----------------------------------------------------------------------------
// Per-request detail log.
//
// Why it works this way
//   A k6 VU cannot write files and does not share memory with handleSummary
//   (every VU + the summary run in separate JS runtimes). The ONLY way data
//   leaves a VU is a metric (numbers only) or a console line. So each request
//   emits ONE console line:
//
//       @@REQ@@ <base64 of a CSV row>
//
//   base64 keeps the payload as a single space/quote/comma-free token, so k6's
//   logfmt wrapper (msg="...") can't corrupt it. run.ps1 / run.sh decode these
//   lines into results/requests-<runId>.csv (and the PS wrapper also folds the
//   rows into results/summary-*.json).
//
// Cost per request: one String build + one b64encode + one console.log — a few
// microseconds, and all of it happens AFTER the cycle timer is stopped, so the
// latency numbers are unaffected. Set REQUEST_LOG=false to remove even that.
// -----------------------------------------------------------------------------

import encoding from 'k6/encoding';
import { config } from '../config.js';

export const REQUEST_LOG_COLUMNS = [
  'index',          // 1-based cycle number for this user
  'userId',         // user uid
  'environment',    // ENV_LABEL (default: first part of BASE_URL host)
  'api',            // token | query
  'routingNumber',  // routing number used this request (query rows only)
  'requestUrl',
  'requestBody',    // credentials masked
  'status',         // HTTP status (0 = connection failure)
  'ok',             // true | false
  'responseTimeMs', // this request's server round-trip
  'timestamp',      // ISO time the request finished
  'errorMessage',
  'responseBody',   // capped at RESPONSE_BODY_MAX; token bodies redacted
];

function cell(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).replace(/[\r\n\t]+/g, ' ');
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Clip a body/error string to the configured cap.
export function clip(s) {
  if (s === undefined || s === null) return '';
  const str = String(s);
  if (config.responseBodyMax <= 0) return '';
  return str.length > config.responseBodyMax ? str.slice(0, config.responseBodyMax) + '…' : str;
}

export function emitRequestLogHeader() {
  if (!config.requestLog) return;
  console.log('@@REQHDR@@ ' + encoding.b64encode(REQUEST_LOG_COLUMNS.join(',')));
}

export function logRequest(rec) {
  if (!config.requestLog) return;
  const row = [
    rec.index,
    rec.userId,
    config.envLabel,
    rec.api,
    rec.routingNumber === undefined || rec.routingNumber === null ? '' : rec.routingNumber,
    rec.requestUrl,
    clip(rec.requestBody),
    rec.status,
    rec.ok ? 'true' : 'false',
    rec.responseTimeMs === undefined || rec.responseTimeMs === null
      ? ''
      : Number(rec.responseTimeMs).toFixed(2),
    rec.timestamp,
    clip(rec.errorMessage),
    clip(rec.responseBody),
  ]
    .map(cell)
    .join(',');
  console.log('@@REQ@@ ' + encoding.b64encode(row));
}
