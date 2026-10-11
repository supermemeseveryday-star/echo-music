// Whether this browser is signed in. 401 when not.
import { requireUser, json, checkEnv } from '../lib/session.js';
import { r2Configured } from '../lib/r2.js';

export default function handler(req, res) {
  if (!checkEnv(res)) return;
  if (!requireUser(req, res)) return;
  json(res, 200, { r2: r2Configured(), blob: !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) });
}
