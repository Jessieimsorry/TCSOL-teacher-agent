import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { ROLES, LessonSchema, type TaskRun, type Provider, type ClassProfile, type Course, type Resource, type MemoryEntry, type LessonRecord, type Settings } from '../shared/types.ts';
import { Store, id, now, stripSecrets } from './store.ts';
import { Engine, LESSON_STAGES } from './engine.ts';
import { generate, listModels } from './models.ts';
import { extractResource, exportFile } from './files.ts';
const ProviderInput = z.object({ name: z.string().min(1).max(100), type: z.enum(['openai', 'anthropic', 'ollama']), baseUrl: z.string().url(), model: z.string().default(''), tokenParameter: z.enum(['max_tokens', 'max_completion_tokens', 'none']).default('max_tokens'), supportsTemperature: z.boolean().default(true), apiKey: z.string().optional(), clearKey: z.boolean().optional() });
const AgentInput = z.object({ role: z.enum(ROLES), providerId: z.string(), model: z.string(), maxTokens: z.number().int().min(100).max(64000), timeoutSeconds: z.number().int().min(5).max(1800), temperature: z.number().min(0).max(2).optional() });
const ClassInput = z.object({ name: z.string().min(1).max(150), background: z.string(), level: z.string(), size: z.number().int().min(1).max(1000), needs: z.string() });
const CourseInput = z.object({ classId: z.string(), name: z.string().min(1).max(150), goals: z.string(), textbook: z.string(), totalHours: z.number().nonnegative(), progress: z.string() });
const TaskInput = z.object({ classId: z.string(), courseId: z.string(), lessonNumber: z.number().int().min(1), minutes: z.number().int().min(10).max(240), request: z.string().min(1).max(12000), mode: z.enum(['demo', 'real']), memoryIds: z.array(z.string()).default([]), segments: z.array(z.object({ resourceId: z.string(), segmentId: z.string() })).default([]) });
const RecordInput = z.object({ taskId: z.string(), completed: z.string().min(1), issues: z.string(), teacherNotes: z.string(), students: z.array(z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{1,30}$/, '请使用匿名编号，如 S001。'), homework: z.string(), score: z.number().min(0).max(100).nullable() })).max(1000), gradesConfirmed: z.boolean().default(false) });
export async function createApp(store = new Store()) {
  const app = Fastify({ logger: false, forceCloseConnections: true, bodyLimit: 100 * 1024 * 1024 }), engine = new Engine(store);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !['http://127.0.0.1:8790', 'http://localhost:8790', 'http://127.0.0.1:8791', 'http://localhost:8791'].includes(origin)) return reply.code(403).send({ error: '仅支持从本地工作台访问。' });
    reply.header('X-Content-Type-Options', 'nosniff');
  });
  app.setErrorHandler((e, _req, reply) => {
    const error = e as Error & { statusCode?: number };
    reply.code(error.statusCode || (e instanceof z.ZodError ? 400 : 400)).send({ error: e instanceof z.ZodError ? e.issues.map(x => `${x.path.join('.')}：${x.message}`).join('；') : error.message || '操作失败。' });
  });
  const requireEntity = <T,>(kind: string, eid: string): T => { const v = store.get<T>(kind, eid); if (!v) throw new Error('找不到记录。'); return v; };
  const publicProvider = (p: Provider) => ({ ...stripSecrets(p), hasKey: !!p.secret, keyMask: p.secret ? '••••••••' : '' });
  const taskResponse = (t: TaskRun) => engine.publicTask(t);
  function validateScope(classId: string, courseId: string) {
    const cls = requireEntity<ClassProfile>('classes', classId), course = requireEntity<Course>('courses', courseId);
    if (course.classId !== classId) throw new Error('课程不属于所选班级。'); return { cls, course };
  }
  function snapshotProviders(mode: 'demo' | 'real', config: Settings) {
    const providers = store.list<Provider>('providers');
    if (mode === 'real') for (const role of ROLES) {
      const c = config.agents.find(x => x.role === role), p = providers.find(p => p.id === c?.providerId);
      if (!c || !p || !c.model.trim()) throw new Error('请先为六个岗位配置模型，或选择演示模式。');
    }
    return providers;
  }
  const newTask = (base: Partial<TaskRun>): TaskRun => ({ id: id(), classId: '', courseId: '', lessonNumber: 1, minutes: 45, request: '', mode: 'demo', kind: 'lesson', status: 'queued', stageIndex: 0, stages: structuredClone(LESSON_STAGES), results: [], events: [], config: structuredClone(store.settings()), providers: [], context: {} as TaskRun['context'], versions: [], createdAt: now(), updatedAt: now(), ...base });
  app.get('/api/health', async () => ({ ok: true, app: 'ChineseTeachingTeam', version: '0.1.0', pid: process.pid, dataDir: store.dir, activeTasks: engine.active.size }));
  app.get('/api/settings', async () => ({ ...store.settings(), providers: store.list<Provider>('providers').map(publicProvider) }));
  app.put('/api/settings', async req => {
    const body = z.object({ preferences: z.string().max(12000), agents: z.array(AgentInput).length(6) }).parse(req.body);
    if (new Set(body.agents.map(x => x.role)).size !== 6) throw new Error('需要六个不同岗位。');
    for (const agent of body.agents) if (agent.providerId) requireEntity('providers', agent.providerId);
    return store.put('settings', { id: 'main', ...body, version: store.settings().version + 1 });
  });
  app.post('/api/providers', async req => {
    const b = ProviderInput.parse(req.body); if (!['http:', 'https:'].includes(new URL(b.baseUrl).protocol)) throw new Error('模型地址仅支持 HTTP 或 HTTPS。');
    const p: Provider = { id: id(), name: b.name, type: b.type, baseUrl: b.baseUrl, model: b.model, tokenParameter: b.tokenParameter, supportsTemperature: b.supportsTemperature, ...(b.apiKey ? { secret: store.encrypt(b.apiKey) } : {}) };
    store.put('providers', p); return publicProvider(p);
  });
  app.put<{ Params: { id: string } }>('/api/providers/:id', async req => {
    const old = requireEntity<Provider>('providers', req.params.id), b = ProviderInput.parse(req.body);
    if (!['http:', 'https:'].includes(new URL(b.baseUrl).protocol)) throw new Error('模型地址仅支持 HTTP 或 HTTPS。');
    const p = { ...old, name: b.name, type: b.type, baseUrl: b.baseUrl, model: b.model, tokenParameter: b.tokenParameter, supportsTemperature: b.supportsTemperature, secret: b.clearKey ? undefined : b.apiKey ? store.encrypt(b.apiKey) : old.secret };
    store.put('providers', p); return publicProvider(p);
  });
  app.delete<{ Params: { id: string } }>('/api/providers/:id', async req => {
    if (store.settings().agents.some(x => x.providerId === req.params.id)) throw new Error('该连接正在岗位配置中使用，请先调整模型分配。');
    store.delete('providers', req.params.id); return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/providers/:id/models', async req => ({ models: await listModels(store, requireEntity<Provider>('providers', req.params.id)) }));
  app.post<{ Params: { id: string } }>('/api/providers/:id/test', async req => {
    const p = requireEntity<Provider>('providers', req.params.id), { model } = z.object({ model: z.string().min(1) }).parse(req.body);
    await generate(store, p, { role: 'coordinator', providerId: p.id, model, maxTokens: 100, timeoutSeconds: p.type === 'ollama' ? 300 : 120 }, '请用中文简短回应。', '请回复：连接成功。', new AbortController().signal);
    return { ok: true, message: '连接成功，模型已返回文字。' };
  });
  for (const [kind, schema] of [['classes', ClassInput], ['courses', CourseInput]] as const) {
    app.get(`/api/${kind}`, async () => store.list(kind));
    app.post(`/api/${kind}`, async req => {
      const body = schema.parse(req.body); if ('classId' in body) requireEntity('classes', body.classId);
      return store.put(kind, { id: id(), ...body });
    });
    app.put<{ Params: { id: string } }>(`/api/${kind}/:id`, async req => {
      requireEntity(kind, req.params.id); const body = schema.parse(req.body); if ('classId' in body) requireEntity('classes', body.classId);
      if (kind === 'courses' && store.get<Course>(kind, req.params.id)!.classId !== (body as any).classId) throw new Error('已有课程不能移动到其他班级，请新建课程。');
      return store.put(kind, { id: req.params.id, ...body });
    });
  }
  app.get('/api/resources', async () => store.list('resources'));
  app.post('/api/resources/text', async req => {
    const b = z.object({ classId: z.string(), courseId: z.string(), name: z.string().min(1), text: z.string().min(3).max(200000) }).parse(req.body);
    validateScope(b.classId, b.courseId); const r = await extractResource(b.name + '.txt', Buffer.from(b.text), b.classId, b.courseId, store); store.put('resources', r); return r;
  });
  app.post<{ Querystring: { classId: string; courseId: string } }>('/api/resources/upload', async req => {
    validateScope(req.query.classId, req.query.courseId); const file = await req.file(); if (!file) throw new Error('请选择文件。');
    const r = await extractResource(file.filename, await file.toBuffer(), req.query.classId, req.query.courseId, store); store.put('resources', r); return r;
  });
  app.get('/api/tasks', async () => store.list<TaskRun>('tasks').map(taskResponse));
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async req => taskResponse(requireEntity<TaskRun>('tasks', req.params.id)));
  app.get<{ Querystring: { classId: string; courseId: string; topic: string; mode?: string } }>('/api/memories/suggest', async req => {
    validateScope(req.query.classId, req.query.courseId); return store.memories(req.query.classId, req.query.courseId, req.query.topic || '', req.query.mode !== 'real');
  });
  app.post('/api/tasks', async req => {
    const b = TaskInput.parse(req.body), { cls, course } = validateScope(b.classId, b.courseId), config = store.settings();
    const memories = b.memoryIds.map(mid => requireEntity<MemoryEntry>('memories', mid));
    if (memories.some(m => m.status !== 'confirmed' || m.classId !== b.classId || (m.courseId && m.courseId !== b.courseId) || m.demo !== (b.mode === 'demo'))) throw new Error('所选记忆不属于本班课程，或尚未确认。');
    const resources: Resource[] = [];
    for (const s of b.segments) {
      const r = requireEntity<Resource>('resources', s.resourceId); if (r.classId !== b.classId || r.courseId !== b.courseId) throw new Error('教材不属于本班课程。');
      const segment = r.segments.find(x => x.id === s.segmentId); if (!segment) throw new Error('教材片段不存在。');
      const added = resources.find(x => x.id === r.id); if (added) added.segments.push(segment); else resources.push({ ...r, segments: [segment] });
    }
    if (resources.flatMap(r => r.segments).reduce((n, s) => n + s.text.length, 0) > 50000) throw new Error('本课教材片段过长，请缩小到 5 万字以内。');
    const t = newTask({ ...b, config: structuredClone(config), providers: structuredClone(snapshotProviders(b.mode, config)), context: { class: cls, course, memories, resources } });
    store.put('tasks', t); engine.start(t.id); return taskResponse(t);
  });
  app.post<{ Params: { id: string; action: string } }>('/api/tasks/:id/control/:action', async req => {
    const t = requireEntity<TaskRun>('tasks', req.params.id);
    if (['pause', 'cancel'].includes(req.params.action)) engine.stop(t.id, req.params.action === 'pause' ? 'paused' : 'cancelled');
    else if (req.params.action === 'resume') {
      if (!['paused', 'failed', 'cancelled'].includes(t.status)) throw new Error('该任务无需继续。');
      engine.start(t.id);
    } else throw new Error('未知任务操作。');
    return taskResponse(store.get<TaskRun>('tasks', t.id)!);
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id/events', async (req, reply) => {
    const t = requireEntity<TaskRun>('tasks', req.params.id);
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    const send = (v: TaskRun) => { if (!reply.raw.destroyed) reply.raw.write(`event: task\ndata: ${JSON.stringify(taskResponse(v))}\n\n`); };
    send(t); let set = engine.listeners.get(t.id); if (!set) { set = new Set(); engine.listeners.set(t.id, set); } set.add(send);
    const timer = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15000);
    req.raw.on('close', () => { clearInterval(timer); set!.delete(send); if (!set!.size) engine.listeners.delete(t.id); });
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/revise', async req => {
    const t = requireEntity<TaskRun>('tasks', req.params.id);
    if (!t.package || engine.active.has(t.id)) throw new Error('请等待任务完成后修改。');
    const b = z.object({ scope: z.enum(['goals', 'language', 'materials']), note: z.string().min(1), package: LessonSchema.optional() }).parse(req.body);
    if (b.package) t.package = b.package;
    t.kind = 'revision'; t.revisionNote = b.note; t.request += `\n教师修改要求：${b.note}`;
    t.stageIndex = 0; t.status = 'queued';
    t.stages = b.scope === 'goals' ? LESSON_STAGES.filter(s => s.role !== 'reflection') : b.scope === 'language' ? LESSON_STAGES.filter(s => ['language', 'assessment', 'materials', 'coordinator'].includes(s.role) && s.stage !== '规划与分派') : [{ role: 'materials', stage: '根据教师要求更新材料' }, { role: 'coordinator', stage: '整合与质量检查' }];
    t.adoptedVersion = undefined; store.put('tasks', t); engine.start(t.id); return taskResponse(t);
  });
  app.put<{ Params: { id: string } }>('/api/tasks/:id/package', async req => {
    const t = requireEntity<TaskRun>('tasks', req.params.id); if (engine.active.has(t.id)) throw new Error('请等待任务完成。');
    const p = LessonSchema.parse(req.body), old = t.package!;
    const changed = (keys: (keyof typeof p)[]) => keys.some(k => JSON.stringify(p[k]) !== JSON.stringify(old[k]));
    const goalsChanged = changed(['goals', 'coreTask', 'phases']), languageChanged = changed(['language', 'exercises']);
    t.package = p; t.adoptedVersion = undefined;
    if (goalsChanged || languageChanged) {
      t.kind = 'revision'; t.stageIndex = 0; t.status = 'queued';
      t.revisionNote = '教师已直接编辑教学内容，请保留编辑后的目标、核心任务和练习，更新其余对应材料。';
      t.stages = goalsChanged ? LESSON_STAGES.filter(s => s.role !== 'reflection') : LESSON_STAGES.filter(s => ['language', 'assessment', 'materials', 'coordinator'].includes(s.role) && s.stage !== '规划与分派');
      engine.emit(t, 'edited', '教师修改已保存，正在同步相关评价与材料。'); engine.start(t.id);
    } else {
      t.versions.push({ version: t.versions.length + 1, package: structuredClone(p), at: now(), adopted: false }); engine.emit(t, 'edited', '教师编辑已保存为新版本。');
    }
    return taskResponse(t);
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/adopt', async req => {
    const t = requireEntity<TaskRun>('tasks', req.params.id); if (!t.package || engine.active.has(t.id)) throw new Error('请先完成材料。');
    const b = z.object({ version: z.number().int().positive() }).parse(req.body), v = t.versions.find(x => x.version === b.version); if (!v) throw new Error('版本不存在。');
    t.versions.forEach(x => x.adopted = x.version === b.version); t.adoptedVersion = b.version; engine.emit(t, 'adopted', `教师采用版本 ${b.version}。`); return taskResponse(t);
  });
  app.get<{ Params: { id: string; format: string }; Querystring: { version?: string } }>('/api/tasks/:id/export/:format', async (req, reply) => {
    const t = requireEntity<TaskRun>('tasks', req.params.id); if (!t.package || !t.versions.length) throw new Error('请先完成教学材料。');
    const version = Number(req.query.version || t.versions.length), v = t.versions.find(x => x.version === version); if (!v) throw new Error('版本不存在。');
    const records = store.list<LessonRecord>('records').filter(x => x.classId === t.classId && x.courseId === t.courseId && x.demo === (t.mode === 'demo'));
    const result = await exportFile({ ...t, package: v.package, versions: t.versions.slice(0, version) }, req.params.format, records);
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`); return reply.type(result.mime).send(result.buffer);
  });
  app.get('/api/records', async () => store.list('records'));
  app.post('/api/records', async req => {
    const b = RecordInput.parse(req.body), t = requireEntity<TaskRun>('tasks', b.taskId); if (!t.package) throw new Error('请先完成本课备课。');
    if (engine.active.has(t.id)) throw new Error('请等待本课材料完成后再记录课堂。');
    if (new Set(b.students.map(x => x.code)).size !== b.students.length) throw new Error('学生匿名编号不能重复。');
    const r: LessonRecord = { ...b, id: id(), classId: t.classId, courseId: t.courseId, lesson: t.lessonNumber, createdAt: now(), demo: t.mode === 'demo' }; store.put('records', r);
    const usedPackage = t.versions.find(v => v.version === t.adoptedVersion)?.package || t.package;
    const reflection = newTask({ classId: t.classId, courseId: t.courseId, lessonNumber: t.lessonNumber, minutes: t.minutes, request: '根据本次课堂记录复盘，所有学情判断必须来自记录。', mode: t.mode, kind: 'reflection', stages: [{ role: 'reflection', stage: '课堂复盘与记忆候选' }, { role: 'coordinator', stage: '核对依据' }], config: t.config, providers: t.providers, context: { ...t.context, record: r }, package: usedPackage });
    store.put('tasks', reflection); engine.start(reflection.id); return { record: r, reflectionTaskId: reflection.id };
  });
  app.get('/api/memories', async () => store.list('memories'));
  app.post('/api/memories', async req => {
    const b = z.object({ classId: z.string(), courseId: z.string(), content: z.string().min(1).max(12000), kind: z.enum(['fact', 'inference', 'preference']), demo: z.boolean().default(false) }).parse(req.body);
    validateScope(b.classId, b.courseId); return store.put('memories', { ...b, id: id(), status: 'confirmed', sourceId: 'teacher', sourceLabel: '教师明确填写', version: 1, history: [], createdAt: now() });
  });
  app.put<{ Params: { id: string } }>('/api/memories/:id', async req => {
    const m = requireEntity<MemoryEntry>('memories', req.params.id), b = z.object({ content: z.string().min(1).max(12000), status: z.enum(['confirmed', 'rejected', 'archived', 'candidate']) }).parse(req.body);
    m.history.push({ content: m.content, status: m.status, at: now() }); m.content = b.content; m.status = b.status; m.version++; store.put('memories', m); return m;
  });
  app.get('/api/backup', async (_req, reply) => {
    const backup: any = store.backup(); backup.files = store.list<Resource>('resources').filter(r => r.filename && existsSync(join(store.dir, 'resources', r.filename))).map(r => ({ name: r.filename, base64: readFileSync(join(store.dir, 'resources', r.filename!)).toString('base64') }));
    reply.header('Content-Disposition', `attachment; filename="teaching-team-${Date.now()}.json"`); return backup;
  });
  app.post('/api/restore', async req => {
    if (engine.active.size) throw new Error('请先暂停或完成运行中的任务，再恢复数据。');
    const data: any = req.body;
    const files = z.array(z.object({ name: z.string().regex(/^[a-f0-9-]+\.(txt|md|docx|pdf)$/), base64: z.string() })).parse(data?.files || []);
    if (!Array.isArray(data?.entities)) throw new Error('备份缺少业务记录。');
    for (const row of data.entities) {
      const v = row.value;
      if (row.kind === 'settings') {
        const settings = z.object({ version: z.number().int().positive(), preferences: z.string(), agents: z.array(AgentInput).length(6) }).parse(v);
        if (new Set(settings.agents.map(x => x.role)).size !== 6) throw new Error('备份岗位配置不完整。');
      }
      if (row.kind === 'classes') ClassInput.parse(v);
      if (row.kind === 'courses') CourseInput.parse(v);
      if (row.kind === 'providers') ProviderInput.parse(v);
      if (row.kind === 'resources') z.object({ filename: z.string().regex(/^[a-f0-9-]+\.(txt|md|docx|pdf)$/).optional(), segments: z.array(z.object({ id: z.string(), location: z.string(), text: z.string() })) }).parse(v);
      if (row.kind === 'tasks') {
        z.object({ classId: z.string(), courseId: z.string(), mode: z.enum(['demo', 'real']), stages: z.array(z.object({ role: z.enum(ROLES), stage: z.string() })), stageIndex: z.number().int().nonnegative(), results: z.array(z.any()), events: z.array(z.any()), versions: z.array(z.object({ version: z.number(), package: LessonSchema })), config: z.object({ agents: z.array(AgentInput).length(6) }), providers: z.array(ProviderInput.extend({ id: z.string() })) }).parse(v);
        if (v.package) LessonSchema.parse(v.package);
      }
      if (row.kind === 'memories') z.object({ content: z.string(), status: z.enum(['candidate', 'confirmed', 'rejected', 'archived']), history: z.array(z.any()), version: z.number().positive(), classId: z.string(), courseId: z.string() }).parse(v);
      if (row.kind === 'records') RecordInput.parse(v);
    }
    const classes = new Set(data.entities.filter((r: any) => r.kind === 'classes').map((r: any) => r.id));
    const courses = new Map<string, any>(data.entities.filter((r: any) => r.kind === 'courses').map((r: any) => [r.id, r.value]));
    const tasks = new Set(data.entities.filter((r: any) => r.kind === 'tasks').map((r: any) => r.id));
    for (const row of data.entities) {
      const v = row.value;
      if (['courses', 'resources', 'tasks', 'records', 'memories'].includes(row.kind) && !classes.has(v.classId)) throw new Error('备份含没有所属班级的记录。');
      if (['resources', 'tasks', 'records', 'memories'].includes(row.kind) && v.courseId && courses.get(v.courseId)?.classId !== v.classId) throw new Error('备份的班级与课程关联不一致。');
      if (row.kind === 'records' && !tasks.has(v.taskId)) throw new Error('备份课堂记录缺少对应任务。');
    }
    // File contents are validated and written under generated names only.
    store.restore(data); for (const f of files) writeFileSync(join(store.dir, 'resources', f.name), Buffer.from(f.base64, 'base64'), { mode: 0o600 });
    return { ok: true, message: '数据已恢复。模型密钥不包含在备份中，请在设置中重新填写。恢复前的数据快照已保存。' };
  });
  app.post('/api/demo/seed', async () => {
    const existing = store.list<ClassProfile>('classes').find(c => c.name === '成人中级口语 · 示例班');
    if (existing) return { classId: existing.id, courseId: store.list<Course>('courses').find(c => c.classId === existing.id)?.id };
    const cls = { id: id(), name: '成人中级口语 · 示例班', background: '来华外国成人学生；示例数据，不代表实际学生。', level: '中级；听说表现需分别观察', size: 16, needs: '校园沟通与生活请求，练习临时追问和信息确认。' }; store.put('classes', cls);
    const course = { id: id(), classId: cls.id, name: '校园生活口语', goals: '能说明需求、协商安排，并确认对方回应。', textbook: '可上传本校教材，本示例不假定特定教材。', totalHours: 32, progress: '准备第 1 课' }; store.put('courses', course);
    return { classId: cls.id, courseId: course.id };
  });
  const dist = resolve('dist');
  app.get('/*', async (req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在。' });
    let path = resolve(dist, '.' + decodeURIComponent(req.url.split('?')[0]));
    if (!path.startsWith(dist + '/') && path !== dist) return reply.code(403).send('禁止访问');
    if (!existsSync(path) || !extname(path)) path = join(dist, 'index.html');
    if (!existsSync(path)) return reply.code(503).type('text/plain').send('请先运行 npm run build，再启动工作台。');
    const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
    return reply.type(mime[extname(path)] || 'application/octet-stream').send(readFileSync(path));
  });
  app.addHook('onClose', async () => { for (const taskId of engine.active.keys()) engine.stop(taskId, 'paused'); });
  return { app, store, engine };
}
