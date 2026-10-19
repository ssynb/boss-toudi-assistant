/**
 * 本地简历文件：按扩展名与文件头校验后，以 0600 权限保存在数据目录。
 * txt/md 直接读出 UTF-8 正文；pdf/docx 不在本地解析（避免引入解析依赖），正文由用户粘贴并确认。
 * 本地文件只用于模型匹配，不会上传到 BOSS。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RESUME_EXTENSIONS, RESUME_MAX_BYTES, type ResumeExtension, type ResumeFileMeta } from './contracts.ts';
import { AppError } from './errors.ts';

const MAGIC: Partial<Record<ResumeExtension, Buffer>> = {
  '.pdf': Buffer.from('%PDF-'),
  '.docx': Buffer.from([0x50, 0x4b, 0x03, 0x04]),
};

export interface StoredResume {
  meta: ResumeFileMeta;
  /** txt/md 的正文；pdf/docx 为 null。 */
  text: string | null;
}

export function storeResume(dir: string, fileName: string, bytes: Buffer): StoredResume {
  const name = path.basename(fileName).slice(0, 200);
  const extension = path.extname(name).toLowerCase() as ResumeExtension;
  if (!RESUME_EXTENSIONS.includes(extension)) throw new AppError('unsupported_file', `只支持 ${RESUME_EXTENSIONS.join(' ')} 简历文件`);
  if (bytes.length > RESUME_MAX_BYTES) throw new AppError('file_too_large', '简历文件不能超过 10 MB');
  const magic = MAGIC[extension];
  if (magic && !bytes.subarray(0, magic.length).equals(magic)) throw new AppError('unsupported_file', `文件内容不是有效的 ${extension} 文件`);
  let text: string | null = null;
  if (!magic) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    } catch {
      throw new AppError('unsupported_file', '文本简历须为 UTF-8 编码');
    }
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = resumePath(dir, { sha256, extension });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { meta: { fileName: name, extension, sizeBytes: bytes.length, sha256, uploadedAt: new Date().toISOString() }, text };
}

export function deleteResume(dir: string, meta: Pick<ResumeFileMeta, 'sha256' | 'extension'> | null): void {
  if (meta) fs.rmSync(resumePath(dir, meta), { force: true });
}

function resumePath(dir: string, meta: Pick<ResumeFileMeta, 'sha256' | 'extension'>): string {
  return path.join(dir, `${meta.sha256}${meta.extension}`);
}
