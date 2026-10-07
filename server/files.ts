import { readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import JSZip from 'jszip';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell } from 'docx';
import pptxgen from 'pptxgenjs';
import ExcelJS from 'exceljs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Store } from './store.ts';
import { id, now } from './store.ts';
import type { Resource, TaskRun, LessonRecord } from '../shared/types.ts';
export async function extractResource(name: string, buffer: Buffer, classId: string, courseId: string, store: Store): Promise<Resource> {
  const extension = extname(name).toLowerCase(), rid = id();
  let segments: Resource['segments'] = [];
  if (['.txt', '.md'].includes(extension)) {
    segments = buffer.toString('utf8').split(/\n\s*\n/).map((text, i) => ({ id: `${rid}-${i}`, location: `段落 ${i + 1}`, text: text.trim() })).filter(x => x.text);
  } else if (extension === '.docx') {
    const zip = await JSZip.loadAsync(buffer), document = zip.file('word/document.xml');
    if (!document) throw new Error('Word 文件缺少正文，请检查文件。');
    const xml = await document.async('string');
    if (xml.length > 20_000_000) throw new Error('Word 正文过大，请仅上传本课章节。');
    const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, x: string) => x.startsWith('#x') ? String.fromCodePoint(parseInt(x.slice(2), 16)) : x.startsWith('#') ? String.fromCodePoint(Number(x.slice(1))) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[x] || ''));
    segments = [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((p, i) => ({ id: `${rid}-${i}`, location: `段落 ${i + 1}`, text: [...p[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(x => decode(x[1])).join('').trim() })).filter(x => x.text);
  } else if (extension === '.pdf') {
    const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
    try {
      const pdf = await loading.promise;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i), content = await page.getTextContent();
        const text = content.items.map((x: any) => x.str + (x.hasEOL ? '\n' : ' ')).join('').trim();
        if (text) segments.push({ id: `${rid}-${i}`, location: `第 ${i} 页`, text });
      }
    } catch { throw new Error('PDF 无法提取文字，可能为加密或损坏文件。请改用粘贴文字。'); }
    finally { await loading.destroy(); }
  } else throw new Error('请上传 TXT、Markdown、Word（DOCX）或可提取文字的 PDF。');
  if (!segments.length || !segments.some(x => x.text.replace(/\s/g, '').length > 2)) throw new Error('未提取到可用文字。扫描件暂不支持识别，请粘贴本课文字。');
  const filename = rid + extension; writeFileSync(join(store.dir, 'resources', filename), buffer, { mode: 0o600 });
  return { id: rid, classId, courseId, name, segments, filename, createdAt: now() };
}
const para = (text: string, heading = false) => new Paragraph({ ...(heading ? { heading: HeadingLevel.HEADING_2 } : {}), children: [new TextRun({ text, font: '宋体', size: heading ? 28 : 24 })], spacing: { after: 160 } });
export async function exportFile(t: TaskRun, format: string, records: LessonRecord[]): Promise<{ buffer: Buffer; filename: string; mime: string }> {
  const p = t.package!; const prefix = t.mode === 'demo' ? '【演示】' : '';
  if (format === 'docx' || format === 'worksheet') {
    const children: (Paragraph | Table)[] = [para(prefix + p.title, true), para(`第 ${t.lessonNumber} 课 · ${t.minutes} 分钟 · 版本 ${t.versions.length}`)];
    if (format === 'docx') {
      children.push(para('教学目标', true), ...p.goals.map((x, i) => para(`${i + 1}. ${x}`)), para('核心任务', true), para(p.coreTask), para('教学过程', true));
      children.push(new Table({ rows: [new TableRow({ children: ['环节', '分钟', '活动'].map(x => new TableCell({ children: [para(x)] })) }), ...p.phases.map(x => new TableRow({ children: [x.name, String(x.minutes), x.activity].map(s => new TableCell({ children: [para(s)] })) }))] }));
      children.push(para('语言内容', true), ...p.language.flatMap(x => [para(x.expression), para(x.explanation), para(`例：${x.example}`)]), para('教师检查题与反馈', true), ...p.checks.flatMap((x, i) => [para(`${i + 1}. ${x.question}（目标 ${x.goalIndex + 1}）`), para(`评分参考：${x.answer}`), para(`后续动作：${x.nextStep}`)]), para('课后观察', true), ...p.observation.map(x => para(x)), para('预设困难与质量提醒', true), ...[...p.challenges, ...p.quality].map(x => para(x)), para('教师备注', true), para(p.teacherNotes));
    } else children.push(para('今天的任务', true), para(p.coreTask));
    children.push(para('练习与任务卡', true), ...p.exercises.flatMap(x => [para(x.title, true), para(x.instruction), para(`支持：${x.support}`), para(`拓展：${x.extension}`)]), para('课后任务', true), para(p.homework));
    if (format === 'worksheet') children.push(para('独立检查', true), ...p.checks.map(x => para(x.question)), para('我的回顾：我能独立完成什么？我还需要什么帮助？'));
    const document = new Document({ sections: [{ children }], styles: { default: { document: { run: { font: '宋体', size: 24 } } } } });
    return { buffer: await Packer.toBuffer(document), filename: prefix + (format === 'docx' ? '教师教案' : '学生任务卡') + '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  if (format === 'pptx' || format === 'teacher-pptx') {
    const ppt = new pptxgen(); ppt.layout = 'LAYOUT_WIDE'; ppt.author = '国际中文 · 一人教学团队'; ppt.subject = p.coreTask; ppt.title = p.title; ppt.theme = { headFontFace: 'Microsoft YaHei', bodyFontFace: 'Microsoft YaHei' };
    for (const s of p.slides.filter(x => format === 'teacher-pptx' || !x.teacherOnly)) {
      const slide = ppt.addSlide(); slide.background = { color: 'F7F8F5' };
      slide.addText(prefix + s.title, { x: .7, y: .5, w: 11.8, h: 1, fontSize: 30, color: '193F3B', bold: true, breakLine: false, fit: 'shrink' });
      slide.addText(s.bullets.map(x => ({ text: x, options: { breakLine: true, bullet: { indent: 22 }, paraSpaceAfter: 18 } })), { x: .9, y: 1.8, w: 11.4, h: 4.7, fontSize: 24, color: '243B38', valign: 'top', fit: 'shrink' });
      slide.addText(`国际中文 · 第 ${t.lessonNumber} 课 · V${t.versions.length}${s.teacherOnly ? ' · 仅供教师' : ''}`, { x: .8, y: 7, w: 11, h: .2, fontSize: 10, color: '62756F' });
      if (format === 'teacher-pptx') slide.addNotes(s.notes);
    }
    const array = await ppt.write({ outputType: 'nodebuffer' });
    let buffer: Buffer = Buffer.from(array as Buffer);
    if (format === 'pptx') {
      // PptxGenJS creates empty notes parts even without addNotes. Remove those parts and their references.
      const zip = await JSZip.loadAsync(buffer);
      for (const path of Object.keys(zip.files)) if (/^ppt\/notes(Slides|Masters)\//.test(path)) zip.remove(path);
      for (const path of Object.keys(zip.files).filter(p => p.endsWith('.rels'))) {
        const xml = await zip.file(path)!.async('string');
        zip.file(path, xml.replace(/<Relationship\b[^>]*Type="[^"]*\/notes(?:Slide|Master)"[^>]*\/>/g, ''));
      }
      const types = await zip.file('[Content_Types].xml')!.async('string');
      zip.file('[Content_Types].xml', types.replace(/<Override\b[^>]*PartName="\/ppt\/notes(?:Slides|Masters)\/[^>]*\/>/g, ''));
      const presentation = await zip.file('ppt/presentation.xml')!.async('string');
      zip.file('ppt/presentation.xml', presentation.replace(/<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>/g, ''));
      buffer = await zip.generateAsync({ type: 'nodebuffer' });
    }
    return { buffer, filename: prefix + (format === 'teacher-pptx' ? '教师课件' : '学生课件') + '.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  }
  if (format === 'xlsx') {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('教学记录'), students = book.addWorksheet('匿名学生');
    sheet.columns = [{ header: '课次', key: 'lesson', width: 10 }, { header: '完成情况', key: 'completed', width: 40 }, { header: '课堂问题', key: 'issues', width: 45 }, { header: '教师意见', key: 'teacherNotes', width: 45 }, { header: '成绩已确认', key: 'gradesConfirmed', width: 15 }];
    students.columns = [{ header: '课次', key: 'lesson', width: 10 }, { header: '匿名编号', key: 'code', width: 18 }, { header: '作业状态', key: 'homework', width: 25 }, { header: '分数', key: 'score', width: 12 }, { header: '成绩状态', key: 'status', width: 16 }];
    for (const r of records) { sheet.addRow({ ...r, gradesConfirmed: r.gradesConfirmed ? '已确认' : '待确认' }); for (const s of r.students) students.addRow({ ...s, lesson: r.lesson, status: r.gradesConfirmed ? '已确认' : '待确认' }); }
    const goals = book.addWorksheet('本课目标'); p.goals.forEach((g, i) => goals.addRow([i + 1, g])); goals.getColumn(2).width = 70;
    for (const ws of [sheet, students]) { ws.getRow(1).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1 }]; ws.eachRow(row => row.alignment = { vertical: 'top', wrapText: true }); }
    return { buffer: Buffer.from(await book.xlsx.writeBuffer()), filename: prefix + '教学记录.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  throw new Error('不支持的导出格式。');
}
