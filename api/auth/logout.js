import { endSession, json } from '../../lib/session.js';

export default function handler(req, res) {
  endSession(res, req);
  json(res, 200, { ok: true });
}
