import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const dir = process.env.CTT_DATA_DIR || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ChineseTeachingTeam') : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'ChineseTeachingTeam') : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'ChineseTeachingTeam'));
try {
  const control = JSON.parse(readFileSync(join(dir, 'server-control.json'), 'utf8'));
  const url = `http://127.0.0.1:${control.port}`;
  const health = await fetch(url + '/api/health', { signal: AbortSignal.timeout(3000) }).then(r => r.json());
  if (health.app !== 'ChineseTeachingTeam' || health.pid !== control.pid) throw new Error('The saved process is not this workbench.');
  const response = await fetch(url + '/api/shutdown', { method: 'POST', headers: { Authorization: 'Bearer ' + control.token }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('The server refused the stop request.');
  console.log('Workbench stopped. Courses and task checkpoints have been saved.');
} catch (e) {
  if (e.code === 'ENOENT') console.log('Workbench is not running.');
  else { console.error('Could not stop workbench: ' + e.message); process.exitCode = 1; }
}
