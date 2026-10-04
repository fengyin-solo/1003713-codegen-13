/* eslint-disable */
// 检修编组台核心逻辑验证：风险评估、旧数据兜底、原子回滚、断点续做、幂等/并发去重。
// 纯前端项目没有后端，这里用内存 localStorage 垫片直接跑数据层与服务层。
const store = new Map<string, string>()
globalThis.window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
} as unknown as Window & typeof globalThis

import { listRows } from '../src/data/local-store'
import {
  assessAll,
  commitGroup,
  effectiveInspectDate,
  exportRiskCsv,
  listGroupsByStatus,
  listUnitGroups,
  saveDraft,
  summarizeRisks,
} from '../src/api/maintenance-service'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

const NOW = new Date(2026, 9, 4) // 2026-10-04，与当前日期一致

console.log('1) 风险评估与旧数据兜底')
const risks = assessAll(NOW)
const r1 = risks.find((r) => r.cableNo === 'CABL-0001')!
const r3 = risks.find((r) => r.cableNo === 'CABL-0003')!
const r4 = risks.find((r) => r.cableNo === 'CABL-0004')!
const r5 = risks.find((r) => r.cableNo === 'CABL-0005')!
check('低跨度低荷载近期检修 => 低风险', r1.level === '低', r1.level)
check('420m 跨度+0.8t 荷载 => 高风险', r3.level === '高' && r3.spanRisk === '高' && r3.loadRisk === '高')
check('缺检修日回退建成日期并标记', r4.inspectDateFallback === true && r4.effectiveInspectDate === '2018-07-08')
check('回退后超期>365天 => 超期高风险', r4.overdueRisk === '高' && r4.level === '高')
check('520m/1.2t/超期组合 => 高风险', r5.level === '高')
const summary = summarizeRisks(risks)
console.log('   风险分布:', JSON.stringify(summary))

console.log('2) 同单位归组，已停用排除')
const units = listUnitGroups(NOW)
const xz = units.find((u) => u.unit === '湘中水文水资源勘测中心')!
check('湘中单位含 1/2/3/4 四条缆道', JSON.stringify(xz.cableIds) === JSON.stringify([1, 2, 3, 4]), JSON.stringify(xz.cableIds))
check('已停用 CABL-0007 不参与编组', !xz.cableIds.includes(7))

console.log('3) 跨单位混编被拒')
let rejected = false
try {
  saveDraft({ unit: '湘中水文水资源勘测中心', cableIds: [1, 6], planDate: '2026-10-20', crew: '周建国', note: '' }, NOW)
} catch (e) {
  rejected = true
}
check('跨单位勾选抛错', rejected)

console.log('4) 故障演练：首提失败 → 无半批 → 断点续做 → 成功且待办不重复')
const beforeCables = JSON.parse(JSON.stringify(listRows('cableway')))
const beforeInspectionCount = listRows('inspection').length
const group = saveDraft(
  { unit: '湘中水文水资源勘测中心', cableIds: [1, 2, 3, 4], planDate: '2026-10-20', crew: '周建国班组', note: '汛后集中检修' },
  NOW,
)
const failRes = await commitGroup(group.id, { now: NOW, attempt: 1, fault: { failAttempt: 1, failIndex: 2 } })
check('失败返回 ok=false', failRes.group.result?.ok === false)
check('失败后缆道数据与提交前完全一致（无半批）', JSON.stringify(listRows('cableway')) === JSON.stringify(beforeCables))
check('失败后巡检待办一条未增（无半批）', listRows('inspection').length === beforeInspectionCount)
const failedGroup = listGroupsByStatus('failed').find((g) => g.id === group.id)!
check('断点停在第 2 项（下标0/1已准备）', failedGroup.progress === 2 && (failedGroup.plans?.length ?? 0) === 2)

const resumeRes = await commitGroup(group.id, { now: NOW, attempt: 2, fault: { failAttempt: 1, failIndex: 2 } })
check('断点续做后提交成功', resumeRes.group.status === 'committed')
check('进度推进到 4', resumeRes.group.progress === 4)
const afterTodos = listRows('inspection').filter((r) => r['来源编组'] === group.id)
check('巡检入口只新增 4 条配合待办（续做未重复生成）', afterTodos.length === 4, String(afterTodos.length))
check('待办状态为待巡检且携带排期信息', afterTodos.every((t) => t.status === '待巡检' && t['巡检日期'] === '2026-10-20'))
const updatedCables = listRows('cableway').filter((c) => [1, 2, 3, 4].includes(Number(c.id)))
check('缆道统一排期：记录编组与计划检修日', updatedCables.every((c) => c['检修编组'] === group.id && c['计划检修日'] === '2026-10-20'))
check('检修中缆道不回退状态（CABL-0003 仍检修中）', updatedCables.find((c) => Number(c.id) === 3)!.status === '检修中')
check('正常/需检修缆道统一标记为需检修', updatedCables.filter((c) => Number(c.id) !== 3).every((c) => c.status === '需检修'))

console.log('5) 幂等：已提交组重复提交只生效一次')
const dupRes = await commitGroup(group.id, { now: NOW })
check('重复提交不新增待办', listRows('inspection').filter((r) => r['来源编组'] === group.id).length === 4)
check('重复提交返回已生效组', dupRes.group.id === group.id && dupRes.group.status === 'committed')

console.log('6) 两个入口并发提交（同 tick），只放行一次')
const g2 = saveDraft(
  { unit: '粤西水文测报中心', cableIds: [5, 6], planDate: '2026-10-25', crew: '陈伟明班组', note: '' },
  NOW,
)
const [a, b] = await Promise.all([
  commitGroup(g2.id, { now: NOW }),
  commitGroup(g2.id, { now: NOW }),
])
check('并发结果一个生效一个去重', (a.group.result?.deduped ?? false) !== (b.group.result?.deduped ?? false))
const g2Todos = listRows('inspection').filter((r) => r['来源编组'] === g2.id)
check('并发后只生成 2 条待办（只生效一次）', g2Todos.length === 2, String(g2Todos.length))

console.log('7) 同指纹跨草稿提交：已有生效组则去重')
const g3 = saveDraft(
  { unit: '粤西水文测报中心', cableIds: [6, 5], planDate: '2026-10-25', crew: '陈伟明班组', note: '另一入口' },
  NOW,
)
const twinRes = await commitGroup(g3.id, { now: NOW })
check('同指纹组返回 deduped', twinRes.group.result?.deduped === true)
check('未再新增待办', listRows('inspection').filter((r) => r['来源编组'] === g2.id).length === 2)

console.log('8) 风险清单 CSV 可导出')
const csv = exportRiskCsv(resumeRes.risks)
check('CSV 含表头与 4 条成员', csv.content.split('\n').length === 5)
check('CSV 含高风险与兜底说明', csv.content.includes('高') && csv.content.includes('已按建成日期兼容计算'))
check('CSV 文件名带“跨度荷载风险清单”', csv.filename.includes('跨度荷载风险清单'))

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
