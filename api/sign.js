// Signed R2 links for the browser.
//   { get: [key, ...] }  -> { urls: { key: url } }   read songs / the state file (12 hours)
//   { put: key }         -> { url }                   upload a song / save the state file (15 minutes)
import { requireUser, json, readJson } from '../lib/session.js';
import { r2Configured, presign, validKey } from '../lib/r2.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (!requireUser(req, res)) return;
  if (!r2Configured()) return json(res, 500, { error: 'r2_not_configured' });
  let body;
  try { body = await readJson(req); } catch { return json(res, 400, { error: 'bad_json' }); }
  if (Array.isArray(body.get)) {
    if (body.get.length > 500 || !body.get.every((k) => validKey(k))) return json(res, 400, { error: 'invalid_key' });
    const urls = {};
    for (const k of body.get) urls[k] = await presign('GET', k, 12 * 3600);
    return json(res, 200, { urls, ttl: 12 * 3600 });
  }
  if (typeof body.put === 'string') {
    if (!validKey(body.put, { write: true })) return json(res, 400, { error: 'invalid_key' });
    return json(res, 200, { url: await presign('PUT', body.put, 900) });
  }
  json(res, 400, { error: 'nothing_to_sign' });
}
