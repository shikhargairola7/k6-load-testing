// lib/metrics.js
// -----------------------------------------------------------------------------
// Custom metrics. k6 already gives us http_req_duration etc.; these add the
// cycle-level view the test is really about.
//
//  Trend  = distribution (min/avg/percentiles/max) -> used for latencies
//  Counter = monotonic total -> used for cycle / error counts
//  Rate    = ratio of true observations -> used for the overall error rate
//
// The `true` second arg on the Trends marks the values as durations (ms) so k6
// formats them as time.
// -----------------------------------------------------------------------------

import { Trend, Counter, Rate } from 'k6/metrics';

export const tokenLatency = new Trend('token_latency', true); // API 1 server round-trip
export const queryLatency = new Trend('query_latency', true); // API 2 server round-trip
export const cycleLatency = new Trend('cycle_latency', true); // token start -> query response (incl. client work)

export const cyclesTotal = new Counter('cycles_total');
export const cyclesSucceeded = new Counter('cycles_succeeded');
export const cyclesFailed = new Counter('cycles_failed');

export const tokenErrors = new Counter('token_errors');
export const queryErrors = new Counter('query_errors');

// Tagged {api, status} so handleSummary can print a status-code distribution.
export const httpStatus = new Counter('http_status');

// true = the cycle failed. Drives the overall error-rate threshold.
export const cycleErrorRate = new Rate('cycle_error_rate');
