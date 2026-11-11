/** 对话动作只接受最新用户消息的逐字引用；配额和参数由程序校验。 */
import { DAILY_CONTACT_LIMIT, MAX_BATCH_TARGETS } from './contracts.ts';
import { AppError } from './errors.ts';
import { SUPPORTED_CITIES } from './boss.ts';

export interface DeliveryDirection { name: string; keywords: string[]; count: number }
/** 卡片学历标签的门槛：from 及以上的明确要求不投。 */
export const DEGREE_LIMITS = ['硕士', '博士'] as const;
export type DegreeLimit = { from: typeof DEGREE_LIMITS[number]; quote: string };
export interface SearchPlan {
  city: string;
  /** 月薪区间上限须达到的阈值，单位K/月；null只表示用户明确不限。 */
  salaryMinK: number | null;
  criteria: string;
  sendNow: boolean;
  quote: string;
  directions: DeliveryDirection[];
  /** 当前保存要求指定的求职方向标签；有值时只读该推荐流，不搜索补充。 */
  recommendationTab?: string;
  /** 指定推荐标签时，站点明确本轮推荐用尽后是否按关键词搜索补充；只由用户要求中的「推荐耗尽后搜索补充：允许」决定。 */
  searchAfterExhausted?: boolean;
  /** 用户原文点名不投的公司；卡片公司名包含其一即不打开详情。旧计划没有该字段视为无。 */
  excludedCompanies?: string[];
  /** 用户原文的学历门槛；只按卡片独立学历标签判断，缺失或不可识别不排除。 */
  degreeLimit?: DegreeLimit | null;
}
export const MAX_SEARCH_KEYWORDS = 20;
const CRITERIA_MAX_CHARS = 10_000;
const SALARY_UNIT_EXPONENT: Readonly<Record<string, number>> = { k: 0, '千': 0, '万': 1, '元': -3 };
const SALARY_AMOUNT = String.raw`(\d+(?:\.\d+)?)([kK](?![a-zA-Z])|千|万|元)`;
const MAX_DIRECTIONS = 20;
const EXPLICIT_RESTRICTIONS = /^用户明确限制（优先于下文）：([^。]*)。/u;
const MAX_EXCLUDED_COMPANIES = 20;
const COMPANY_MAX_CHARS = 40;
const DEGREE_ORDER = ['学历不限', '初中及以下', '中专/中技', '高中', '大专', '本科', '硕士', '博士'];

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
    excludedCompanies: { type: 'array', maxItems: MAX_EXCLUDED_COMPANIES, items: { type: 'string' }, description: '用户原文点名不投的公司或品牌名，逐字取自用户要求或消息；没有则为空数组。卡片公司名包含其一即跳过。' },
    degreeLimit: { type: ['object', 'null'], properties: { from: { type: 'string', enum: DEGREE_LIMITS }, quote: { type: 'string' } }, required: ['from', 'quote'], additionalProperties: false,
      description: '用户明确不投「from及以上学历要求」岗位时填写，quote逐字引用该用户原文；硕士优先等非硬要求或未提及时为null。' },
    directions: { type: 'array', minItems: 1, maxItems: MAX_DIRECTIONS, items: {
      type: 'object', properties: { name: { type: 'string' }, keywords: { type: 'array', minItems: 1, maxItems: MAX_SEARCH_KEYWORDS, items: { type: 'string' } }, count: { type: 'integer', minimum: 1, maximum: MAX_BATCH_TARGETS } },
      required: ['name', 'keywords', 'count'], additionalProperties: false,
    } },
  }, required: ['city', 'salaryMinK', 'criteria', 'sendNow', 'quote', 'directions', 'excludedCompanies', 'degreeLimit'], additionalProperties: false,
};

/** 点名不投的一家公司：name 为主名，aliases 为括号内别名。 */
type CompanyGroup = { name: string; aliases: string[] };

/** 用户要求与消息里的卡片策略：点名不投的公司（含括号别名）与学历门槛。按来源先后处理，后出现的解除优先。 */
export type CardPolicy = {
  /** 应填的全部名称：主名与别名。 */
  companies: string[];
  groups: CompanyGroup[];
  degree: { from: DegreeLimit['from']; clause: string } | null;
};

