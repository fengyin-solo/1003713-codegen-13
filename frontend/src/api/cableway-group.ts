import { listBatches, readBatchesFresh, saveBatches } from '@/data/batch-store'
import { commitAll, listRows, readFresh } from '@/data/local-store'
import type {
  CommitResult,
  EntryRow,
  MaintenanceBatch,
  RiskItem,
  RiskLevel,
} from '@/data/types'

// 编组落库只动这两个模块：缆道本体 + 巡检入口的配合待办。
export const CABLEWAY_KEY = 'cableway'
export const INSPECTION_KEY = 'inspection'

// 编组规则（已定）：不允许混合状态，同组状态必须一致，且只有这两种状态允许排期；
// 「检修中」说明已在修、「已停用」不再排。
export const SCHEDULABLE_STATUSES = ['正常运行', '需检修']

// 风险阈值集中在一处，页面展示和测试都引用这份。
export const RISK_RULES = {
  maintenanceCycleDays: 365, // 检修周期一年，超过即超期
  overdueHighDays: 730, // 超期两年升高风险
  spanMid: 120, // 跨度 ≥120m 中风险
  spanHigh: 250, // 跨度 ≥250m 高风险
  loadMid: 500, // 荷载 <500kg 中风险
  loadHigh: 300, // 荷载 <300kg 高风险
} as const

