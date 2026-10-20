/**
 * 本地持久状态与批次规则的唯一来源（SQLite）。
 *
 * 规则：
 * - 批次执行中拒绝一切修改；其余时候任何修改（具体要求、简历、批次）都会让未完成批次退回草案并使批准失效。
 * - 联系账本（contacts）跨批次保存：联系步骤动手前先记为 unknown，核实后改为 done；
 *   账本里出现过的岗位永不再次联系。
 * - 打开数据库时，上次残留的 inflight 步骤变为 unknown，执行中的批次变为 paused。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  GREETING_MAX_CHARS,
  RESUME_EXTENSIONS,
  type SaveInputsRequest,
  type DiscoveryState,
  type Batch,
  type ContactIdentity,
  type BatchStatus,
  type ResumeFileMeta,
  type ResumeState,
  type StepState,
  type Target,
  type TargetPatch,
  type TargetSteps,
} from './contracts.ts';
import { AppError } from './errors.ts';
import { prepareInputs } from './resume.ts';

export interface DraftTarget {
  jobId: string;
  company: string;
  title: string;
  salary: string;
  url: string;
  reason: string;
  greeting: string;
}

export type Step = keyof TargetSteps;

export interface StateSnapshot {
  discovery: DiscoveryState;
  requirements: string;
  resume: ResumeState;
  batch: Batch | null;
  contactedCount: number;
}

const DEFAULT_RESUME: ResumeState = { file: null, text: '', textSource: null };
const DEFAULT_DISCOVERY: DiscoveryState = { status: 'idle', message: null, questions: [], startedAt: null, finishedAt: null };
const MAX_TARGETS = 50;
const CRASH_REASON = '上次运行意外中断：中断时正在进行的步骤结果未确认，请到 BOSS 上自行核对。';

const STEP_COLUMN: Record<Step, string> = { contact: 'contact', greeting: 'greeting_state' };
/** 已移除的附件简历功能留下的列；旧库启动时删除，否则新目标无法插入。 */
const REMOVED_COLUMNS = [['batch', 'resume_delivery'], ['targets', 'resume']] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS resume_file (id INTEGER PRIMARY KEY CHECK(id = 1), data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batch (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, approved_version INTEGER,
  stop_reason TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, ord INTEGER NOT NULL, job_id TEXT NOT NULL,
  company TEXT NOT NULL, title TEXT NOT NULL, salary TEXT NOT NULL, url TEXT NOT NULL,
  reason TEXT NOT NULL, greeting TEXT NOT NULL, removed INTEGER NOT NULL,
  contact TEXT NOT NULL, greeting_state TEXT NOT NULL,
  evidence TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contact_identities (target_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, recruiter_url TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (job_id TEXT PRIMARY KEY, company TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL);
`;

interface BatchRow {
  id: string;
  version: number;
  status: BatchStatus;
  approved_version: number | null;
  stop_reason: string | null;
  created_at: string;
}

interface TargetRow {
  id: string;
  job_id: string;
  company: string;
  title: string;
  salary: string;
  url: string;
  reason: string;
  greeting: string;
  removed: number;
  contact: StepState;
  greeting_state: StepState;
  evidence: string;
  updated_at: string;
}

const now = () => new Date().toISOString();

export function openState(file: string): State {
  return new State(file);
}

export class State {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    this.#db = new DatabaseSync(file);
    try {
      this.#db.exec('PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.#db.exec(SCHEMA);
      this.#dropRemovedColumns();
      this.#migrateResume(file);
      this.#recover();
    } catch (e) {
      this.#db.close();
      throw e;
    }
  }

  close(): void {
    this.#db.close();
  }

  snapshot(): StateSnapshot {
    const count = this.#db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number };
    return {
      discovery: this.#kv('discovery', DEFAULT_DISCOVERY),
      requirements: this.#kv('requirements', ''),
      resume: this.#kv('resume', DEFAULT_RESUME),
      batch: this.#batch(),
      contactedCount: count.n,
    };
  }

  // ---------- 具体要求、简历（修改即使批准失效） ----------

  saveInputs(request: SaveInputsRequest): void {
    this.#edit(() => {
      const input = prepareInputs(request, this.#kv('resume', DEFAULT_RESUME));
      if (input.data === null) this.#db.exec('DELETE FROM resume_file');
      else if (input.data !== undefined) this.#db.prepare('INSERT INTO resume_file (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(input.data);
      this.#setKv('requirements', input.requirements);
      this.#setKv('resume', input.resume);
      this.#setKv('discovery', { ...this.#kv('discovery', DEFAULT_DISCOVERY), message: null, questions: [] });
    });
  }

  beginDiscovery(): void {
    this.#tx(() => {
      this.#assertNotRunning();
      this.#assertDiscoveryIdle();
      if (!this.#kv('requirements', '').trim() || !this.#kv('resume', DEFAULT_RESUME).text.trim()) {
        throw new AppError('inputs_incomplete', '请先统一保存具体要求和有效简历正文');
      }
      this.#setKv('discovery', { status: 'running', message: '正在发现岗位…', questions: [], startedAt: now(), finishedAt: null });
    });
  }

  requestDiscoveryStop(): void {
    this.#tx(() => {
      const current = this.#kv('discovery', DEFAULT_DISCOVERY);
      if (current.status === 'running') this.#setKv('discovery', { ...current, status: 'stopping', message: '正在停止…' });
    });
  }

  finishDiscovery(message: string, questions: string[] = []): void {
    this.#tx(() => {
      const current = this.#kv('discovery', DEFAULT_DISCOVERY);
      if (current.status !== 'idle') this.#setKv('discovery', { ...current, status: 'idle', message, questions, finishedAt: now() });
    });
  }

  // ---------- 批次 ----------

  /** 用新的草案替换当前批次（执行中拒绝）。已联系账本不受影响。 */
  replaceBatch(drafts: DraftTarget[]): Batch {
    if (drafts.length === 0 || drafts.length > MAX_TARGETS) throw new AppError('bad_request', `草案目标数须在 1–${MAX_TARGETS} 之间`);
    if (new Set(drafts.map((d) => d.jobId)).size !== drafts.length) throw new AppError('bad_request', '草案中有重复岗位');
    this.#tx(() => {
      this.#assertNotRunning();
      const version = (this.#batchRow()?.version ?? 0) + 1;
      this.#db.exec('DELETE FROM contact_identities; DELETE FROM targets; DELETE FROM batch;');
      const id = crypto.randomUUID();
      this.#db
        .prepare('INSERT INTO batch (id, version, status, approved_version, stop_reason, created_at) VALUES (?, ?, ?, NULL, NULL, ?)')
        .run(id, version, 'draft', now());
      const insert = this.#db.prepare(
        `INSERT INTO targets (id, batch_id, ord, job_id, company, title, salary, url, reason, greeting, removed, contact, greeting_state, evidence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'todo', 'todo', '', ?)`,
      );
      drafts.forEach((d, i) =>
        insert.run(crypto.randomUUID(), id, i, d.jobId, d.company, d.title, d.salary, d.url, d.reason, greetingText(d.greeting), now()),
      );
    });
    return this.#batch()!;
  }

  patchTarget(id: string, p: TargetPatch): void {
    this.#editBatch((batch) => {
      const t = batch.targets.find((x) => x.id === id);
      if (!t) throw new AppError('not_found', '目标不存在');
      if (t.steps.contact !== 'todo') throw new AppError('bad_request', '该目标已开始处理，不能再修改');
      const greeting = p.greeting === undefined ? t.greeting : greetingText(p.greeting);
      const removed = p.removed === undefined ? t.removed : p.removed === true;
      this.#db.prepare('UPDATE targets SET greeting = ?, removed = ?, updated_at = ? WHERE id = ?').run(greeting, removed ? 1 : 0, now(), id);
    });
  }

  approve(version: number): void {
    this.#tx(() => {
      this.#assertDiscoveryIdle();
      const batch = this.#requireBatch();
      if (batch.status === 'running' || batch.status === 'done') throw new AppError('not_approvable', '当前批次不可批准');
      if (version !== batch.version) throw new AppError('stale_version', '批次已被修改，请刷新后重新核对');
      const active = batch.targets.filter((t) => !t.removed);
      if (active.length === 0) throw new AppError('not_approvable', '批次中没有要执行的目标');
      if (batch.status !== 'paused') this.#db.prepare("UPDATE batch SET status = 'approved'").run();
      this.#db.prepare('UPDATE batch SET approved_version = ?').run(version);
    });
  }

  // ---------- 执行器专用 ----------

  beginRun(): Batch {
    this.#tx(() => {
      this.#assertDiscoveryIdle();
      const row = this.#batchRow();
      const valid = row && row.approved_version === row.version && (row.status === 'approved' || row.status === 'paused');
      if (!valid) throw new AppError('not_startable', '批次未处于有效批准状态，请先核对并批准');
      this.#db.prepare("UPDATE batch SET status = 'running', stop_reason = NULL").run();
    });
    return this.#batch()!;
  }

  finishRun(status: 'paused' | 'done', stopReason: string | null): void {
    this.#db.prepare("UPDATE batch SET status = ?, stop_reason = ? WHERE status = 'running'").run(status, stopReason);
  }

  setStep(target: Target, step: Step, value: StepState, evidence: string, identity?: ContactIdentity): void {
    this.#tx(() => {
      this.#db.prepare(`UPDATE targets SET ${STEP_COLUMN[step]} = ?, evidence = ?, updated_at = ? WHERE id = ?`).run(value, evidence, now(), target.id);
      if (step !== 'contact') return;
      if (value === 'done' && identity) {
        if (identity.jobId !== target.jobId) throw new AppError('bad_request', '核实身份的岗位与目标不符');
        this.#db.prepare('INSERT INTO contact_identities (target_id, job_id, recruiter_url) VALUES (?, ?, ?) ON CONFLICT(target_id) DO UPDATE SET job_id = excluded.job_id, recruiter_url = excluded.recruiter_url')
          .run(target.id, identity.jobId, identity.recruiterUrl);
      }
      if (value === 'inflight' || value === 'unknown' || value === 'done') {
        this.#db
          .prepare('INSERT INTO contacts (job_id, company, title, state, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state = excluded.state, at = excluded.at')
          .run(target.jobId, target.company, target.title, value === 'done' ? 'done' : 'unknown', now());
      } else if (value === 'skipped') {
        this.#db.prepare('INSERT OR IGNORE INTO contacts (job_id, company, title, state, at) VALUES (?, ?, ?, ?, ?)').run(target.jobId, target.company, target.title, 'skipped', now());
      }
    });
  }

  isContacted(jobId: string): boolean {
    return this.#db.prepare('SELECT 1 FROM contacts WHERE job_id = ?').get(jobId) !== undefined;
  }

  // ---------- 内部 ----------

  #dropRemovedColumns(): void {
    for (const [table, column] of REMOVED_COLUMNS) {
      const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (columns.some((c) => c.name === column)) this.#db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }

  #migrateResume(databasePath: string): void {
    const legacyPath = (meta: ResumeFileMeta) => {
      if (!/^[a-f0-9]{64}$/.test(meta.sha256) || !RESUME_EXTENSIONS.includes(meta.extension)) throw new Error('旧简历元数据无效，未删除文件');
      return path.join(path.dirname(databasePath), 'resume', meta.sha256 + meta.extension);
    };
    const resume = this.#kv('resume', DEFAULT_RESUME);
    this.#tx(() => {
      if (resume.file && !this.#db.prepare('SELECT id FROM resume_file WHERE id = 1').get()) {
        const data = fs.readFileSync(legacyPath(resume.file));
        if (crypto.createHash('sha256').update(data).digest('hex') !== resume.file.sha256) throw new Error('旧简历文件校验失败，未删除文件');
        this.#db.prepare('INSERT INTO resume_file (id, data) VALUES (1, ?)').run(data);
        this.#setKv('legacy_resume_cleanup', resume.file);
      }
      if ('textConfirmed' in resume) this.#setKv('resume', { file: resume.file, text: resume.text, textSource: resume.textSource });
    });
    // 迁移提交之后才删旧文件；清理失败则启动失败，下次启动按持久标记继续，不丢原始字节。
    const cleanup = this.#kv<ResumeFileMeta | null>('legacy_resume_cleanup', null);
    if (cleanup) {
      fs.rmSync(legacyPath(cleanup), { force: true });
      this.#db.prepare("DELETE FROM kv WHERE key = 'legacy_resume_cleanup'").run();
    }
  }

  #recover(): void {
    this.#tx(() => {
      const discovery = this.#kv('discovery', DEFAULT_DISCOVERY);
      if (discovery.status !== 'idle') this.#setKv('discovery', { ...discovery, status: 'idle', message: '上次发现因进程中断而停止，结束时间为本次恢复检测时间。', finishedAt: now() });
      const legacy = this.#db.prepare("DELETE FROM kv WHERE key IN ('profile', 'criteria')").run();
      if (legacy.changes) this.#invalidate();
      const stale = this.#db.prepare("SELECT COUNT(*) AS n FROM targets WHERE contact = 'inflight' OR greeting_state = 'inflight'").get() as { n: number };
      for (const col of Object.values(STEP_COLUMN)) {
        this.#db.prepare(`UPDATE targets SET ${col} = 'unknown', updated_at = ? WHERE ${col} = 'inflight'`).run(now());
      }
      this.#db.prepare("UPDATE batch SET status = 'paused', stop_reason = ? WHERE status = 'running'").run(stale.n > 0 ? CRASH_REASON : '上次运行意外中断。');
    });
  }

  #edit(fn: () => void): void {
    this.#tx(() => {
      this.#assertNotRunning();
      this.#assertDiscoveryIdle();
      fn();
      this.#invalidate();
    });
  }

  #editBatch(fn: (batch: Batch) => void): void {
    this.#tx(() => {
      this.#assertNotRunning();
      this.#assertDiscoveryIdle();
      const batch = this.#requireBatch();
      if (batch.status === 'done') throw new AppError('bad_request', '批次已完成，请重新发现生成新批次');
      fn(batch);
      this.#invalidate();
    });
  }

  #invalidate(): void {
    this.#db.prepare("UPDATE batch SET status = 'draft', version = version + 1, approved_version = NULL WHERE status != 'done'").run();
  }

  #assertDiscoveryIdle(): void {
    if (this.#kv('discovery', DEFAULT_DISCOVERY).status !== 'idle') throw new AppError('busy', '发现运行中，请先停止');
  }

  #assertNotRunning(): void {
    if (this.#batchRow()?.status === 'running') throw new AppError('batch_running', '批次执行中，请先暂停');
  }

  #tx(fn: () => void): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }

  #kv<T>(key: string, fallback: T): T {
    const row = this.#db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  #setKv(key: string, value: unknown): void {
    this.#db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  #batchRow(): BatchRow | undefined {
    return this.#db.prepare('SELECT * FROM batch').get() as BatchRow | undefined;
  }

  #requireBatch(): Batch {
    const batch = this.#batch();
    if (!batch) throw new AppError('not_found', '还没有批次');
    return batch;
  }

  #identity(targetId: string): { contactIdentity?: ContactIdentity } {
    const row = this.#db.prepare('SELECT job_id, recruiter_url FROM contact_identities WHERE target_id = ?').get(targetId) as { job_id: string; recruiter_url: string } | undefined;
    return row ? { contactIdentity: { jobId: row.job_id, recruiterUrl: row.recruiter_url } } : {};
  }

  #batch(): Batch | null {
    const row = this.#batchRow();
    if (!row) return null;
    const rows = this.#db.prepare('SELECT * FROM targets WHERE batch_id = ? ORDER BY ord').all(row.id) as unknown as TargetRow[];
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      stopReason: row.stop_reason,
      createdAt: row.created_at,
      targets: rows.map((t) => ({
        ...this.#identity(t.id),
        id: t.id,
        jobId: t.job_id,
        company: t.company,
        title: t.title,
        salary: t.salary,
        url: t.url,
        reason: t.reason,
        greeting: t.greeting,
        removed: t.removed === 1,
        steps: { contact: t.contact, greeting: t.greeting_state },
        evidence: t.evidence,
        updatedAt: t.updated_at,
      })),
    };
  }
}

function str(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || v.length > max) throw new AppError('bad_request', `${field} 须为不超过 ${max} 字的文本`);
  return v;
}

export function greetingText(v: unknown): string {
  const text = str(v, 'greeting', GREETING_MAX_CHARS).trim();
  if (!text) throw new AppError('bad_request', '招呼原文不能为空');
  return text;
}
