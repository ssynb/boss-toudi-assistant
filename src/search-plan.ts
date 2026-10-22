/** 对话动作只接受最新用户消息的逐字引用；配额和参数由程序校验。 */
import { DAILY_CONTACT_LIMIT, MAX_BATCH_TARGETS } from './contracts.ts';
import { AppError } from './errors.ts';
import { SUPPORTED_CITIES } from './boss.ts';

export interface DeliveryDirection { name: string; keywords: string[]; count: number }
export interface SearchPlan {
  city: string;
  /** 月薪区间上限须达到的阈值，单位K/月；null只表示用户明确不限。 */
  salaryMinK: number | null;
  criteria: string;
  sendNow: boolean;
  quote: string;
  directions: DeliveryDirection[];
}
export const MAX_SEARCH_KEYWORDS = 20;
const CRITERIA_MAX_CHARS = 10_000;
const SALARY_UNIT_EXPONENT: Readonly<Record<string, number>> = { k: 0, '千': 0, '万': 1, '元': -3 };
const SALARY_AMOUNT = String.raw`(\d+(?:\.\d+)?)([kK](?![a-zA-Z])|千|万|元)`;
const MAX_DIRECTIONS = 20;
const EXPLICIT_RESTRICTIONS = /^用户明确限制（优先于下文）：([^。]*)。/u;

export function requireQuote(quote: unknown, latestMessage: string): void {
  if (typeof quote !== 'string' || !quote.trim() || !latestMessage.includes(quote)) throw new Error('操作须附用户最新消息中的逐字原文引用，不能引用旧对话或自行假设授权');
}

export function requireQuota(count: number, contactedToday: number): void {
  const remaining = Math.max(0, DAILY_CONTACT_LIMIT - contactedToday);
  if (count > MAX_BATCH_TARGETS || count > remaining) throw new AppError('bad_request', `本批最多 ${MAX_BATCH_TARGETS} 个，今日剩余额度 ${remaining} 个；请求 ${count} 个，未启动`);
}

export const SEARCH_PLAN_SCHEMA = {
  type: 'object', properties: {
    city: { type: 'string', enum: SUPPORTED_CITIES }, salaryMinK: { type: ['number', 'null'], description: '月薪区间上限须达到的K/月阈值。例如上限到20K就行必须填20，不能只写criteria；null仅在用户明确薪资不限时使用。' },
    criteria: { type: 'string' }, sendNow: { type: 'boolean' }, quote: { type: 'string' },
    directions: { type: 'array', minItems: 1, maxItems: MAX_DIRECTIONS, items: {
      type: 'object', properties: { name: { type: 'string' }, keywords: { type: 'array', minItems: 1, maxItems: MAX_SEARCH_KEYWORDS, items: { type: 'string' } }, count: { type: 'integer', minimum: 1, maximum: MAX_BATCH_TARGETS } },
      required: ['name', 'keywords', 'count'], additionalProperties: false,
    } },
  }, required: ['city', 'salaryMinK', 'criteria', 'sendNow', 'quote', 'directions'], additionalProperties: false,
};

