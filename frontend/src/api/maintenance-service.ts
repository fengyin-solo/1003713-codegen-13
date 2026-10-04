import { commitRows, listRows, saveRows } from '@/data/local-store'
import type {
  CableRisk,
  CommitReport,
  FaultInjection,
  GroupStatus,
  MaintenanceGroup,
  PreparedItem,
  RiskLevel,
  RiskSummary,
  UnitGroupOption,
} from '@/data/maintenance-types'
import type { EntryRow } from '@/data/types'

// 检修编组与巡检配合待办都落在这两个业务集合上；组台账放在独立集合，
// 但「缆道 + 待办」的真正生效只在 commitRows 一次批次写入里完成（原子，不留半批）。
const CABLEWAY_KEY = 'cableway'
const INSPECTION_KEY = 'inspection'
const GROUP_KEY = 'maintenance-group'

const UNIT_UNKNOWN = '未归属单位'

// 风险阈值（规则集中在这里，页面和导出共用同一份口径）。
const SPAN_HIGH = 400
const SPAN_MED = 200
const LOAD_LOW = 1
const LOAD_MED = 2.5
const DAYS_HIGH = 365
const DAYS_MED = 180

const LEVEL_ORDER: Record<RiskLevel, number> = { 低: 0, 中: 1, 高: 2 }

function todayText(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** 从「350米」「1.5t」这类字段里取出数字；非法/缺失返回 null。 */
export function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const matched = value.match(/-?\d+(\.\d+)?/)
    if (matched) {
      const n = Number(matched[0])
      return Number.isFinite(n) ? n : null
    }
  }
  return null
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null
  }
  const matched = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!matched) {
    return null
  }
  const d = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime()
  return Math.floor(ms / 86_400_000)
}

/** 旧数据兼容：最近检修日缺失或不是合法日期时，按建成日期兜底，并标记 fallback。 */
export function effectiveInspectDate(row: EntryRow): { date: string; fallback: boolean } {
  const inspect = parseDate(row['最近检修日'])
  if (inspect) {
    return { date: String(row['最近检修日']), fallback: false }
  }
  const built = parseDate(row['建成日期'])
  return built ? { date: String(row['建成日期']), fallback: true } : { date: '', fallback: true }
}

const stationCache = new Map<string, string>()

/** 缆道所属单位：缆道本身没有单位字段，经「所属站点 = 站点名称」关联到监测站点的管理单位。 */
export function unitOfCableway(row: EntryRow): string {
  const stationName = String(row['所属站点'] ?? '').trim()
  if (!stationName) {
    return UNIT_UNKNOWN
  }
  const cached = stationCache.get(stationName)
  if (cached !== undefined) {
    return cached
  }
  const station = listRows('station').find(
    (item) => String(item['站点名称'] ?? '').trim() === stationName,
  )
  const unit = station ? String(station['管理单位'] ?? '').trim() || UNIT_UNKNOWN : UNIT_UNKNOWN
  stationCache.set(stationName, unit)
  return unit
}

function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b
}

