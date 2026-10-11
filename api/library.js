// The songs in the R2 bucket (everything under music/).
import { requireUser, json } from '../lib/session.js';
import { r2Configured, listObjects, MUSIC_PREFIX, AUDIO } from '../lib/r2.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
  if (!requireUser(req, res)) return;
  if (!r2Configured()) return json(res, 500, { error: 'r2_not_configured' });
  try {
    const items = (await listObjects(MUSIC_PREFIX)).filter((o) => AUDIO.test(o.key));
    json(res, 200, { items });
  } catch (e) {
    console.error('r2 list failed', e);
    json(res, 502, { error: 'r2_failed', detail: String(e.message || e).slice(0, 200) });
  }
}