const LEVEL_ORDER: Record<RiskLevel, number> = { 未知: 0, 低: 1, 中: 2, 高: 3 }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function todayText(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function nowText(): string {
  return new Date().toISOString()
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function toDateText(value: unknown): string {
  const text = String(value ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : ''
}

function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(from)
  const b = Date.parse(to)
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return null
  }
  return Math.floor((b - a) / 86400000)
}

/** 单条缆道的跨度、荷载、超期风险。旧数据缺最近检修日时按建成日期兼容。 */
export function buildRiskItem(row: EntryRow, today: string): RiskItem {
  const span = toNumber(row['跨度米数'])
  const load = toNumber(row['荷载能力'])
  const lastMaintenance = toDateText(row['最近检修日'])
  const builtDate = toDateText(row['建成日期'])
  const 基准检修日 = lastMaintenance || builtDate
  const 基准来源: RiskItem['基准来源'] = lastMaintenance ? '最近检修日' : builtDate ? '建成日期' : '无'
  const elapsed = 基准检修日 ? daysBetween(基准检修日, today) : null
  const 超期天数 =
    elapsed === null ? null : Math.max(0, elapsed - RISK_RULES.maintenanceCycleDays)
  const 跨度风险: RiskLevel =
    span === null ? '未知' : span >= RISK_RULES.spanHigh ? '高' : span >= RISK_RULES.spanMid ? '中' : '低'
  const 荷载风险: RiskLevel =
    load === null ? '未知' : load < RISK_RULES.loadHigh ? '高' : load < RISK_RULES.loadMid ? '中' : '低'
  const 超期风险: RiskLevel =
    elapsed === null
      ? '未知'
      : elapsed > RISK_RULES.overdueHighDays
        ? '高'
        : elapsed > RISK_RULES.maintenanceCycleDays
          ? '中'
          : '低'
  const 综合风险 = ([跨度风险, 荷载风险, 超期风险] as RiskLevel[]).reduce<RiskLevel>(
    (worst, level) => (LEVEL_ORDER[level] > LEVEL_ORDER[worst] ? level : worst),
    '未知',
  )
  return {
    cablewayId: Number(row.id),
    缆道编号: String(row['缆道编号'] ?? row.id),
    跨度米数: span,
    跨度风险,
    荷载能力: load,
    荷载风险,
    基准检修日,
    基准来源,
    超期天数,
    超期风险,
    综合风险,
  }
}

export type PlanInput = {
  memberIds: number[]
  计划检修日: string
  检修人员: string
  today?: string
}

function nextBatchId(ledger: MaintenanceBatch[], today: string): string {
  const prefix = `JX${today.replace(/-/g, '')}`
  const seq = ledger.filter((batch) => batch.id.startsWith(prefix)).length + 1
  return `${prefix}-${String(seq).padStart(2, '0')}`
}

/** 编组校验 + 生成批次台账（不动业务数据）。相同站点+成员+检修日视为同一编组，直接续用。 */
export function planBatch(input: PlanInput): CommitResult {
  const today = input.today ?? todayText()
  const ids = [...new Set(input.memberIds.map(Number))]
  if (ids.length < 2) {
    return { ok: false, message: '编组至少选择 2 条缆道' }
  }
  if (!input.计划检修日) {
    return { ok: false, message: '请先选择统一排期的计划检修日' }
  }
  const rows = listRows(CABLEWAY_KEY)
  const members = ids.map((id) => rows.find((row) => Number(row.id) === id))
  const missing = ids.filter((id, index) => !members[index])
  if (missing.length > 0) {
    return { ok: false, message: `缆道编号 ${missing.join('、')} 不存在，可能已被其他入口改动` }
  }
  const units = [...new Set(members.map((row) => String(row?.['所属站点'] ?? '')))]
  if (units.length !== 1) {
    return { ok: false, message: '只允许同一所属站点（管理单位）的缆道编为一组' }
  }
  // 幂等检查要在状态校验之前：同一选择被重复提交时，缆道可能已被首次落库推进
  // 「检修中」，若先校验状态就把幂等合并误杀成「状态不允许」了。
  const idempotencyKey = [...ids].sort((a, b) => a - b).join(',') + `@${units[0]}@${input.计划检修日}`
  const ledger = readBatchesFresh()
  const existing = ledger.find((batch) => batch.idempotencyKey === idempotencyKey)
  if (existing) {
    if (existing.status === '已完成') {
      return {
        ok: false,
        duplicated: true,
        message: `该编组已生效（批次 ${existing.id}），重复提交不会再次落库`,
        batch: existing,
      }
    }
    if (existing.status === '已作废') {
      return { ok: false, message: `相同编组 ${existing.id} 已作废，请调整成员或检修日后再提交`, batch: existing }
    }
    return { ok: true, message: `已存在相同编组 ${existing.id}（${existing.status}），直接续用`, batch: existing }
  }
  const statuses = [...new Set(members.map((row) => String(row?.status ?? '')))]
  if (statuses.length !== 1) {
    return { ok: false, message: '不允许混合状态编组：所选缆道的当前状态必须一致' }
  }
  if (!SCHEDULABLE_STATUSES.includes(statuses[0])) {
    return {
      ok: false,
      message: `「${statuses[0]}」状态不允许编组排期，仅支持：${SCHEDULABLE_STATUSES.join('、')}`,
    }
  }
  const batch: MaintenanceBatch = {
    id: nextBatchId(ledger, today),
    idempotencyKey,
    管理单位: units[0],
    计划检修日: input.计划检修日,
    检修人员: input.检修人员.trim(),
    memberIds: ids,
    items: members.map((row) => ({
      cablewayId: Number(row?.id),
      缆道编号: String(row?.['缆道编号'] ?? row?.id),
      state: '待执行',
      message: '',
    })),
    riskList: members.map((row) => buildRiskItem(row as EntryRow, today)),
    inspectionTodoId: null,
    status: '待提交',
    failedStep: '',
    note: '',
    attempts: 0,
    lastError: '',
    createdAt: nowText(),
    updatedAt: nowText(),
  }
  saveBatches([...ledger, batch])
  return { ok: true, message: `编组 ${batch.id} 已生成，待提交落库`, batch }
}

function failStep(
  ledger: MaintenanceBatch[],
  working: MaintenanceBatch,
  item: { cablewayId: number; 缆道编号: string; state: string; message: string },
  message: string,
): CommitResult {
  item.state = '失败'
  item.message = message
  working.status = '失败待续做'
  working.failedStep = `缆道 ${item.缆道编号}`
  working.lastError = message
  working.updatedAt = nowText()
  // 只写台账断点，业务数据一个字节都没动过，不会留下半批。
  saveBatches(ledger.map((batch) => (batch.id === working.id ? clone(working) : batch)))
  return {
    ok: false,
    message: `批次 ${working.id} 在「${item.缆道编号}」处中断：${message}。业务数据未留下半批，可从断点续做。`,
    batch: clone(working),
  }
}

/**
 * 批次落库核心：同步、幂等、要么全成要么全不成。
 * 两个入口（编组台提交、台账续做）和跨标签页并发都汇到这一个函数。
 */
export function commitOnce(batchId: string): CommitResult {
  const fresh = readFresh()
  const ledger = readBatchesFresh()
  const batch = ledger.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到批次 ${batchId}` }
  }
  if (batch.status === '已完成') {
    return { ok: true, duplicated: true, message: `批次 ${batchId} 已生效，重复提交已被忽略`, batch }
  }
  if (batch.status === '已作废') {
    return { ok: false, message: `批次 ${batchId} 已作废，不能再落库`, batch }
  }
  // 并发场景：另一个入口已把相同编组（同站点+成员+检修日）落库，本次幂等合并，只生效一次。
  const twin = ledger.find(
    (item) => item.id !== batch.id && item.idempotencyKey === batch.idempotencyKey && item.status === '已完成',
  )
  if (twin) {
    const merged: MaintenanceBatch = {
      ...batch,
      status: '已完成',
      note: `与批次 ${twin.id} 幂等合并，未重复落库`,
      updatedAt: nowText(),
    }
    saveBatches(ledger.map((item) => (item.id === merged.id ? merged : item)))
    return { ok: true, duplicated: true, message: `相同编组已由批次 ${twin.id} 生效，本次提交幂等合并`, batch: merged }
  }

  const working = clone(batch)
  working.attempts += 1
  working.updatedAt = nowText()
  const cablewayRows = clone(fresh[CABLEWAY_KEY] ?? [])
  const inspectionRows = clone(fresh[INSPECTION_KEY] ?? [])

  // 第一步：逐条把成员缆道推进到「检修中」。是否跳过以业务现状为准（幂等），
  // 台账里的进度只用于展示断点，这样业务回滚后续做也不会漏项。
  for (const item of working.items) {
    const row = cablewayRows.find((entry) => Number(entry.id) === item.cablewayId)
    if (!row) {
      return failStep(ledger, working, item, `缆道 ${item.缆道编号} 已不存在`)
    }
    const alreadyMine = String(row['编组批次号'] ?? '') === working.id && String(row.status) === '检修中'
    if (alreadyMine) {
      item.state = '已完成'
      item.message = ''
      continue
    }
    if (!SCHEDULABLE_STATUSES.includes(String(row.status))) {
      return failStep(
        ledger,
        working,
        item,
        `缆道 ${item.缆道编号} 当前状态「${row.status}」不允许排期，可能已被其他入口改动`,
      )
    }
    const occupied = String(row['编组批次号'] ?? '')
    if (occupied && occupied !== working.id) {
      return failStep(ledger, working, item, `缆道 ${item.缆道编号} 已被批次 ${occupied} 占用`)
    }
    row.status = '检修中'
    row['缆道状态'] = '检修中'
    row['编组批次号'] = working.id
    row['计划检修日'] = working.计划检修日
    if (working.检修人员) {
      row['检修人员'] = working.检修人员
    }
    row.pending = true
    item.state = '已完成'
    item.message = ''
  }

  // 第二步：同步巡检入口的配合待办，按编组批次号查重，重复提交不会生成第二条。
  let todo = inspectionRows.find((entry) => String(entry['编组批次号'] ?? '') === working.id)
  if (!todo) {
    const newId = inspectionRows.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), 0) + 1
    todo = {
      id: newId,
      status: '待巡检',
      pending: true,
      abnormal: false,
      记录编号: `INSP-${String(newId).padStart(4, '0')}`,
      站点编号: working.管理单位,
      巡检日期: working.计划检修日,
      巡检人员: working.检修人员 || '待指派',
      检查项目: `缆道检修配合（${working.id}）`,
      发现问题: '—',
      处理措施: `配合检修编组 ${working.id}：现场安全警戒与测流中断协调`,
      巡检状态: '待巡检',
      编组批次号: working.id,
    }
    inspectionRows.push(todo)
  }
  working.inspectionTodoId = Number(todo.id)

  // 第三步：业务数据一次性整库落库——此前任一项失败都不会走到这里，不留半批。
  commitAll({ ...fresh, [CABLEWAY_KEY]: cablewayRows, [INSPECTION_KEY]: inspectionRows })

  working.status = '已完成'
  working.failedStep = ''
  working.lastError = ''
  working.note = ''
  working.updatedAt = nowText()
  saveBatches(ledger.map((entry) => (entry.id === working.id ? clone(working) : entry)))
  return {
    ok: true,
    message: `批次 ${working.id} 落库完成：${working.items.length} 条缆道进入检修中，巡检配合待办已同步（记录 ${todo['记录编号']}）`,
    batch: clone(working),
  }
}

/** 作废未完成的批次：成员被其他入口改动、续做无解时给出路。 */
export function cancelBatch(batchId: string): CommitResult {
  const ledger = readBatchesFresh()
  const batch = ledger.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到批次 ${batchId}` }
  }
  if (batch.status === '已完成') {
    return { ok: false, message: `批次 ${batchId} 已落库生效，不能作废`, batch }
  }
  const cancelled: MaintenanceBatch = { ...batch, status: '已作废', updatedAt: nowText() }
  saveBatches(ledger.map((item) => (item.id === batchId ? cancelled : item)))
  return { ok: true, message: `批次 ${batchId} 已作废`, batch: cancelled }
}