/** 单条缆道的跨度、荷载、检修超期风险评估。 */
export function assessCable(row: EntryRow, now: Date = new Date()): CableRisk {
  const span = parseNumber(row['跨度米数'])
  const load = parseNumber(row['荷载能力'])
  const inspect = effectiveInspectDate(row)

  const spanRisk: RiskLevel =
    span === null ? '高' : span >= SPAN_HIGH ? '高' : span >= SPAN_MED ? '中' : '低'
  const loadRisk: RiskLevel =
    load === null ? '高' : load < LOAD_LOW ? '高' : load < LOAD_MED ? '中' : '低'

  let overdueRisk: RiskLevel = '低'
  let days: number | null = null
  const inspectDate = parseDate(inspect.date)
  if (!inspectDate) {
    overdueRisk = '高'
  } else {
    days = daysBetween(inspectDate, now)
    overdueRisk = days > DAYS_HIGH ? '高' : days > DAYS_MED ? '中' : '低'
  }

  const level = maxLevel(maxLevel(spanRisk, loadRisk), overdueRisk)
  const reasons: string[] = []
  if (span === null) reasons.push('跨度数据缺失，按高风险管控')
  else if (spanRisk === '高') reasons.push(`跨度 ${span}m ≥ ${SPAN_HIGH}m`)
  else if (spanRisk === '中') reasons.push(`跨度 ${span}m ≥ ${SPAN_MED}m`)
  if (load === null) reasons.push('荷载能力缺失，按高风险管控')
  else if (loadRisk === '高') reasons.push(`荷载 ${load}t < ${LOAD_LOW}t`)
  else if (loadRisk === '中') reasons.push(`荷载 ${load}t < ${LOAD_MED}t`)
  if (overdueRisk === '高')
    reasons.push(days === null ? '检修日期缺失，按超期高风险管控' : `距最近检修 ${days} 天 > ${DAYS_HIGH} 天`)
  else if (overdueRisk === '中') reasons.push(`距最近检修 ${days} 天 > ${DAYS_MED} 天`)
  if (inspect.fallback) reasons.push('最近检修日缺失，已按建成日期兼容计算')
  if (reasons.length === 0) reasons.push('跨度、荷载与检修周期均在安全范围')

  return {
    row,
    cableNo: String(row['缆道编号'] ?? ''),
    station: String(row['所属站点'] ?? ''),
    unit: unitOfCableway(row),
    spanMeters: span,
    loadTonnes: load,
    effectiveInspectDate: inspect.date,
    inspectDateFallback: inspect.fallback,
    daysSinceInspect: days,
    spanRisk,
    loadRisk,
    overdueRisk,
    level,
    reasons,
  }
}

export function assessAll(now: Date = new Date()): CableRisk[] {
  return listRows(CABLEWAY_KEY).map((row) => assessCable(row, now))
}

export function summarizeRisks(risks: CableRisk[]): RiskSummary {
  return {
    high: risks.filter((item) => item.level === '高').length,
    medium: risks.filter((item) => item.level === '中').length,
    low: risks.filter((item) => item.level === '低').length,
  }
}

// 混合状态策略：允许「正常运行 / 需检修 / 检修中」混合编组，「已停用」不得编入。
const GROUPABLE_STATUSES = new Set(['正常运行', '需检修', '检修中'])

export function isGroupable(row: EntryRow): boolean {
  return GROUPABLE_STATUSES.has(String(row.status))
}

export function notGroupableReason(row: EntryRow): string {
  return String(row.status) === '已停用' ? '已停用缆道不允许编入检修组' : `状态「${row.status}」不允许编组`
}

/** 可编组缆道按管理单位归组，供页面下拉选择。 */
export function listUnitGroups(now: Date = new Date()): UnitGroupOption[] {
  const map = new Map<string, number[]>()
  for (const risk of assessAll(now)) {
    if (!isGroupable(risk.row)) {
      continue
    }
    const ids = map.get(risk.unit) ?? []
    ids.push(Number(risk.row.id))
    map.set(risk.unit, ids)
  }
  return [...map.entries()]
    .map(([unit, cableIds]) => ({ unit, cableIds: cableIds.sort((a, b) => a - b) }))
    .sort((a, b) => a.unit.localeCompare(b.unit, 'zh-Hans-CN'))
}

// ---- 编组台账 -------------------------------------------------------------

function listGroups(): MaintenanceGroup[] {
  return listRows(GROUP_KEY) as unknown as MaintenanceGroup[]
}

function saveGroups(groups: MaintenanceGroup[]): void {
  saveRows(GROUP_KEY, groups as unknown as EntryRow[])
}

export function getGroup(id: string): MaintenanceGroup | undefined {
  return listGroups().find((group) => group.id === id)
}

export function listGroupsByStatus(status?: GroupStatus): MaintenanceGroup[] {
  const groups = listGroups().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return status ? groups.filter((group) => group.status === status) : groups
}

export function fingerprintOf(unit: string, cableIds: number[], planDate: string): string {
  return `${unit}::${[...cableIds].sort((a, b) => a - b).join('-')}::${planDate}`
}

function nextGroupSeq(): number {
  return listGroups().length + Math.floor(Math.random() * 1000) + 1
}

export type SaveDraftInput = {
  unit: string
  cableIds: number[]
  planDate: string
  crew: string
  note: string
}