/** 「不投递」「只找不投」不是名单：「不投」后须紧跟名称或前面列出名称。 */
const COMPANY_BLOCK = /一律不投|不要投|不投(?!递)|屏蔽|黑名单/u;
const COMPANY_LIFT = /允许|可以投|可投|也投|不再屏蔽|不再排除|解除|恢复投/u;
/** 这些子句属于学历或中间方规则，由各自规则处理，不解析成公司名。 */
const NOT_COMPANY_CLAUSE = /学历|硕士|博士|本科|大专|猎头|外包|中介|代招/u;
/** 只按整词排除指代与标签（「这是具体公司黑名单」），不按首字排除，避免误伤「先声药业」「此芯科技」等品牌。 */
const NOT_COMPANY_NAME = /^(?:(?:这是|这类|这些|上述|以下|该|此|这)+(?:具体)?|具体|用户明确|公司)$|招聘主体|名称|屏蔽|黑名单|^.?$/u;
/** 只识别完整的只找不投动作，不用任务词裁剪公司名。 */
const READ_ONLY_INTENT = /^(?:(?:今天|今日|这次|本次|本轮|这轮)\s*)?(?:只找|先找|只看|先看|只搜|先存草稿|存草稿|暂时)不投$/u;
/** 无分隔的时间限定无法可靠划定品牌边界，要求改用显式名单标签，绝不删除前缀。 */
const AMBIGUOUS_PREFIX = /^(?:今天|这次|本次|此次|本轮|这轮|目前|这周|本周)/u;
/** 只剩这些通用词时不能当作公司名，否则会误拦大量无关公司。 */
const GENERIC_NAME = /^(?:国际|科技|集团|软件|网络|信息|技术|数字|智能|控股|实业|股份|有限|中国|北京|上海|深圳|广州|杭州)+$/u;
/** 「和/与/及」可能是名单连接词，也可能是品牌的一部分（中和软件、北京和利时）；无法区分，要求澄清。 */
const NAME_CONNECTOR = /和|与|及/u;
/** 括号里「及带X名称的招聘主体」是对包含匹配的说明，不是别名。 */
const ALIAS_NOTE = /(?:及|以及|和)?带[^、，,）)]*名称的招聘主体/gu;
/** 名称尾部的「公司/的岗位」等不是名称本身。 */
const NAME_SUFFIX = /(?:的)?(?:岗位|职位|招聘|公司)$/u;
const DEGREE_BLOCK = /不要投|不投|拒绝|不接受|不考虑|跳过|(?<![不此])排除|不要(?!求)/u;
const DEGREE_LIFT = /可以投|也投|允许|不再排除|不限学历/u;

const subClauses = (text: string) => text.split(/[。；;\n]/u).flatMap(sentence => sentence.split(/[，,](?![^（(]*[）)])/u)).map(part => part.trim()).filter(Boolean);
const cleanName = (name: string) => { let text = name.trim(); while (NAME_SUFFIX.test(text)) text = text.replace(NAME_SUFFIX, '').trim(); return text; };
const validName = (name: string) => name.length <= COMPANY_MAX_CHARS && !NOT_COMPANY_NAME.test(name);

/**
 * 「标签：A（含a1、a2及…）、B（…）一律不投」「黑名单：A、B」或「不投A」：顶层按顿号分项，括号内为别名。
 * 不是名单指令（「今天只找不投」）时返回 null。
 */