export function readSearchPlan(value: unknown, latestMessage: string, contactedToday: number, salaryEvidence: string[] = []): SearchPlan {
  const plan = value as SearchPlan;
  requireQuote(plan?.quote, latestMessage);
  const text = (value: unknown, max: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
  if (!plan || !SUPPORTED_CITIES.includes(plan.city) || typeof plan.sendNow !== 'boolean' || !text(plan.criteria, CRITERIA_MAX_CHARS)
    || !(plan.salaryMinK === null || typeof plan.salaryMinK === 'number' && Number.isFinite(plan.salaryMinK) && plan.salaryMinK >= 0 && plan.salaryMinK <= 1000)
    || !Array.isArray(plan.directions) || !plan.directions.length || plan.directions.length > MAX_DIRECTIONS
    || plan.directions.some(d => !d || !text(d.name, 80) || !Number.isInteger(d.count) || d.count < 1
      || !Array.isArray(d.keywords) || !d.keywords.length || d.keywords.length > MAX_SEARCH_KEYWORDS || d.keywords.some(k => !text(k, 80)))) {
    throw new Error('投递计划格式无效；须明确城市、薪资或不限、筛选要求及每个方向的数量');
  }
  const salaryIntent = [...salaryEvidence, latestMessage].map(readSalaryIntent).filter(intent => intent !== undefined).at(-1);
  if (salaryIntent === undefined || salaryIntent === 'specified') throw new Error('薪资阈值无法明确核对，请澄清为单一数字K/月（或数字千/万/元月薪），或明确薪资不限；不能填任意salaryMinK');
  if (plan.salaryMinK === null && salaryIntent !== 'unlimited') throw new Error('salaryMinK=null仅表示用户明确薪资不限；有薪资要求须把K/月阈值填入salaryMinK，不能只写criteria，含糊时请澄清');
  if (plan.salaryMinK !== null && salaryIntent === 'unlimited') throw new Error('用户明确薪资不限，应将salaryMinK设为null，不得沿用旧阈值');
  if (typeof salaryIntent === 'number' && plan.salaryMinK !== salaryIntent) throw new Error(`salaryMinK与用户月薪阈值${salaryIntent}K不一致，请按用户要求更正`);
  const criteriaSalary = readSalaryIntent(plan.criteria);
  if (typeof criteriaSalary === 'number' && plan.salaryMinK !== criteriaSalary) throw new Error(`criteria的月薪阈值${criteriaSalary}K与salaryMinK不一致，请按用户要求更正`);
  if (criteriaSalary !== undefined && (plan.salaryMinK === null) !== (criteriaSalary === 'unlimited')) throw new Error('criteria与salaryMinK的薪资口径冲突，请同步更正，不保留旧薪资条件');
  if (new Set(plan.directions.map(d => d.name.trim())).size !== plan.directions.length) throw new Error('投递方向不能重复');
  // 只找不投不联系任何人，额度在发送草稿时再核对。
  const total = plan.directions.reduce((sum, direction) => sum + direction.count, 0);
  if (total > MAX_BATCH_TARGETS) throw new AppError('bad_request', `本批最多 ${MAX_BATCH_TARGETS} 个，请求 ${total} 个，未启动`);
  if (plan.sendNow) requireQuota(total, contactedToday);
  return plan;
}


function salaryInK(amount: string, unit: string): number {
  return Number(`${amount}e${SALARY_UNIT_EXPONENT[unit.toLowerCase()]}`);
}

function readSalaryIntent(source: string): number | 'unlimited' | 'specified' | undefined {
  let intent: number | 'unlimited' | 'specified' | undefined;
  for (const clause of source.split(/[，,。；;！？\n]/u)) {
    const text = clause.replace(/\s/gu, '');
    const relevant = /薪资|薪水|工资|月薪|年薪|日薪|时薪|待遇|\d+(?:\.\d+)?[kK](?![a-zA-Z])|元\/月/u.test(text);
    if (!relevant) continue;
    const amounts = [...text.matchAll(new RegExp(SALARY_AMOUNT, 'gu'))];
    const scalar = (amount: RegExpMatchArray) => !/[0-9kK千万元][-–—~～至]$/u.test(text.slice(0, amount.index))
      && !/^[-–—~～至]\d/u.test(text.slice(amount.index! + amount[0].length));
    const explicit = [...text.matchAll(new RegExp(`(?:上限|至少|不低于|阈值|最低|月薪|薪资|薪水|工资|待遇)(?:的|为|是|要|需|到|≥|>=|达到|要求|希望|至少|区间|范围|上限)*${SALARY_AMOUNT}`, 'gu'))].filter(scalar).at(-1);
    const amount = explicit ?? amounts.filter(scalar).at(-1);
    const unrestricted = [...text.matchAll(/(?:薪资|薪水|工资|月薪|待遇)(?:不限|不设限|不限制|无要求|没有要求|随意)|不限(?:薪资|薪水|工资|月薪|待遇)/gu)]
      .filter(match => !/(?:不是|并非|不接受|不能算)$/u.test(text.slice(0, match.index))).at(-1);
    if (unrestricted && unrestricted.index! >= (amounts.at(-1)?.index ?? -1)) intent = 'unlimited';
    else if (amount && !/年薪|日薪|时薪|\/(?:年|天|日|小时|时)/u.test(text)) intent = salaryInK(amount[1]!, amount[2]!);
    else if (intent === undefined) intent = 'specified';
  }
  return intent;
}

/** 明确不符合月薪口径才预筛；无法识别的卡片继续读取实际JD。 */
export function excludeSalaryCard(salary: string, threshold: number | null): boolean {
  if (threshold === null) return false;
  const text = salary.replace(/\s/gu, '').replace(/[·・•]\d+(?:-\d+)?薪$/u, '');
  if (/^(?:日薪|时薪)|\/(?:天|日|小时|时)$/u.test(text)) return true;
  const match = /^(?:月薪)?(\d+(?:\.\d+)?)([kK])?(?:[-–—~～至](\d+(?:\.\d+)?))?([kK]|元)(?:\/月)?$/u.exec(text);
  if (!match || match[2] && match[4] === '元' || match[4] === '元' && !text.endsWith('/月')) return false;
  const lower = Number(match[1]);
  const upper = Number(match[3] ?? match[1]);
  if (upper < lower) return false;
  return salaryInK(match[3] ?? match[1]!, match[4]!) < threshold;
}


/** 只提取用户明确的常见排除/解除排除；不从岗位页面或模型理由猜条件。 */
export function preserveExclusions(plan: SearchPlan, userSources: string[]): SearchPlan {
  const restrictions = new Map<string, boolean>();
  const directive = /(不再排除|不排除|取消排除|允许|可以|不要|不投|不考虑|不接受|排除|拒绝)(?:再|给|投递|投|找|考虑|推荐|任何|所有|我|这些|\s)*((?:猎头|中介|外包)(?:公司|岗位|职位)?(?:[、/和或及\s]+(?:猎头|中介|外包)(?:公司|岗位|职位)?)*)/gu;
  for (const source of userSources) {
    const authoritative = EXPLICIT_RESTRICTIONS.exec(source)?.[1] ?? source;
    for (const match of authoritative.matchAll(directive)) {
      const excluded = !['不再排除', '不排除', '取消排除', '允许', '可以'].includes(match[1]!);
      for (const kind of match[2]!.match(/猎头|中介|外包/gu)!) restrictions.set(kind, excluded);
    }
  }
  if (!restrictions.size) return plan;
  const explicit = [...restrictions].map(([kind, excluded]) => excluded ? `排除${kind}` : `不再排除${kind}`).join('；');
  const base = plan.criteria.replace(EXPLICIT_RESTRICTIONS, '');
  const criteria = `用户明确限制（优先于下文）：${explicit}。${base}`;
  if (criteria.length > CRITERIA_MAX_CHARS) throw new Error('筛选条件过长，请精简表述并保留用户明确排除条件');
  return { ...plan, criteria };
}
