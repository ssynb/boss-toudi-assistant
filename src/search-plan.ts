/** 对话动作只接受最新用户消息的逐字引用；配额和参数由程序校验。 */
import { DAILY_CONTACT_LIMIT, MAX_BATCH_TARGETS } from './contracts.ts';
import { AppError } from './errors.ts';
import { SUPPORTED_CITIES } from './boss.ts';

export interface DeliveryDirection { name: string; keywords: string[]; count: number }
export interface SearchPlan {
  city: string;
  salaryMinK: number | null;
  criteria: string;
  sendNow: boolean;
  quote: string;
  directions: DeliveryDirection[];
}
export const MAX_SEARCH_KEYWORDS = 20;
const MAX_DIRECTIONS = 20;

export function requireQuote(quote: unknown, latestMessage: string): void {
  if (typeof quote !== 'string' || !quote.trim() || !latestMessage.includes(quote)) throw new Error('操作须附用户最新消息中的逐字原文引用，不能引用旧对话或自行假设授权');
}

export function requireQuota(count: number, contactedToday: number): void {
  const remaining = Math.max(0, DAILY_CONTACT_LIMIT - contactedToday);
  if (count > MAX_BATCH_TARGETS || count > remaining) throw new AppError('bad_request', `本批最多 ${MAX_BATCH_TARGETS} 个，今日剩余额度 ${remaining} 个；请求 ${count} 个，未启动`);
}

export const SEARCH_PLAN_SCHEMA = {
  type: 'object', properties: {
    city: { type: 'string', enum: SUPPORTED_CITIES }, salaryMinK: { type: ['number', 'null'] },
    criteria: { type: 'string' }, sendNow: { type: 'boolean' }, quote: { type: 'string' },
    directions: { type: 'array', minItems: 1, maxItems: MAX_DIRECTIONS, items: {
      type: 'object', properties: { name: { type: 'string' }, keywords: { type: 'array', minItems: 1, maxItems: MAX_SEARCH_KEYWORDS, items: { type: 'string' } }, count: { type: 'integer', minimum: 1, maximum: MAX_BATCH_TARGETS } },
      required: ['name', 'keywords', 'count'], additionalProperties: false,
    } },
  }, required: ['city', 'salaryMinK', 'criteria', 'sendNow', 'quote', 'directions'], additionalProperties: false,
};

export function readSearchPlan(value: unknown, latestMessage: string, contactedToday: number): SearchPlan {
  const plan = value as SearchPlan;
  requireQuote(plan?.quote, latestMessage);
  const text = (value: unknown, max: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
  if (!plan || !SUPPORTED_CITIES.includes(plan.city) || typeof plan.sendNow !== 'boolean' || !text(plan.criteria, 10_000)
    || !(plan.salaryMinK === null || typeof plan.salaryMinK === 'number' && Number.isFinite(plan.salaryMinK) && plan.salaryMinK >= 0 && plan.salaryMinK <= 1000)
    || !Array.isArray(plan.directions) || !plan.directions.length || plan.directions.length > MAX_DIRECTIONS
    || plan.directions.some(d => !d || !text(d.name, 80) || !Number.isInteger(d.count) || d.count < 1
      || !Array.isArray(d.keywords) || !d.keywords.length || d.keywords.length > MAX_SEARCH_KEYWORDS || d.keywords.some(k => !text(k, 80)))) {
    throw new Error('投递计划格式无效；须明确城市、薪资或不限、筛选要求及每个方向的数量');
  }
  if (new Set(plan.directions.map(d => d.name.trim())).size !== plan.directions.length) throw new Error('投递方向不能重复');
  requireQuota(plan.directions.reduce((sum, direction) => sum + direction.count, 0), contactedToday);
  return plan;
}
