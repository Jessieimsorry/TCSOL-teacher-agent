import { createApp } from './app.ts';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
const port = Number(process.env.PORT || 8790);
// Check the port before opening the database, so a duplicate launch cannot alter a running task's checkpoints.
const probe = createServer();
try {
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise<void>((resolve, reject) => probe.close(e => e ? reject(e) : resolve()));
} catch { console.error(`${port} 端口已被占用。请打开现有工作台，或停止占用该端口的程序。`); process.exit(1); }
const { app, store, engine } = await createApp();
const pidFile = join(store.dir, 'server.pid');
const controlFile = join(store.dir, 'server-control.json');
const token = randomBytes(32).toString('hex');
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  await app.close();
  for (let n = 0; n < 100 && engine.active.size; n++) await new Promise(r => setTimeout(r, 20));
  store.close();
  for (const file of [pidFile, controlFile]) if (existsSync(file)) unlinkSync(file);
  process.exit(0);
}
app.post('/api/shutdown', async (req, reply) => {
  const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return reply.code(403).send({ error: '停止请求未经本机授权。' });
  setTimeout(() => { void shutdown(); }, 100); return { ok: true };
});
try { await app.listen({ port, host: '127.0.0.1' }); writeFileSync(pidFile, String(process.pid), { mode: 0o600 }); writeFileSync(controlFile, JSON.stringify({ pid: process.pid, port, token }), { mode: 0o600 }); console.log('一人教学团队已启动：http://127.0.0.1:' + port); }
catch (e: any) { console.error(e.code === 'EADDRINUSE' ? '8790 端口已被占用。请先打开现有工作台，或停止占用该端口的程序。' : '启动失败：' + e.message); store.close(); process.exit(1); }
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void shutdown(); });