export function listBatchLedger(): MaintenanceBatch[] {
  return [...readBatchesFresh()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// ---- 并发保护：同页防重入 + 跨标签页 Web Locks 互斥 ----

const LOCK_NAME = 'hydrology-monitor-station:cableway-group-commit'
const inFlight = new Set<string>()

type LockManagerLike = { request: (name: string, callback: () => unknown) => Promise<unknown> }

function lockManager(): LockManagerLike | undefined {
  if (typeof navigator === 'undefined') {
    return undefined
  }
  return (navigator as { locks?: LockManagerLike }).locks
}

async function runExclusive(key: string, task: () => CommitResult): Promise<CommitResult | null> {
  if (inFlight.has(key)) {
    return null
  }
  inFlight.add(key)
  try {
    const locks = lockManager()
    if (locks) {
      return (await locks.request(LOCK_NAME, task)) as CommitResult
    }
    return task()
  } finally {
    inFlight.delete(key)
  }
}

/** 编组台提交入口：编组（或续用相同编组）后落库。 */
export async function submitBatch(input: PlanInput): Promise<CommitResult> {
  try {
    const planned = planBatch(input)
    if (!planned.ok || !planned.batch) {
      return planned
    }
    const batchId = planned.batch.id
    const result = await runExclusive(batchId, () => commitOnce(batchId))
    if (result === null) {
      return { ok: false, message: `批次 ${batchId} 正在提交中，请勿重复操作`, batch: planned.batch }
    }
    return result
  } catch (error) {
    return { ok: false, message: `编组落库异常：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 台账续做入口：从断点接着落库，已生效的步骤自动跳过。 */
export async function resumeBatch(batchId: string): Promise<CommitResult> {
  try {
    const result = await runExclusive(batchId, () => commitOnce(batchId))
    if (result === null) {
      return { ok: false, message: `批次 ${batchId} 正在提交中，请勿重复操作` }
    }
    return result
  } catch (error) {
    return { ok: false, message: `断点续做异常：${error instanceof Error ? error.message : String(error)}` }
  }
}