function validateSelection(input: SaveDraftInput): { ok: true; risks: CableRisk[] } | { ok: false; message: string } {
  if (!input.unit.trim()) {
    return { ok: false, message: '请选择管理单位' }
  }
  if (input.cableIds.length === 0) {
    return { ok: false, message: '请至少勾选一条同单位缆道' }
  }
  if (!input.planDate) {
    return { ok: false, message: '请选择计划检修日期' }
  }
  const risks = assessAll().filter((risk) => input.cableIds.includes(Number(risk.row.id)))
  if (risks.length !== input.cableIds.length) {
    return { ok: false, message: '勾选的缆道中有不存在的记录，请刷新后重试' }
  }
  const otherUnit = risks.find((risk) => risk.unit !== input.unit)
  if (otherUnit) {
    return { ok: false, message: `缆道 ${otherUnit.cableNo} 不属于「${input.unit}」，不能跨单位混编` }
  }
  const stopped = risks.find((risk) => !isGroupable(risk.row))
  if (stopped) {
    return { ok: false, message: `缆道 ${stopped.cableNo}：${notGroupableReason(stopped.row)}` }
  }
  return { ok: true, risks }
}

export function saveDraft(input: SaveDraftInput, now: Date = new Date()): MaintenanceGroup {
  const checked = validateSelection(input)
  if (!checked.ok) {
    throw new Error(checked.message)
  }
  const stamp = now.toISOString()
  const fingerprint = fingerprintOf(input.unit, input.cableIds, input.planDate)
  const groups = listGroups()
  // 同单位 + 同成员 + 同排期日的草稿直接复用，避免两个入口各存一份。
  const existing = groups.find(
    (group) => group.fingerprint === fingerprint && group.status !== 'committed',
  )
  if (existing) {
    Object.assign(existing, {
      crew: input.crew,
      note: input.note,
      updatedAt: stamp,
    })
    saveGroups(groups)
    return existing
  }
  const group: MaintenanceGroup = {
    id: `GRP-${String(nextGroupSeq()).padStart(4, '0')}`,
    unit: input.unit,
    cableIds: [...input.cableIds].sort((a, b) => a - b),
    planDate: input.planDate,
    crew: input.crew,
    note: input.note,
    status: 'draft',
    fingerprint,
    progress: 0,
    plans: [],
    createdAt: stamp,
    updatedAt: stamp,
  }
  saveGroups([...groups, group])
  return group
}

// ---- 整组提交：原子批次 + 断点续做 + 幂等/并发去重 -------------------------

// 进程内互斥：同一页面里两个入口（缆道页/巡检页）并发点提交只放行一次。
let inflightKey: string | null = null

// localStorage 认领锁：跨标签页并发时，第二个标签读到锁即判定对方已在办。
const LOCK_PREFIX = 'hydrology-monitor-station:maintenance-lock:'

function acquireLock(id: string): boolean {
  if (inflightKey === id) {
    return false
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    const lockKey = LOCK_PREFIX + id
    const held = window.localStorage.getItem(lockKey)
    if (held !== null) {
      // 认领锁带 TTL：正常提交在同一个 JS 轮次内完成，远小于 30 秒；
      // 只有页面崩溃留下的死锁才会超时，此时允许接管。
      const age = Date.now() - Date.parse(held)
      if (Number.isNaN(age) || age < 30_000) {
        return false
      }
    }
    window.localStorage.setItem(lockKey, new Date().toISOString())
  }
  inflightKey = id
  return true
}

function releaseLock(id: string): void {
  if (inflightKey === id) {
    inflightKey = null
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(LOCK_PREFIX + id)
  }
}

function nextInspectionId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

/**
 * 准备单项：校验缆道仍可编组，并生成巡检「配合检修」待办。
 * 抛错即本项失败：此前已准备项保存在断点里，之后重试从该项续做。
 */
