// lib/token.js
// -----------------------------------------------------------------------------
// API 1 - access token generation.
//
//   POST {baseUrl}{tokenPath}
//   Content-Type: application/json
//   Authorization: Basic base64(username:password)   (when TOKEN_AUTH_MODE=basic)
//   body: { uid, manager_uid, concurrent, device_name, device_uuid, source, permissions }
//
// Token extraction is configurable (config.tokenJsonPath, default "access_token")
// because the exact response field is environment-specific. A dot-path such as
// "data.access_token" is supported.
//
// NOTE on the sandbox: calling this endpoint with NO Authorization header returns
// a misleading HTTP 404. Sending a Basic header advances it to real auth
// handling (401 on bad creds, 2xx + token on good creds). Hence auth mode
// "basic" is the default.
// -----------------------------------------------------------------------------

import http from 'k6/http';
import encoding from 'k6/encoding';
import { config } from '../config.js';

function getByPath(obj, path) {
  return path
    .split('.')
    .reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

export function buildTokenRequest(user) {
  const url = `${config.baseUrl}${config.tokenPath}`;

  const payload = {
    uid: user.uid,
    manager_uid: user.managerUid,
    concurrent: true,
    device_name: '',
    device_uuid: '',
    source: config.tokenSource,
    permissions: config.permissions,
  };

  const headers = { 'Content-Type': 'application/json' };

  if (config.tokenAuthMode === 'basic') {
    headers['Authorization'] = `Basic ${encoding.b64encode(`${user.username}:${user.password}`)}`;
  } else if (config.tokenAuthMode === 'body') {
    payload.username = user.username;
    payload.password = user.password;
  }

  // Body with credentials masked, for the per-request log.
  const logPayload = Object.assign({}, payload);
  if (logPayload.username !== undefined) logPayload.username = '***';
  if (logPayload.password !== undefined) logPayload.password = '***';

  return {
    url,
    body: JSON.stringify(payload),
    logBody: JSON.stringify(logPayload),
    params: {
      headers,
      timeout: config.httpTimeout,
      tags: { api: 'token' },
    },
  };
}

// Confirmed sandbox success shape:
//   { "status": "success", "access_token": "...", "expires_in": "..." }
// The configured path (TOKEN_JSON_PATH, default "access_token") is tried first;
// these are fallbacks in case an account/environment varies the field name.
const TOKEN_FALLBACK_PATHS = ['access_token', 'token', 'Token', 'data.token', 'data.access_token'];

// Pull the token string out of a response body. Returns undefined if the body
// is not JSON, no known field holds it, or the value is not a non-empty string.
export function extractToken(res) {
  let json;
  try {
    json = res.json();
  } catch (e) {
    return undefined;
  }
  if (!json || typeof json !== 'object') return undefined;

  for (const path of [config.tokenJsonPath, ...TOKEN_FALLBACK_PATHS]) {
    const value = getByPath(json, path);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

// Distinct token-step failure reasons, exposed so the request log and the
// summary report can say WHY the step failed instead of just the HTTP status.
export const TOKEN_FAILURE_REASONS = [
  'connection_error',
  'bad_status',
  'empty_body',
  'token_not_found',
];

export const TOKEN_FAILURE_MESSAGES = {
  connection_error: 'connection failed (could not reach token API)',
  bad_status: (status) => `token API returned http ${status}`,
  empty_body: 'token API returned an empty response body',
  token_not_found: (status, field) => `token not found in response (field "${field}")`,
};

// Perform the token request. Returns { res, token, request, failureReason }.
// token is undefined and failureReason is one of TOKEN_FAILURE_REASONS on any
// failure; both are absent on success. request = { url, logBody } for the log.
export function generateToken(user) {
  const req = buildTokenRequest(user);
  const res = http.post(req.url, req.body, req.params);

  let token;
  let failureReason;
  if (res.status === 0) {
    failureReason = 'connection_error';
  } else if (res.status < 200 || res.status >= 300) {
    failureReason = 'bad_status';
  } else if (!res.body || res.body.length === 0) {
    failureReason = 'empty_body';
  } else {
    token = extractToken(res);
    if (!token) failureReason = 'token_not_found';
  }

  return { res, token, request: { url: req.url, logBody: req.logBody }, failureReason };
}
