import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import JSZip from 'jszip';
import { Document, Packer, Paragraph } from 'docx';
import { createApp } from '../server/app.ts';
import { Store, id, now } from '../server/store.ts';
import { demoLesson } from '../server/engine.ts';
import { extractResource } from '../server/files.ts';
import { ROLES, qualityChecks, type TaskRun, type MemoryEntry } from '../shared/types.ts';
process.env.CTT_DEMO_DELAY = '5';
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ctt-test-')), store = new Store(dir), { app, engine } = await createApp(store);
  async function call(path: string, body?: any, method?: string, code = 200) {
    const r = await app.inject({ url: '/api' + path, method: (method || (body === undefined ? 'GET' : 'POST')) as any, ...(body === undefined ? {} : { payload: body }) });
    assert.equal(r.statusCode, code, r.body); return r.json();
  }
  const seeded = await call('/demo/seed', {});
  async function wait(taskId: string, wanted = 'completed'): Promise<TaskRun> {
    for (let i = 0; i < 300; i++) { const t = store.get<TaskRun>('tasks', taskId)!; if (t.status === wanted && !engine.active.has(taskId)) return t; if (t.status === 'failed' && wanted !== 'failed') throw new Error(t.error); await new Promise(r => setTimeout(r, 10)); }
    throw new Error('任务没有在测试期限内结束。');
  }
  async function lesson(extra = {}) {
    const t = await call('/tasks', { ...seeded, request: '向老师申请延期交作业', minutes: 45, lessonNumber: 1, mode: 'demo', memoryIds: [], segments: [], ...extra }); return wait(t.id);
  }
  async function cleanup() { await app.close(); while (engine.active.size) await new Promise(r => setTimeout(r, 5)); store.close(); rmSync(dir, { recursive: true, force: true }); }
  return { dir, store, app, engine, call, seeded, wait, lesson, cleanup };
}
test('两课闭环：六岗位、教师确认、记忆来源与跨班隔离', async () => {
  const f = await fixture(); try {
    const first = await f.lesson(); assert.equal(new Set(first.results.map(x => x.role)).size, 6); assert.equal(first.versions.length, 1); assert.deepEqual(qualityChecks(first.package!, 45), []);
    const record = await f.call('/records', { taskId: first.id, completed: '完成请求与确认任务', issues: '8 人撤去完整句型后仍需要关键词才能回应追问', teacherNotes: '下次增加临时追问', students: [{ code: 'S001', homework: '已完成', score: 80 }], gradesConfirmed: true });
    await f.wait(record.reflectionTaskId);
    const candidate = f.store.list<MemoryEntry>('memories')[0]; assert.equal(candidate.status, 'candidate'); assert.equal(candidate.sourceId, record.record.id);
    assert.equal((await f.call(`/memories/suggest?classId=${f.seeded.classId}&courseId=${f.seeded.courseId}&topic=追问&mode=demo`)).length, 0);
    await f.call('/memories/' + candidate.id, { content: candidate.content, status: 'confirmed' }, 'PUT');
    const second = await f.lesson({ lessonNumber: 2, memoryIds: [candidate.id], request: '继续练习独立回应追问' });
    assert.equal(second.context.memories[0].id, candidate.id); assert.ok(second.package!.exercises[0].support.includes('8 人'));
    const cls = await f.call('/classes', { name: '另一个班', size: 12, level: '初级', background: '成人', needs: '' });
    const course = await f.call('/courses', { classId: cls.id, name: '口语', goals: '', textbook: '', totalHours: 16, progress: '' });
    const suggestions = await f.call(`/memories/suggest?classId=${cls.id}&courseId=${course.id}&topic=追问&mode=demo`); assert.equal(suggestions.length, 0);
    await f.call('/tasks', { classId: cls.id, courseId: course.id, request: '请求', minutes: 45, lessonNumber: 1, mode: 'demo', memoryIds: [candidate.id] }, 'POST', 400);
    assert.equal((await f.call(`/memories/suggest?classId=${f.seeded.classId}&courseId=${f.seeded.courseId}&topic=追问&mode=real`)).length, 0);
    await f.call('/memories/' + candidate.id, { content: '教师修正：需要更少提示', status: 'confirmed' }, 'PUT');
    const corrected = f.store.get<MemoryEntry>('memories', candidate.id)!; assert.equal(corrected.history.length, 2); assert.equal(corrected.version, 3);
    await f.call('/memories/' + candidate.id, { content: corrected.content, status: 'archived' }, 'PUT');
    assert.equal((await f.call(`/memories/suggest?classId=${f.seeded.classId}&courseId=${f.seeded.courseId}&topic=追问&mode=demo`)).length, 0);
  } finally { await f.cleanup(); }
});
test('教师修改目标触发同步，保留旧版本；全部 Office 导出可解析且学生版不泄露答案', async () => {
  const f = await fixture(); try {
    const t = await f.lesson(), old = structuredClone(t.package!), p = structuredClone(old); p.goals = ['在校园窗口说明需求并确认信息。']; p.coreTask = '在校园窗口完成询问与确认';
    await f.call('/tasks/' + t.id + '/package', p, 'PUT'); const revised = await f.wait(t.id);
    assert.equal(revised.versions.length, 2); assert.deepEqual(revised.versions[0].package, old); assert.equal(revised.package!.checks.length, 1); assert.equal(revised.package!.checks[0].goalIndex, 0); assert.ok(revised.package!.slides.some(s => s.bullets.includes(p.coreTask)));
    await f.call('/tasks/' + t.id + '/adopt', { version: 1 }); assert.equal(f.store.get<TaskRun>('tasks', t.id)!.adoptedVersion, 1);
    for (const format of ['docx', 'worksheet', 'pptx', 'teacher-pptx', 'xlsx']) {
      const response = await f.app.inject('/api/tasks/' + t.id + '/export/' + format + '?version=2'); assert.equal(response.statusCode, 200);
      const zip = await JSZip.loadAsync(response.rawPayload); assert.ok(Object.keys(zip.files).length > 5);
      if (format === 'docx') { const xml = await zip.file('word/document.xml')!.async('string'); assert.ok(xml.includes(p.goals[0])); }
      if (format === 'worksheet') { const xml = await zip.file('word/document.xml')!.async('string'); assert.ok(!xml.includes(revised.package!.checks[0].answer)); }
      if (format === 'pptx') { assert.ok(!Object.keys(zip.files).some(x => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(x))); }
    }
  } finally { await f.cleanup(); }
});
test('教材输入保留段落和片段选择；非支持文件不伪装成功', async () => {
  const f = await fixture(); try {
    const r = await f.call('/resources/text', { ...f.seeded, name: '校园请求', text: '第一段：提出请求。\n\n第二段：确认回应。' });
    assert.equal(r.segments.length, 2); assert.equal(r.segments[1].location, '段落 2');
    const t = await f.lesson({ segments: [{ resourceId: r.id, segmentId: r.segments[1].id }] }); assert.equal(t.context.resources[0].segments.length, 1);
    const doc = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('成人中文教材'), new Paragraph('第二段请求表达')] }] }));
    const boundary = 'testBoundary', payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="material.docx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`), doc, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const upload = await f.app.inject({ method: 'POST', url: `/api/resources/upload?classId=${f.seeded.classId}&courseId=${f.seeded.courseId}`, headers: { 'content-type': 'multipart/form-data; boundary=' + boundary }, payload });
    assert.equal(upload.statusCode, 200, upload.body); assert.equal(upload.json().segments[1].text, '第二段请求表达');
    const backup = await f.call('/backup'); assert.equal(backup.files.length, 2);
  } finally { await f.cleanup(); }
});
test('暂停与重启保留已完成检查点，不自动重跑；取消可以继续', async () => {
  const f = await fixture(); try {
    process.env.CTT_DEMO_DELAY = '40';
    const t = await f.call('/tasks', { ...f.seeded, request: '请求与确认', minutes: 45, lessonNumber: 1, mode: 'demo' });
    while (f.store.get<TaskRun>('tasks', t.id)!.results.length < 2) await new Promise(r => setTimeout(r, 10));
    await f.call('/tasks/' + t.id + '/control/pause', {}); await f.wait(t.id, 'paused');
    const paused = f.store.get<TaskRun>('tasks', t.id)!; const ids = paused.results.map(x => x.id);
    await f.call('/tasks/' + t.id + '/control/resume', {}); const done = await f.wait(t.id); assert.deepEqual(done.results.slice(0, ids.length).map(x => x.id), ids);
    const t2 = await f.call('/tasks', { ...f.seeded, request: '请求', minutes: 45, lessonNumber: 2, mode: 'demo' });
    await f.call('/tasks/' + t2.id + '/control/cancel', {}); await f.wait(t2.id, 'cancelled');
    await f.call('/tasks/' + t2.id + '/control/resume', {}); await f.wait(t2.id);
    f.store.put('tasks', { ...done, id: 'restart-probe', status: 'running', stageIndex: 3 });
    const another = new Store(f.dir); assert.equal(another.get<TaskRun>('tasks', 'restart-probe')!.status, 'paused'); another.close();
  } finally { process.env.CTT_DEMO_DELAY = '5'; await f.cleanup(); }
});
test('三种模型适配、六岗位分配、配置快照、错误与格式修复', async () => {
  const f = await fixture(), calls: any[] = [];
  const mock = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/api/tags' ? { models: [{ name: 'mock-local' }] } : { data: [{ id: 'mock-cloud' }] })); return; }
    calls.push({ path: req.url, body, headers: req.headers }); res.setHeader('content-type', 'application/json');
    if (body.model === 'unauthorized') { res.statusCode = 401; res.end('{}'); return; }
    const input = body.messages[body.messages.length - 1].content; const context = input.startsWith('{') ? JSON.parse(input.split('\n上次输出')[0]) : {};
    const template = demoLesson({ ...context, request: context.teacherRequest || '请求', minutes: context.minutes || 45, context: context.context || { memories: [] } } as TaskRun);
    const role = String(body.system || body.messages[0]?.content).match(/团队的(.+?)智能体/)?.[1];
    const content = body.model === 'invalid' ? 'not-json' : JSON.stringify({ summary: `${role}真实模拟结果`, findings: ['依据输入完成'], concerns: [], ...(['课程设计', '中文教学支持', '评价分析', '材料制作'].includes(role!) ? { lesson: context.previousLesson || template } : {}) });
    res.end(JSON.stringify(req.url === '/v1/messages' ? { content: [{ type: 'text', text: content }] } : req.url === '/api/chat' ? { message: { content } } : { choices: [{ message: { content } }] }));
  });
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve)); const port = (mock.address() as any).port;
  try {
    const providers: any[] = [];
    for (const type of ['openai', 'anthropic', 'ollama']) providers.push(await f.call('/providers', { name: type, type, baseUrl: `http://127.0.0.1:${port}${type === 'openai' ? '/v1' : ''}`, model: 'mock', apiKey: 'test-secret-' + type, ...(type === 'openai' ? { tokenParameter: 'max_completion_tokens', supportsTemperature: false } : {}) }));
    assert.ok(providers.every(x => !x.secret && !x.apiKey && x.hasKey));
    const settings = f.store.settings(); settings.agents = settings.agents.map((a, i) => ({ ...a, providerId: providers[i % 3].id, model: 'role-' + a.role, temperature: 0.4 }));
    await f.call('/settings', { agents: settings.agents, preferences: '成人中文任务' }, 'PUT');
    const started = await f.call('/tasks', { ...f.seeded, request: '校园请求', minutes: 45, lessonNumber: 1, mode: 'real' });
    await f.call('/settings', { agents: settings.agents.map(a => ({ ...a, model: 'changed-model' })), preferences: '新设置' }, 'PUT');
    const real = await f.wait(started.id); assert.ok(real.results.every(x => x.mode === 'real' && x.model.startsWith('role-'))); assert.equal(new Set(real.results.map(x => x.provider)).size, 3);
    assert.ok(calls.some(x => x.path === '/v1/messages' && x.headers['x-api-key'] === 'test-secret-anthropic')); assert.ok(calls.some(x => x.path === '/api/chat')); assert.ok(calls.some(x => x.path === '/v1/chat/completions' && x.body.max_completion_tokens === 6000 && !('temperature' in x.body) && !('max_tokens' in x.body)));
    assert.equal((await f.call('/providers/' + providers[0].id + '/test', { model: 'mock' })).ok, true);
    for (const p of providers) assert.equal((await f.call('/providers/' + p.id + '/models')).models.length, 1);
    const backup = await f.call('/backup'); assert.ok(!JSON.stringify(backup).includes('test-secret')); assert.ok(!JSON.stringify(backup).includes('secret"')); assert.ok(!JSON.stringify(await f.call('/tasks')).includes('secret"'));
    settings.agents.forEach(a => a.model = 'unauthorized'); await f.call('/settings', { agents: settings.agents, preferences: '' }, 'PUT');
    const bad = await f.call('/tasks', { ...f.seeded, request: '请求', minutes: 45, lessonNumber: 2, mode: 'real' }); const failed = await f.wait(bad.id, 'failed'); assert.ok(failed.error?.includes('认证')); assert.equal(failed.results.length, 0); assert.equal(failed.mode, 'real');
    settings.agents.forEach(a => a.model = 'invalid'); await f.call('/settings', { agents: settings.agents, preferences: '' }, 'PUT');
    const count = calls.length, invalid = await f.call('/tasks', { ...f.seeded, request: '请求', minutes: 45, lessonNumber: 3, mode: 'real' }); await f.wait(invalid.id, 'failed'); assert.equal(calls.length - count, 2);
    await f.call('/restore', backup); assert.equal(f.store.list<any>('providers').filter(p => p.secret).length, 0); assert.equal(f.store.list('classes').length, 1);
  } finally { await new Promise<void>(resolve => mock.close(() => resolve())); await f.cleanup(); }
});
test('业务校验：非法成绩、跨课程资源、外站请求与错误备份均被拒绝', async () => {
  const f = await fixture(); try {
    const t = await f.lesson();
    await f.call('/records', { taskId: t.id, completed: '完成', issues: '', teacherNotes: '', students: [{ code: '张三', homework: '完成', score: 110 }], gradesConfirmed: false }, 'POST', 400);
    await f.call('/restore', { format: 'wrong', version: 1, entities: [] }, 'POST', 400); assert.equal(f.store.list('classes').length, 1);
    await f.call('/restore', { format: 'ChineseTeachingTeam', version: 1, entities: [] }, 'POST', 400); assert.equal(f.store.list('classes').length, 1);
    const r = await f.app.inject({ url: '/api/settings', headers: { origin: 'https://other.example' } }); assert.equal(r.statusCode, 403);
    const p = await f.call('/providers', { name: '配置', type: 'openai', baseUrl: 'http://localhost/v1', model: '', apiKey: 'do-not-expose' }); assert.ok(!JSON.stringify(p).includes('do-not-expose'));
    const old = f.store.get<any>('providers', p.id)!.secret; await f.call('/providers/' + p.id, { name: '配置', type: 'openai', baseUrl: 'http://localhost/v1', model: '', apiKey: '' }, 'PUT'); assert.equal(f.store.get<any>('providers', p.id)!.secret, old);
  } finally { await f.cleanup(); }
});
function samplePdf(text = '') {
  const stream = text ? `BT /F1 16 Tf 50 700 Td (${text}) Tj ET` : '10 10 50 50 re S';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let value = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(value)); value += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(value); value += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(x => String(x).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(value);
}
test('文本 PDF 保留页码；图像式 PDF 与不支持的文件明确失败', async () => {
  const f = await fixture(); try {
    const resource = await extractResource('lesson.pdf', samplePdf('Adult request lesson'), f.seeded.classId, f.seeded.courseId, f.store);
    assert.equal(resource.segments[0].location, '第 1 页'); assert.ok(resource.segments[0].text.includes('Adult request lesson'));
    await assert.rejects(extractResource('scan.pdf', samplePdf(), f.seeded.classId, f.seeded.courseId, f.store), /扫描件/);
    await assert.rejects(extractResource('wrong.png', Buffer.from('abc'), f.seeded.classId, f.seeded.courseId, f.store), /请上传/);
  } finally { await f.cleanup(); }
});
test('真实模型超时、限流与取消不产生演示成果；已有结果保持完整', async () => {
  const f = await fixture();
  const mock = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    if (body.model === 'rate-limit') { res.writeHead(429); res.end('{}'); return; }
    const timer = setTimeout(() => { res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] })); }, 10000);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>(r => mock.listen(0, '127.0.0.1', r)); const port = (mock.address() as any).port;
  try {
    const p = await f.call('/providers', { name: '慢接口', type: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'slow' });
    const agents = f.store.settings().agents.map(a => ({ ...a, providerId: p.id, model: 'slow', timeoutSeconds: 5 }));
    await f.call('/settings', { agents, preferences: '' }, 'PUT');
    const t = await f.call('/tasks', { ...f.seeded, request: '请求', minutes: 45, lessonNumber: 1, mode: 'real' });
    const timeout = await f.wait(t.id, 'failed').catch(async () => { await new Promise(r => setTimeout(r, 2300)); return f.wait(t.id, 'failed'); });
    assert.ok(timeout.error?.includes('超时')); assert.equal(timeout.results.length, 0); assert.equal(timeout.mode, 'real');
    agents.forEach(a => a.model = 'rate-limit'); await f.call('/settings', { agents, preferences: '' }, 'PUT');
    const rate = await f.call('/tasks', { ...f.seeded, request: '请求', minutes: 45, lessonNumber: 2, mode: 'real' }); assert.ok((await f.wait(rate.id, 'failed')).error?.includes('限流'));
    agents.forEach(a => a.model = 'slow'); await f.call('/settings', { agents, preferences: '' }, 'PUT');
    const cancel = await f.call('/tasks', { ...f.seeded, request: '请求', minutes: 45, lessonNumber: 3, mode: 'real' }); await f.call('/tasks/' + cancel.id + '/control/cancel', {}); const cancelled = await f.wait(cancel.id, 'cancelled'); assert.equal(cancelled.results.length, 0);
  } finally { await new Promise<void>(r => mock.close(() => r())); await f.cleanup(); }
});
