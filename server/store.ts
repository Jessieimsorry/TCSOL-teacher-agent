import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir } from './platform.ts';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { ROLES, type Settings, type MemoryEntry } from '../shared/types.ts';
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const tokenize = (s: string) => [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(s)].filter(x => x.isWordLike).map(x => x.segment.toLowerCase()).join(' ');
export function stripSecrets(value: any): any {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !['secret', 'apiKey', 'keyMask'].includes(k)).map(([k, v]) => [k, stripSecrets(v)]));
  return value;
}
export class Store {
  db: DatabaseSync; dir: string; key: Buffer;
  constructor(dir = defaultDataDir()) {
    this.dir = dir; mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const sub of ['resources', 'exports', 'backups']) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
    const keyPath = join(dir, 'master.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(keyPath, 0o600); this.key = readFileSync(keyPath);
    this.db = new DatabaseSync(join(dir, 'team.sqlite'));
    if (process.platform !== 'win32') chmodSync(join(dir, 'team.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, tokens);`);
    if (!this.get('settings', 'main')) this.put('settings', { id: 'main', version: 1, preferences: '', agents: ROLES.map(role => ({ role, providerId: '', model: '', maxTokens: 6000, timeoutSeconds: 120 })) });
    // A process restart never silently repeats an in-flight paid request.
    for (const task of this.list<any>('tasks')) if (['running', 'queued'].includes(task.status)) {
      task.status = 'paused'; task.error = '服务已重启，已保存成果。请点击继续。'; this.put('tasks', task);
    }
  }
  encrypt(plain: string): string {
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), data].map(x => x.toString('base64')).join('.');
  }
  decrypt(secret?: string): string {
    if (!secret) return '';
    const [iv, tag, data] = secret.split('.').map(x => Buffer.from(x, 'base64'));
    const d = createDecipheriv('aes-256-gcm', this.key, iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  }
  get<T = any>(kind: string, entityId: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM entities WHERE kind=? AND id=?').get(kind, entityId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  list<T = any>(kind: string): T[] {
    return (this.db.prepare('SELECT value FROM entities WHERE kind=? ORDER BY rowid DESC').all(kind) as { value: string }[]).map(x => JSON.parse(x.value));
  }
  put(kind: string, entity: { id: string; [key: string]: any }) {
    this.db.prepare('INSERT INTO entities(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind, entity.id, JSON.stringify(entity));
    if (kind === 'memories') {
      this.db.prepare('DELETE FROM memories_fts WHERE id=?').run(entity.id);
      if (entity.status === 'confirmed') this.db.prepare('INSERT INTO memories_fts(id,tokens) VALUES(?,?)').run(entity.id, tokenize(entity.content));
    }
    return entity;
  }
  delete(kind: string, entityId: string) { this.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind, entityId); }
  settings(): Settings { return this.get('settings', 'main')!; }
  memories(classId: string, courseId: string, topic: string, demo: boolean): MemoryEntry[] {
    const eligible = this.list<MemoryEntry>('memories').filter(x => x.status === 'confirmed' && x.classId === classId && (!x.courseId || x.courseId === courseId) && x.demo === demo);
    const tokens = tokenize(topic).split(' ').filter(Boolean).slice(0, 25);
    let ranked: string[] = [];
    if (tokens.length) {
      const query = tokens.map(x => '"' + x.replaceAll('"', '""') + '"').join(' OR ');
      ranked = (this.db.prepare('SELECT id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 100').all(query) as { id: string }[]).map(x => x.id);
    }
    return eligible.sort((a, b) => {
      const ai = ranked.indexOf(a.id), bi = ranked.indexOf(b.id);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || b.createdAt.localeCompare(a.createdAt);
    }).slice(0, 12);
  }
  backup() {
    const rows = this.db.prepare('SELECT kind,id,value FROM entities').all() as { kind: string; id: string; value: string }[];
    return { format: 'ChineseTeachingTeam', version: 1, createdAt: now(), entities: rows.map(r => ({ kind: r.kind, id: r.id, value: stripSecrets(JSON.parse(r.value)) })) };
  }
  restore(data: any) {
    const kinds = ['settings', 'providers', 'classes', 'courses', 'resources', 'tasks', 'records', 'memories'];
    if (data?.format !== 'ChineseTeachingTeam' || data.version !== 1 || !Array.isArray(data.entities)) throw new Error('不是本系统的备份文件。');
    for (const row of data.entities) {
      if (!kinds.includes(row.kind) || typeof row.id !== 'string' || !row.value || row.value.id !== row.id) throw new Error('备份内容不完整。');
    }
    if (data.entities.filter((r: any) => r.kind === 'settings' && r.id === 'main').length !== 1) throw new Error('备份缺少唯一的工作台设置。');
    if (new Set(data.entities.map((r: any) => r.kind + ':' + r.id)).size !== data.entities.length) throw new Error('备份含重复记录。');
    const snapshot = this.backup();
    writeFileSync(join(this.dir, 'backups', `before-restore-${Date.now()}.json`), JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM entities; DELETE FROM memories_fts;');
      for (const row of data.entities) {
        const value = stripSecrets(row.value);
        if (row.kind === 'tasks' && ['running', 'queued'].includes(value.status)) value.status = 'paused';
        this.put(row.kind, value);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
}
