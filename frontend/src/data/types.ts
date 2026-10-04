/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ---- 测流缆道检修编组 ----

export type RiskLevel = '高' | '中' | '低' | '未知'

/** 编组时为一一条缆道算出的跨度、荷载、超期风险。 */
export type RiskItem = {
  cablewayId: number
  缆道编号: string
  跨度米数: number | null
  跨度风险: RiskLevel
  荷载能力: number | null
  荷载风险: RiskLevel
  基准检修日: string
  基准来源: '最近检修日' | '建成日期' | '无'
  超期天数: number | null
  超期风险: RiskLevel
  综合风险: RiskLevel
}

export type BatchItem = {
  cablewayId: number
  缆道编号: string
  state: '待执行' | '已完成' | '失败'
  message: string
}

export type BatchStatus = '待提交' | '已完成' | '失败待续做' | '已作废'

/** 检修编组批次台账：业务数据之外单独持久化，断点续做就看它。 */
export type MaintenanceBatch = {
  id: string
  idempotencyKey: string
  管理单位: string
  计划检修日: string
  检修人员: string
  memberIds: number[]
  items: BatchItem[]
  riskList: RiskItem[]
  inspectionTodoId: number | null
  status: BatchStatus
  failedStep: string
  note: string
  attempts: number
  lastError: string
  createdAt: string
  updatedAt: string
}

export type CommitResult = {
  ok: boolean
  message: string
  duplicated?: boolean
  batch?: MaintenanceBatch
}
