import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
export function stateDir() {
  const d = process.env.DPW_STATE_DIR || path.join(os.homedir(), '.decision-playwright');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
