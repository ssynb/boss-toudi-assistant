/** 本地输入解析：不写文件，不修改状态；原始简历字节交给 SQLite 与其他输入一起提交。 */
import crypto from 'node:crypto';
import path from 'node:path';
import { RESUME_EXTENSIONS, RESUME_MAX_BYTES, type ResumeExtension, type ResumeState, type SaveInputsRequest } from './contracts.ts';
import { AppError } from './errors.ts';

const MAX_TEXT = 50_000;
const MAX_REQUIREMENTS = 10_000;
const MAX_BASE64 = 4 * Math.ceil(RESUME_MAX_BYTES / 3);
const MAGIC: Partial<Record<ResumeExtension, Buffer>> = {
  '.pdf': Buffer.from('%PDF-'),
  '.docx': Buffer.from([0x50, 0x4b, 0x03, 0x04]),
};

export interface PreparedInputs {
  requirements: string;
  resume: ResumeState;
  /** undefined 保留原字节；null 删除；Buffer 替换。 */
  data?: Buffer | null;
}

function decodeFile(file: { fileName: string; base64: string }) {
  if (!file || typeof file.fileName !== 'string' || !file.fileName.trim() || typeof file.base64 !== 'string') {
    throw new AppError('bad_request', '简历文件需要文件名和 base64 内容');
  }
  if (file.base64.length > MAX_BASE64) throw new AppError('file_too_large', '简历文件不能超过 10 MB');
  if (file.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.base64)) {
    throw new AppError('bad_request', '简历文件不是标准 base64 编码');
  }
  const data = Buffer.from(file.base64, 'base64');
  if (data.length > RESUME_MAX_BYTES) throw new AppError('file_too_large', '简历文件不能超过 10 MB');
  if (data.toString('base64') !== file.base64) throw new AppError('bad_request', '简历文件不是标准 base64 编码');
  const fileName = path.basename(file.fileName.replaceAll('\\', '/')).slice(0, 200);
  const extension = path.extname(fileName).toLowerCase() as ResumeExtension;
  if (!RESUME_EXTENSIONS.includes(extension)) throw new AppError('unsupported_file', `只支持 ${RESUME_EXTENSIONS.join(' ')} 简历文件`);
  const magic = MAGIC[extension];
  if (magic && !data.subarray(0, magic.length).equals(magic)) throw new AppError('unsupported_file', `文件内容不是有效的 ${extension} 文件`);
  let text: string | null = null;
  if (!magic) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, '');
    } catch {
      throw new AppError('unsupported_file', '文本简历须为 UTF-8 编码');
    }
  }
  const meta = { fileName, extension, sizeBytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), uploadedAt: new Date().toISOString() };
  return { data, meta, text };
}

export function prepareInputs(request: SaveInputsRequest, previous: ResumeState): PreparedInputs {
  if (!request || typeof request.requirements !== 'string' || request.requirements.length > MAX_REQUIREMENTS || !request.resume) {
    throw new AppError('bad_request', '具体要求须为不超过 10000 字的文本，并提供简历保存操作');
  }
  const { file, text } = request.resume;
  if (text !== null && (typeof text !== 'string' || text.length > MAX_TEXT)) throw new AppError('bad_request', '简历正文须为不超过 50000 字的文本或 null');
  const uploaded = file === undefined || file === null ? null : decodeFile(file);
  const nextFile = file === null ? null : uploaded?.meta ?? previous.file;
  const nextText = text ?? (file === null ? '' : uploaded ? uploaded.text ?? '' : previous.text);
  if (nextText.length > MAX_TEXT) throw new AppError('bad_request', '简历正文不能超过 50000 字');
  if (nextFile && !nextText.trim()) throw new AppError('inputs_incomplete', '该简历没有可用正文，请在同一次保存中补充正文');
  const fromFile = uploaded ? uploaded.text === nextText : file === undefined && previous.textSource === 'file' && previous.text === nextText;
  return {
    requirements: request.requirements,
    resume: { file: nextFile, text: nextText, textSource: nextText.trim() ? (fromFile ? 'file' : 'pasted') : null },
    data: file === null ? null : uploaded?.data,
  };
}
