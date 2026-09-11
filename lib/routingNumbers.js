// lib/routingNumbers.js
// -----------------------------------------------------------------------------
// Routing-number pool loaded from a CSV file (ROUTING_NUMBERS_FILE).
//
// The file is read with k6's open() in load-test.js (init context only), then
// the raw text is handed to parseRoutingPool() here. Each cycle calls
// pickRoutingNumber() to choose one:
//   random     (default) - uniform random pick per cycle
//   sequential           - walk the list in order, wrapping around (per VU)
//   per-user             - ignore the file, use USER<n>_ROUTING_NUMBER
// -----------------------------------------------------------------------------

// Parse "ID,Routing Number" style CSV (header optional). Keeps the last
// all-digits field on each line, which skips the header and any ID column.
export function parseRoutingPool(text) {
  if (!text) return [];
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const last = trimmed.split(',').pop().trim();
    if (/^\d{6,}$/.test(last)) out.push(last);
  }
  return out;
}

let seqIdx = 0; // module scope = per VU

export function pickRoutingNumber(pool, strategy, user) {
  if (strategy === 'per-user' || !pool || pool.length === 0) {
    return user.routingNumber;
  }
  if (strategy === 'sequential') {
    const rn = pool[seqIdx % pool.length];
    seqIdx += 1;
    return rn;
  }
  // random
  return pool[Math.floor(Math.random() * pool.length)];
}
