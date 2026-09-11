// lib/query.js
// -----------------------------------------------------------------------------
// API 2 - routing-number query.
//
//   POST {baseUrl}{queryPath}
//   Content-Type: application/json
//   Authorization: Bearer <token from API 1, this cycle>
//   body: { routing_number }   <- chosen per cycle (see lib/routingNumbers.js)
// -----------------------------------------------------------------------------

import http from 'k6/http';
import { config } from '../config.js';

export function routingNumberQuery(token, routingNumber) {
  const url = `${config.baseUrl}${config.queryPath}`;
  const body = JSON.stringify({ routing_number: routingNumber });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    timeout: config.httpTimeout,
    tags: { api: 'query' },
  };

  return http.post(url, body, params);
}
