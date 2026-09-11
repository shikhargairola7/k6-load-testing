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

// Perform the token request. Returns { res, token, request } where token is
// undefined on any failure and request = { url, logBody } for the request log.
export function generateToken(user) {
  const req = buildTokenRequest(user);
  const res = http.post(req.url, req.body, req.params);
  const token = res.status >= 200 && res.status < 300 ? extractToken(res) : undefined;
  return { res, token, request: { url: req.url, logBody: req.logBody } };
}
