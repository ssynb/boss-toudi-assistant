import type { ErrorCode } from './contracts.ts';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unsupported_file: 400,
  forbidden: 403,
  not_found: 404,
  batch_running: 409,
  stale_version: 409,
  not_approvable: 409,
  not_startable: 409,
  resume_unconfirmed: 409,
  codex_signed_out: 409,
  browser_not_ready: 409,
  busy: 409,
  file_too_large: 413,
  internal: 500,
};

/** 面向用户的业务错误：message 是可直接展示的中文。 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
  }
}
