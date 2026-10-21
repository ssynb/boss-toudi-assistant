/** AI 提取结果仅活在本轮发现中，不是可编辑或持久配置。 */
import { MAX_BATCH_TARGETS } from './contracts.ts';
import { SUPPORTED_CITIES } from './boss.ts';

export interface SearchPlan {
  keywords: string[];
  city: string;
  salaryMinK: number | null;
  maxTargets: number;
  excludeCompanies: string[];
  quotes: { direction: string; city: string; salary: string };
}

export const MAX_SEARCH_KEYWORDS = 20;

export const SEARCH_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    keywords: { type: 'array', minItems: 1, maxItems: MAX_SEARCH_KEYWORDS, items: { type: 'string' } },
    city: { type: 'string', enum: SUPPORTED_CITIES },
    salaryMinK: { type: ['number', 'null'] },
    maxTargets: { type: 'integer', minimum: 1, maximum: MAX_BATCH_TARGETS },
    excludeCompanies: { type: 'array', items: { type: 'string' } },
    quotes: {
      type: 'object', properties: { direction: { type: 'string' }, city: { type: 'string' }, salary: { type: 'string' } },
      required: ['direction', 'city', 'salary'], additionalProperties: false,
    },
  },
  required: ['keywords', 'city', 'salaryMinK', 'maxTargets', 'excludeCompanies', 'quotes'],
  additionalProperties: false,
};

export function readSearchPlan(value: unknown, requirements: string): SearchPlan {
  const p = value as SearchPlan;
  const list = (xs: unknown): xs is string[] => Array.isArray(xs) && xs.every(x => typeof x === 'string' && x.trim().length > 0 && x.length <= 80);
  if (!p || !list(p.keywords) || !p.keywords.length || !list(p.excludeCompanies) || p.excludeCompanies.length > 20
    || p.keywords.length > MAX_SEARCH_KEYWORDS
    || !SUPPORTED_CITIES.includes(p.city) || !Number.isInteger(p.maxTargets) || p.maxTargets < 1 || p.maxTargets > MAX_BATCH_TARGETS
    || !(p.salaryMinK === null || typeof p.salaryMinK === 'number' && Number.isFinite(p.salaryMinK) && p.salaryMinK >= 0 && p.salaryMinK <= 1000)) {
    throw new Error('搜索计划格式无效；无法提取关键条件时请先请求澄清');
  }
  for (const key of ['direction', 'city', 'salary'] as const) {
    const quote = p.quotes?.[key];
    if (typeof quote !== 'string' || !quote.trim() || !requirements.includes(quote)) {
      throw new Error(`缺少具体要求中关于 ${key} 的原文依据，请先请求澄清，不能自行假设`);
    }
  }
  return p;
}