function prepareItem(
  group: MaintenanceGroup,
  cableRow: EntryRow,
  inspectionRows: EntryRow[],
  idSeq: { value: number },
): PreparedItem {
  if (String(cableRow.status) === '已停用') {
    throw new Error(`缆道 ${cableRow['缆道编号']} 已停用，不能再安排检修`)
  }
  const todoId = idSeq.value++
  const todo: EntryRow = {
    id: todoId,
    status: '待巡检',
    pending: true,
    abnormal: false,
    记录编号: `INSP-MX-${String(todoId).padStart(4, '0')}`,
    站点编号: String(cableRow['所属站点'] ?? ''),
    巡检日期: group.planDate,
    巡检人员: group.crew || '待派工',
    检查项目: `配合${group.unit}检修编组${group.id}：${cableRow['缆道编号']}检修前安全检查`,
    发现问题: '',
    处理措施: `排期 ${group.planDate} 缆道检修，现场配合停送电与载荷核验${group.note ? `；备注：${group.note}` : ''}`,
    巡检状态: '待巡检',
    来源编组: group.id,
    配合缆道: String(cableRow['缆道编号'] ?? ''),
  }
  return {
    cableId: Number(cableRow.id),
    cableNo: String(cableRow['缆道编号'] ?? ''),
    todo,
  }
}

export type CommitOptions = {
  /** 故障演练：指定第几次提交、在哪个成员下标失败，用于演示回滚与断点续做。 */
  fault?: FaultInjection
  now?: Date
  /** 提交序号：测试时外部注入，确保故障演练按第几次触发。 */
  attempt?: number
}

/**
 * 整组落库：
 * 1. 幂等——已提交的组（或同指纹的组）再提交只返回已生效结果，不重复加待办；
 * 2. 并发——进程锁 + localStorage 认领锁，两个入口并发只放行一次；
 * 3. 原子——全部缆道补丁与全部巡检待办在一次 commitRows 批次写入，
 *    任一项（准备或写入）失败都不写业务数据，不留半批；
 * 4. 断点——失败时把已准备项与进度存入组台账，重试只重做未完成项。
 */
