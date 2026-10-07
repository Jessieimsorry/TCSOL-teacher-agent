import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const url = 'http://127.0.0.1:8790';
function openBrowser() {
  const args = process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(args[0], args[1], { stdio: 'ignore', windowsHide: true }); child.on('error', () => console.log(`Open in your browser: ${url}`)); child.unref();
}
async function healthy() {
  try { const r = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1500) }); const data = await r.json(); return r.ok && data.app === 'ChineseTeachingTeam'; } catch { return false; }
}
if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Please install Node.js 24 or newer: https://nodejs.org/'); process.exit(1); }
if (await healthy()) { openBrowser(); process.exit(0); }
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function command(args) {
  // Only fixed npm subcommands are used; no teacher input is interpolated into a shell.
  const result = spawnSync(npm, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error || result.status !== 0) { console.error(result.error?.message || 'Setup failed. Check the message above.'); process.exit(1); }
}
if (!existsSync('node_modules')) command(['ci']);
command(['run', 'build']);
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, stdio: 'inherit', windowsHide: false });
server.on('error', e => { console.error(e.message); process.exitCode = 1; });
server.on('exit', code => { process.exitCode = code || 0; });
let opened = false;
const timer = setInterval(async () => {
  if (!opened && await healthy()) { opened = true; clearInterval(timer); openBrowser(); }
  if (server.exitCode !== null) clearInterval(timer);
}, 700);
process.on('SIGINT', () => { server.kill('SIGINT'); });
