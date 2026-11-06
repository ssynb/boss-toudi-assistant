import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardPolicy, readSearchPlan, rejectCard } from '../src/search-plan.ts';

const latest = '深圳后端10个，薪资不限，开始';
const base = { city: '深圳', salaryMinK: null, criteria: '后端', sendNow: false, quote: '开始', degreeLimit: null, directions: [{ name: '后端', keywords: ['后端'], count: 10 }] };
const accepts = (text: string, excludedCompanies: string[]) => readSearchPlan({ ...base, excludedCompanies }, latest, 0, ['薪资不限'], [text]);
const card = (company: string) => ({ company, salary: '20-30K' });

// 第2轮审查反例与上一轮已修表达同一回归集：解析、计划接收与卡片预筛一起核对。
for (const [text, expected, blocked, allowed] of [
  ['不要投软通动力公司', ['软通动力'], '软通动力信息', '软通智慧'],
  ['不投软通动力', ['软通动力'], '软通动力信息', '软通智慧'],
  ['公司黑名单：软通动力', ['软通动力'], '软通动力信息', '软通智慧'],
  ['软通动力不投', ['软通动力'], '软通动力信息', '软通智慧'],
  ['外企德科不投', ['外企德科'], '外企德科数字', '德科智能'],
  ['用户明确公司屏蔽：软通动力（含isoftstone及带软通动力名称的招聘主体）一律不投', ['软通动力', 'isoftstone'], 'iSoftStone深圳', '软通智慧'],
  ['今天只找不投', [], null, '今天科技'],
  ['这次只找不投，先存草稿', [], null, '这次科技'],
] as const) test(`公司名单解析：${text}`, () => {
  assert.deepEqual(cardPolicy([text]).companies, expected);
  const plan = accepts(text, [...expected]);
  if (blocked) assert.equal(rejectCard(card(blocked), plan)?.rule, '公司黑名单');
  assert.equal(rejectCard(card(allowed), plan), null, `${allowed} 不能被误伤`);
});

// 第3轮审查：「和/与/及」分不清是名单连接还是品牌一部分。拆开会产生「软件」「北京」这类碎片误伤无关公司，
// 拼接整名又会让两家都不生效；两种都不能接受，主名与括号别名一样，必须阻止开始并要求澄清。
for (const text of ['不投北京和利时公司', '公司黑名单：甲方科技（含中和软件）', '屏蔽软通动力和中软国际的岗位', '不投中和软件', '不投万和公司']) {
  test(`含连接字的公司名要求澄清，不能以碎片、拼接整名或空名单通过：${text}`, () => {
    assert.throws(() => cardPolicy([text]), /澄清/);
    for (const companies of [[], ['软件'], ['北京', '利时'], ['软通动力和中软国际'], ['软通动力', '中软国际'], ['甲方科技']]) {
      assert.throws(() => accepts(text, companies), /澄清/, JSON.stringify(companies));
    }
  });
}