function blockedGroups(clause: string): CompanyGroup[] | null {
  // 以最后一个屏蔽动词为界；动词后紧跟冒号（「公司黑名单：A」）或前面没有名称时，名单在动词之后。
  const verb = [...clause.matchAll(new RegExp(COMPANY_BLOCK.source, 'gu'))].at(-1)!;
  const after = clause.slice(verb.index! + verb[0].length);
  const before = clause.slice(0, verb.index).split(/[：:]/u).at(-1)!.trim();
  const listAfter = /^\s*(?:公司)?[：:]/u.test(after) || !before;
  if (READ_ONLY_INTENT.test(clause)) return null;
  const list = listAfter ? after.replace(/^\s*(?:公司[：:]|[：:])?\s*/u, '') : before;
  if (!listAfter && !/[：:]/u.test(clause) && AMBIGUOUS_PREFIX.test(list)) {
    throw new Error('公司名与时间限定缺少明确边界，请澄清为「屏蔽公司：完整公司名」，不会自动删除名称前缀');
  }
  if (!list.trim()) return null;
  const items: string[] = [];
  let depth = 0, current = '';
  for (const char of list) {
    if ('（('.includes(char)) depth++;
    if ('）)'.includes(char)) depth--;
    if (/[、/]/u.test(char) && depth === 0) { items.push(current); current = ''; } else current += char;
  }
  items.push(current);
  return items.map(item => {
    const name = cleanName(item.replace(/[（(][^）)]*[）)]/gu, ''));
    const aliases = [...item.matchAll(/[（(]([^）)]*)[）)]/gu)]
      .flatMap(match => match[1]!.replace(ALIAS_NOTE, '').replace(/^\s*(?:含|包括)/u, '').split(/[、，,]/u)).map(cleanName).filter(validName);
    const generic = [name, ...aliases].find(alias => GENERIC_NAME.test(alias));
    if (generic) throw new Error(`「${generic}」是通用词，不能作为公司名排除；请向用户澄清具体公司名称后再开始`);
    const ambiguous = [name, ...aliases].find(alias => NAME_CONNECTOR.test(alias));
    if (ambiguous) throw new Error(`公司名「${ambiguous}」里的「和/与/及」无法判断是两家公司还是品牌的一部分；请向用户澄清（多家请用顿号分隔）后再开始`);
    return { name, aliases };
  }).filter(group => validName(group.name));
}

const groupNames = (group: CompanyGroup) => [group.name, ...group.aliases];

export function cardPolicy(sources: string[]): CardPolicy {
  let groups: CompanyGroup[] = [];
  let degree: CardPolicy['degree'] = null;
  for (const clause of sources.flatMap(subClauses)) {
    if (/硕士|博士/u.test(clause) && !/优先/u.test(clause)) {
      if (DEGREE_LIFT.test(clause)) degree = null;
      else if (DEGREE_BLOCK.test(clause)) degree = { from: clause.includes('硕士') ? '硕士' : '博士', clause };
      continue;
    }
    const lower = clause.toLowerCase();
    if (COMPANY_LIFT.test(clause)) { groups = groups.filter(group => !groupNames(group).some(alias => lower.includes(alias.toLowerCase()))); continue; }
    if (NOT_COMPANY_CLAUSE.test(clause) || !COMPANY_BLOCK.test(clause)) continue;
    const found = blockedGroups(clause);
    if (found === null) continue;
    // 名单指令认得出但名称识别不出时，不能当作没有限制；已有名单时视为对前文名单的指代（「这是具体公司黑名单」）。
    if (!found.length && !groups.length) throw new Error(`无法识别「${clause}」中要排除的公司名；请向用户澄清具体公司名称后再开始`);
    for (const group of found) {
      const previous = groups.find(existing => existing.name.toLowerCase() === group.name.toLowerCase());
      const aliases = [...new Map([...(previous?.aliases ?? []), ...group.aliases].map(alias => [alias.toLowerCase(), alias])).values()];
      groups = [...groups.filter(existing => existing !== previous), { name: group.name, aliases }];
    }
  }
  return { companies: [...new Map(groups.flatMap(groupNames).map(alias => [alias.toLowerCase(), alias])).values()], groups, degree };
}

/** 计划的卡片字段必须与当前要求推导的策略完全一致：缺漏、只填部分别名、多填或沿用已解除的限制都拒绝，让模型按提示纠正。 */
function readCardRules(plan: SearchPlan, sources: string[]): void {
  const policy = cardPolicy(sources);
  const companies = plan.excludedCompanies ?? [];
  const given = Array.isArray(companies) && companies.every(name => typeof name === 'string') ? new Set(companies.map(name => name.trim().toLowerCase())) : null;
  const expected = new Set(policy.companies.map(name => name.toLowerCase()));
  const complete = given !== null && given.size === expected.size && [...expected].every(name => given.has(name));
  if (!complete) {
    throw new Error(`excludedCompanies须与当前要求中明确不投的公司及全部别名一致，应为${JSON.stringify(policy.companies)}`);
  }
  const degree = plan.degreeLimit ?? null;
  const expectedDegree = policy.degree ? JSON.stringify({ from: policy.degree.from, quote: policy.degree.clause }) : 'null';
  if (!policy.degree) {
    if (degree !== null) throw new Error('degreeLimit须为null：当前要求没有明确不投某学历要求，或已解除');
    return;
  }
  const sourceText = sources.join('\n');
  if (!degree || degree.from !== policy.degree.from || typeof degree.quote !== 'string' || !degree.quote.trim() || !sourceText.includes(degree.quote)
    || !degree.quote.includes(degree.from) || !DEGREE_BLOCK.test(degree.quote)) {
    throw new Error(`degreeLimit须逐字引用当前要求中不投该学历的原文，应为${expectedDegree}`);
  }
}

