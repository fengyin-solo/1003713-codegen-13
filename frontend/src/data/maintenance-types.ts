/** 检修编组台：测流缆道多选同单位编组、统一排期、跨度/荷载风险清单。 */
import type { EntryRow } from './types'

export type RiskLevel = '高' | '中' | '低'

/** 单条缆道的风险评估明细。 */
export type CableRisk = {
  row: EntryRow
  cableNo: string
  station: string
  unit: string
  spanMeters: number | null
  loadTonnes: number | null
  effectiveInspectDate: string
  inspectDateFallback: boolean
  daysSinceInspect: number | null
  spanRisk: RiskLevel
  loadRisk: RiskLevel
  overdueRisk: RiskLevel
  level: RiskLevel
  reasons: string[]
}

export type GroupStatus = 'draft' | 'committed' | 'failed'

/** 编组台排期组：草稿、失败断点都持久化，刷新后仍可从断点续做。 */
export type MaintenanceGroup = {
  id: string
  unit: string
  cableIds: number[]
  planDate: string
  crew: string
  note: string
  status: GroupStatus
  /** 幂等指纹：单位 + 成员（排序）+ 排期日期。 */
  fingerprint: string
  /** 已成功处理到第几项（断点），重试从该下标继续；已提交时等于成员总数。 */
  progress: number
  /** 断点之前已准备好的项：缆道补丁与待办都在里面，重试时原样复用不重做。 */
  plans?: PreparedItem[]
  result?: {
    ok: boolean
    message: string
    /** true 表示这次调用命中了并发/重复提交去重，只生效一次。 */
    deduped?: boolean
    at: string
  }
  createdAt: string
  updatedAt: string
}

export type RiskSummary = {
  high: number
  medium: number
  low: number
}

export type UnitGroupOption = {
  unit: string
  cableIds: number[]
}

export type CommitReport = {
  group: MaintenanceGroup
  risks: CableRisk[]
}

/** 单项准备产物：缆道补丁 + 巡检配合待办草稿，断点之后只重做未准备项。 */
export type PreparedItem = {
  cableId: number
  cableNo: string
  todo: EntryRow
}

export type FaultInjection = {
  /** 第几次提交时触发（1 起算），用于演示首次失败、重试从断点续做。 */
  failAttempt: number
  /** 在成员下标处失败（0 起算）；已准备过的下标不会再触发。 */
  failIndex: number
}
