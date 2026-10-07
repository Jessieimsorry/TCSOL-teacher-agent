import { z } from 'zod';
export const ROLES = ['coordinator', 'curriculum', 'language', 'assessment', 'materials', 'reflection'] as const;
export type Role = typeof ROLES[number];
export const ROLE_NAMES: Record<Role, string> = { coordinator: '总控', curriculum: '课程设计', language: '中文教学支持', assessment: '评价分析', materials: '材料制作', reflection: '教学复盘' };
export const ROLE_SKILLS: Record<Role, string[]> = {
  coordinator: ['需求识别', '任务编排', '冲突协调', '交付检查'], curriculum: ['目标与评价对齐', '成人交际任务', '课时与进度'],
  language: ['语言点与自然表达', '语用情境', '分层与支架'], assessment: ['随堂检查', '评分参考', '证据分析'],
  materials: ['教师与学生版分离', '课件组织', '文件交付'], reflection: ['观察表', '课堂复盘', '记忆候选']
};
export type ProviderType = 'openai' | 'anthropic' | 'ollama';
export interface Provider { id: string; name: string; type: ProviderType; baseUrl: string; model: string; tokenParameter?: 'max_tokens' | 'max_completion_tokens' | 'none'; supportsTemperature?: boolean; secret?: string; hasKey?: boolean; keyMask?: string; }
export interface AgentConfig { role: Role; providerId: string; model: string; maxTokens: number; timeoutSeconds: number; temperature?: number; }
export interface Settings { agents: AgentConfig[]; preferences: string; version: number; }
export interface ClassProfile { id: string; name: string; background: string; level: string; size: number; needs: string; }
export interface Course { id: string; classId: string; name: string; goals: string; textbook: string; totalHours: number; progress: string; }
export interface Resource { id: string; classId: string; courseId: string; name: string; segments: { id: string; location: string; text: string }[]; filename?: string; createdAt: string; }
export interface MemoryEntry { id: string; classId: string; courseId: string; content: string; kind: 'fact' | 'inference' | 'preference'; status: 'candidate' | 'confirmed' | 'rejected' | 'archived'; sourceId: string; sourceLabel: string; createdAt: string; version: number; history: { content: string; status: string; at: string }[]; demo: boolean; }
export interface LessonRecord { id: string; taskId: string; classId: string; courseId: string; lesson: number; completed: string; issues: string; teacherNotes: string; students: { code: string; homework: string; score: number | null }[]; gradesConfirmed: boolean; createdAt: string; demo: boolean; }
export const LessonSchema = z.object({
  title: z.string().min(1), goals: z.array(z.string().min(1)).min(1), coreTask: z.string().min(1),
  phases: z.array(z.object({ name: z.string(), minutes: z.number().positive(), activity: z.string() })).min(1),
  language: z.array(z.object({ expression: z.string(), explanation: z.string(), example: z.string() })).min(1),
  exercises: z.array(z.object({ title: z.string(), instruction: z.string(), support: z.string(), extension: z.string() })).min(1),
  checks: z.array(z.object({ question: z.string(), goalIndex: z.number().int().nonnegative(), answer: z.string(), nextStep: z.string() })).min(1),
  slides: z.array(z.object({ title: z.string(), bullets: z.array(z.string()), notes: z.string(), teacherOnly: z.boolean() })).min(1),
  homework: z.string(), observation: z.array(z.string()).min(1), challenges: z.array(z.string()),
  quality: z.array(z.string()), teacherNotes: z.string()
});
export type LessonPackage = z.infer<typeof LessonSchema>;
export const ResultSchema = z.object({ summary: z.string().min(1), findings: z.array(z.string()), concerns: z.array(z.string()), lesson: LessonSchema.optional(), memoryCandidates: z.array(z.string()).optional() });
export type ResultContent = z.infer<typeof ResultSchema>;
export interface AgentResult extends ResultContent { id: string; role: Role; stage: string; model: string; provider: string; mode: 'demo' | 'real'; configVersion: number; inputSources: string[]; createdAt: string; durationMs: number; checks: string[]; }
export interface TaskEvent { id: number; at: string; type: string; message: string; role?: Role; }
export interface TaskRun {
  id: string; classId: string; courseId: string; lessonNumber: number; minutes: number; request: string; mode: 'demo' | 'real';
  kind: 'lesson' | 'reflection' | 'revision'; status: 'queued' | 'running' | 'paused' | 'cancelled' | 'failed' | 'completed';
  stageIndex: number; stages: { role: Role; stage: string }[]; results: AgentResult[]; events: TaskEvent[];
  config: Settings; providers: Provider[]; context: { class: ClassProfile; course: Course; memories: MemoryEntry[]; resources: Resource[]; record?: LessonRecord };
  package?: LessonPackage; versions: { version: number; package: LessonPackage; at: string; adopted: boolean }[];
  adoptedVersion?: number; error?: string; createdAt: string; updatedAt: string; revisionNote?: string;
}
export function qualityChecks(p: LessonPackage, minutes: number): string[] {
  const findings: string[] = [];
  const total = p.phases.reduce((s, x) => s + x.minutes, 0);
  if (total !== minutes) findings.push(`环节合计 ${total} 分钟，与课时 ${minutes} 分钟不符。`);
  p.goals.forEach((_, i) => { if (!p.checks.some(c => c.goalIndex === i)) findings.push(`目标 ${i + 1} 缺少对应检查题。`); });
  if (p.checks.some(c => c.goalIndex >= p.goals.length)) findings.push('检查题引用了不存在的目标。');
  if (p.exercises.some(e => !e.support.trim() || !e.extension.trim())) findings.push('练习缺少支持或拓展方式。');
  const answers = p.checks.map(c => c.answer.trim()).filter(x => x.length > 8);
  if (p.slides.some(s => !s.teacherOnly && s.bullets.some(b => answers.some(a => b.includes(a))))) findings.push('学生课件可能包含检查题答案，请确认。');
  return findings;
}
