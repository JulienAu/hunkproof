// Usage aggregation and list-price cost estimate for `usage` events.
//
// Transcript facts this module relies on (checked against real lines):
// - every content block of one API response is written as its own
//   `assistant` line carrying the same message.id + requestId, with the usage
//   object repeated (output_tokens grows block after block), so one API call
//   appears up to several times and the LAST/largest values are the real ones;
// - `<synthetic>` assistant lines have no requestId: fall back to uuid;
// - model ids can carry a date suffix (claude-haiku-4-5-20251001).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PRICES = JSON.parse(readFileSync(path.join(here, 'prices.json'), 'utf8'));

// Attached to every dollar figure. It says what the number is (a list-price
// computation) without asserting the reader's billing plan.
export const COST_LABEL = 'what these tokens would cost at Anthropic API list prices; not a bill (subscription plans have no per-token charge)';

const FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Resolve the price row for a model id: exact key first, then the longest
 * key that is a '-' delimited prefix of the id. Returns null when unknown.
 */
export function priceFor(model) {
  if (typeof model !== 'string' || !model) return null;
  const table = PRICES.models;
  if (Object.prototype.hasOwnProperty.call(table, model)) return table[model];
  let best = null;
  for (const key of Object.keys(table)) {
    if (key === 'unknown') continue;
    if (model.startsWith(key + '-') && (best === null || key.length > best.length)) best = key;
  }
  return best === null ? null : table[best];
}

/** USD list price of one usage bucket, or null when the model is unpriced. */
export function costOf(model, usage) {
  const p = priceFor(model);
  if (!p) return null;
  const write5m = num(usage.cacheWrite) - num(usage.cacheWrite1h);
  const perM =
    num(usage.input) * p.input +
    num(usage.output) * p.output +
    Math.max(0, write5m) * p.cacheWrite +
    num(usage.cacheWrite1h) * p.input * 2 +
    num(usage.cacheRead) * p.cacheRead;
  return perM / 1_000_000;
}

function dedupeKey(ev) {
  const m = ev.messageId ?? null;
  const r = ev.requestId ?? null;
  if (m !== null || r !== null) return `id:${m ?? ''}|${r ?? ''}`;
  if (ev.uuid) return `uuid:${ev.uuid}`;
  return null; // no identity at all: counted as its own call
}

/**
 * summarizeUsage(events) => { byModel, totals, costListUSD, priceListDate,
 *                             costByModel, unpricedModels }
 * Dedupes by `${messageId}|${requestId}` (fallback uuid) keeping, per key, the
 * maximum of each token field (the repeated lines are cumulative snapshots).
 */
export function summarizeUsage(events) {
  const calls = new Map();
  let anon = 0;
  for (const ev of events ?? []) {
    if (!ev || ev.type !== 'usage' || !ev.usage) continue;
    const key = dedupeKey(ev) ?? `anon:${anon++}`;
    const model = ev.usage.model || 'unknown';
    let call = calls.get(key);
    if (!call) {
      call = { model, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cacheWrite1h: 0 };
      calls.set(key, call);
    }
    if (call.model === 'unknown' && model !== 'unknown') call.model = model;
    for (const f of FIELDS) call[f] = Math.max(call[f], num(ev.usage[f]));
    call.cacheWrite1h = Math.max(call.cacheWrite1h, num(ev.usage.cacheWrite1h));
  }

  const byModel = {};
  const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 };
  for (const call of calls.values()) {
    const row = (byModel[call.model] ??= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 });
    for (const f of FIELDS) {
      row[f] += call[f];
      totals[f] += call[f];
    }
    if (call.cacheWrite1h) row.cacheWrite1h = (row.cacheWrite1h ?? 0) + call.cacheWrite1h;
    row.messages += 1;
    totals.messages += 1;
  }

  const costByModel = {};
  const unpricedModels = [];
  let costListUSD = 0;
  for (const model of Object.keys(byModel).sort()) {
    const c = costOf(model, byModel[model]);
    costByModel[model] = c;
    if (c === null) unpricedModels.push(model);
    else costListUSD += c;
  }

  return {
    byModel,
    totals,
    costListUSD: Math.round(costListUSD * 1e6) / 1e6,
    priceListDate: PRICES.priceListDate,
    costByModel,
    unpricedModels,
  };
}
