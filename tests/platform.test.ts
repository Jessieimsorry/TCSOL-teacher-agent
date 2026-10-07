import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDataDir } from '../server/platform.ts';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
test('Windows 使用 LOCALAPPDATA，支持中文与空格路径', () => {
  assert.equal(defaultDataDir('win32', { LOCALAPPDATA: 'C:\\Users\\教师 用户\\AppData\\Local' }, 'C:\\Users\\教师 用户'), 'C:\\Users\\教师 用户\\AppData\\Local\\ChineseTeachingTeam');
  assert.equal(defaultDataDir('win32', {}, 'C:\\Users\\teacher'), 'C:\\Users\\teacher\\AppData\\Local\\ChineseTeachingTeam');
});
test('跨平台启动与授权停止：保存运行中的检查点，清除会话凭据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctt-platform-教师 '));
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as any).port; await new Promise<void>(r => probe.close(() => r()));
  const env = { ...process.env, PORT: String(port), CTT_DATA_DIR: dir, CTT_DEMO_DELAY: '1000' };
  const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env, stdio: 'pipe' });
  let output = ''; server.stdout.on('data', c => output += c); server.stderr.on('data', c => output += c);
  const exited = new Promise<void>(r => server.once('exit', () => r()));
  const url = `http://127.0.0.1:${port}`;
  async function request(path: string, data?: any) {
    const response = await fetch(url + '/api' + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  }
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) { try { await request('/health'); ready = true; break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, output);
    const unauthorized = await fetch(url + '/api/shutdown', { method: 'POST' }); assert.equal(unauthorized.status, 403);
    const scope = await request('/demo/seed', {});
    const task = await request('/tasks', { ...scope, request: '请求与确认', minutes: 45, lessonNumber: 1, mode: 'demo' });
    const stop = spawn(process.execPath, ['scripts/stop.mjs'], { env, stdio: 'pipe' });
    const code = await new Promise<number | null>(r => stop.once('exit', r)); assert.equal(code, 0);
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('停止超时')), 10000).unref())]);
    assert.ok(!existsSync(join(dir, 'server-control.json')));
    const store = new Store(dir); assert.equal(store.get<any>('tasks', task.id).status, 'paused'); store.close();
  } finally { if (server.exitCode === null) { server.kill(); await exited; } rmSync(dir, { recursive: true, force: true }); }
});
test('保留 Mac 原路径，Linux 使用 XDG；显式目录优先', () => {
  assert.equal(defaultDataDir('darwin', {}, '/Users/teacher'), '/Users/teacher/Library/Application Support/ChineseTeachingTeam');
  assert.equal(defaultDataDir('linux', { XDG_DATA_HOME: '/tmp/app-data' }, '/home/teacher'), '/tmp/app-data/ChineseTeachingTeam');
  assert.equal(defaultDataDir('win32', { CTT_DATA_DIR: 'D:\\课程数据' }), 'D:\\课程数据');
});