export function readSearchPlan(value: unknown, latestMessage: string, contactedToday: number, salaryEvidence: string[] = [], ruleSources: string[] = []): SearchPlan {
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
  const sources = [...ruleSources, latestMessage];
  readCardRules(plan, sources);
  const recommendation = sources.flatMap(source => [...source.matchAll(/推荐来源[：:]\s*([^\n。；]+)/gu)]).at(-1)?.[1]?.trim();
  plan.recommendationTab = recommendation;
  // 是否在推荐用尽后搜索只由用户要求或消息决定，覆盖模型给出的任何值；最后出现的一行为准。
  plan.searchAfterExhausted = sources.flatMap(source => [...source.matchAll(/推荐耗尽后搜索补充[：:]\s*([^\n。；]+)/gu)]).at(-1)?.[1]?.trim() === '允许';
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


export type CardRejection = { category: '薪资不足' | '用户明确条件' | '外包/猎头/中介'; rule: '薪资' | '学历' | '公司黑名单' | '匿名雇主' | '卡片标识'; evidence: string };

/** 计划规范前缀里明确排除的中间方。 */
function excludedIntermediaries(criteria: string): Set<string> {
  const explicit = EXPLICIT_RESTRICTIONS.exec(criteria)?.[1] ?? '';
  return new Set([...explicit.matchAll(/(?<!不再)排除(猎头|中介|外包)/gu)].map(match => match[1]!));
}

const MARKER_KINDS: [RegExp, string][] = [[/猎头|代招/u, '猎头'], [/外包|派遣/u, '外包'], [/中介/u, '中介']];

/**
 * 推荐与搜索共用的确定性卡片预筛，只看卡片上的独立字段：薪资、公司名、学历标签、站点匿名标记与职位标识图标。
 * 缺字段或无法识别时不排除，交给实际JD判定。
 */
/** 标题明确写「外包岗/外包岗位」视同外包标识；前面带非/不是/无/没的否定不算。不做关键词推测。 */
const titleSaysOutsourced = (title: string) => [...title.matchAll(/外包岗/gu)].some(match => !/[非不无没]是?$/u.test(title.slice(Math.max(0, match.index! - 2), match.index)));

export function rejectCard(card: { salary: string; company: string; title?: string; degree?: string; anonymous?: boolean; markers?: string[] }, plan: SearchPlan): CardRejection | null {
  if (excludeSalaryCard(card.salary, plan.salaryMinK)) return { category: '薪资不足', rule: '薪资', evidence: card.salary };
  const company = card.company.toLowerCase();
  const brand = (plan.excludedCompanies ?? []).find(name => company.includes(name.trim().toLowerCase()));
  if (brand) return { category: '用户明确条件', rule: '公司黑名单', evidence: brand };
  const limit = plan.degreeLimit;
  if (limit && card.degree && DEGREE_ORDER.indexOf(card.degree) >= DEGREE_ORDER.indexOf(limit.from)) return { category: '用户明确条件', rule: '学历', evidence: card.degree };
  const excluded = excludedIntermediaries(plan.criteria);
  if (card.anonymous && excluded.has('猎头')) return { category: '外包/猎头/中介', rule: '匿名雇主', evidence: '站点标记为匿名公司' };
  for (const marker of card.markers ?? []) {
    const kind = MARKER_KINDS.find(([pattern]) => pattern.test(marker))?.[1];
    if (kind && excluded.has(kind)) return { category: '外包/猎头/中介', rule: '卡片标识', evidence: marker };
  }
  if (excluded.has('外包') && card.title && titleSaysOutsourced(card.title)) return { category: '外包/猎头/中介', rule: '卡片标识', evidence: card.title };
  return null;
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
