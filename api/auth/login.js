// POST { password } -> signs this browser in for 400 days.
import { json, readJson, checkEnv, passwordMatches, startSession } from '../../lib/session.js';

export default async function handler(req, res) {
  if (!checkEnv(res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  let body;
  try { body = await readJson(req); } catch { return json(res, 400, { error: 'bad_json' }); }
  if (!passwordMatches(body.password)) {
    await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
    return json(res, 401, { error: 'wrong_password' });
  }
  startSession(res, req);
  json(res, 200, { ok: true });
}