export async function commitGroup(id: string, options: CommitOptions = {}): Promise<CommitReport> {
  const now = options.now ?? new Date()
  const stamp = now.toISOString()
  const groups = listGroups()
  const index = groups.findIndex((group) => group.id === id)
  if (index < 0) {
    throw new Error(`没有找到编组 ${id}`)
  }
  const found = groups[index]

  if (found.status === 'committed') {
    return { group: found, risks: risksOfGroup(found) }
  }

  // 跨入口重复提交：同指纹已有生效组，只生效一次。
  const twin = groups.find(
    (group) =>
      group.fingerprint === found.fingerprint && group.status === 'committed' && group.id !== id,
  )
  if (twin) {
    return { group: { ...twin, result: { ...twin.result!, deduped: true } }, risks: risksOfGroup(twin) }
  }

  if (!acquireLock(id)) {
    // 并发提交：另一个入口/标签页已在处理或已生效，直接回读结果，只生效一次。
    const latest = getGroup(id) ?? found
    return {
      group: {
        ...latest,
        result: {
          ok: latest.status === 'committed',
          message:
            latest.status === 'committed'
              ? '另一入口已完成本次提交，未重复生成待办'
              : '编组正在另一入口提交中，本次未重复执行',
          deduped: true,
          at: stamp,
        },
      },
      risks: risksOfGroup(latest),
    }
  }

  // 拿到锁后先让出一个微任务：两个入口在同一时刻并发提交时，
  // 第二个调用会在本次批次写入前撞上锁并被去重，而不是等批次同步跑完。
  await Promise.resolve()

  // 断点：失败时 catch 也要拿到「本次已准备到第几项」，所以提到 try 外面。
  const plans: PreparedItem[] = found.plans ? [...found.plans] : []
  try {
    const attempt = options.attempt ?? (found.progress > 0 ? 2 : 1)
    const cableRows = listRows(CABLEWAY_KEY)
    const inspectionRows = listRows(INSPECTION_KEY)
    // 断点续做：已准备过的项原样复用，只重做后面的项。
    const idSeq = { value: nextInspectionId(inspectionRows) }

    // 阶段一：逐项准备（不写业务数据）。断点之后的项才重做。
    for (let i = plans.length; i < found.cableIds.length; i += 1) {
      if (
        options.fault &&
        attempt === options.fault.failAttempt &&
        i === options.fault.failIndex
      ) {
        throw new Error(
          `故障演练：${found.unit}编组在第 ${i + 1}/${found.cableIds.length} 项（缆道）处理失败`,
        )
      }
      const cableRow = cableRows.find((row) => Number(row.id) === found.cableIds[i])
      if (!cableRow) {
        throw new Error(`缆道记录 ${found.cableIds[i]} 已不存在，编组终止`)
      }
      plans.push(prepareItem(found, cableRow, inspectionRows, idSeq))
    }

    // 阶段二：整组一次原子批次写——任一项失败都不会执行到这里；
    // 若批次写入本身抛错，下面的 catch 同样回滚（next 未持久化），业务数据保持原状。
    const cablePatch = new Map(plans.map((plan) => [plan.cableId, plan]))
    const nextCables = cableRows.map((row) => {
      const plan = cablePatch.get(Number(row.id))
      if (!plan) {
        return row
      }
      // 统一排期：标记为需检修并记录排期来源；检修中的缆道保持检修中，不回退状态。
      const status = String(row.status) === '检修中' ? '检修中' : '需检修'
      return {
        ...row,
        status,
        pending: true,
        abnormal: status === '需检修' ? true : row.abnormal,
        检修编组: found.id,
        计划检修日: found.planDate,
      }
    })
    const todoRows = plans.map((plan) => plan.todo)

    commitRows({
      [CABLEWAY_KEY]: nextCables,
      [INSPECTION_KEY]: [...inspectionRows, ...todoRows],
    })

    const committed: MaintenanceGroup = {
      ...found,
      status: 'committed',
      progress: plans.length,
      plans,
      result: {
        ok: true,
        message: `整组 ${plans.length} 条缆道已统一排期 ${found.planDate}，巡检入口同步生成 ${plans.length} 条配合待办`,
        deduped: false,
        at: stamp,
      },
      updatedAt: stamp,
    }
    saveGroups(listGroups().map((group) => (group.id === id ? committed : group)))
    return { group: committed, risks: risksOfGroup(committed) }
  } catch (error) {
    // 失败：业务数据（缆道、巡检）完全没动；把本次真实断点（已准备项）存进组台账，
    // 下次提交从 plans.length 续做，已完成项不重新生成待办。
    const progress = plans.length
    const failed: MaintenanceGroup = {
      ...found,
      status: 'failed',
      progress,
      plans,
      result: {
        ok: false,
        message: `提交失败，业务数据未改动（无半批）：${error instanceof Error ? error.message : '未知错误'}；已保留断点，可从第 ${progress + 1} 项续做`,
        at: stamp,
      },
      updatedAt: stamp,
    }
    saveGroups(listGroups().map((group) => (group.id === id ? failed : group)))
    return { group: failed, risks: risksOfGroup(found) }
  } finally {
    releaseLock(id)
    // 让出一个微任务，使两个入口在同一时刻并发提交时，第二个能看到锁。
    await Promise.resolve()
  }
}

function risksOfGroup(group: MaintenanceGroup): CableRisk[] {
  return assessAll().filter((risk) => group.cableIds.includes(Number(risk.row.id)))
}

// ---- 导出 -----------------------------------------------------------------

export function exportRiskCsv(risks: CableRisk[]): { filename: string; content: string } {
  const header = [
    '缆道编号',
    '所属站点',
    '管理单位',
    '跨度米数',
    '荷载能力(吨)',
    '检修基准日',
    '检修日是否兜底',
    '距今天数',
    '跨度风险',
    '荷载风险',
    '超期风险',
    '综合风险',
    '风险说明',
  ]
  const order = { 高: 0, 中: 1, 低: 2 }
  const lines = [header.join(',')]
  for (const risk of [...risks].sort((a, b) => order[a.level] - order[b.level])) {
    lines.push(
      [
        risk.cableNo,
        risk.station,
        risk.unit,
        risk.spanMeters ?? '',
        risk.loadTonnes ?? '',
        risk.effectiveInspectDate,
        risk.inspectDateFallback ? '是(建成日期)' : '否',
        risk.daysSinceInspect ?? '',
        risk.spanRisk,
        risk.loadRisk,
        risk.overdueRisk,
        risk.level,
        risk.reasons.join('；'),
      ]
        .map((cell) => String(cell).replace(/,/g, '，'))
        .join(','),
    )
  }
  return { filename: `检修编组-跨度荷载风险清单-${todayText(new Date())}.csv`, content: `﻿${lines.join('\n')}` }
}
