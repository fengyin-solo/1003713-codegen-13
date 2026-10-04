<template>
  <section class="page" data-module="cableway">
    <header class="page-head">
      <div>
        <h2>测流缆道管理</h2>
        <p class="page-desc">维护测流缆道，围绕缆道编号、所属站点、跨度米数、建成日期做登记、筛选与状态流转；检修编组台支持同单位多选、统一排期与跨度荷载风险清单。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记测流缆道</button>
        <button class="btn" type="button" @click="exportRows">导出测流缆道清单</button>
      </div>
    </header>

    <nav class="tab-bar">
      <button class="tab-item" :class="{ active: tab === 'ledger' }" type="button" @click="tab = 'ledger'">缆道台账</button>
      <button class="tab-item" :class="{ active: tab === 'bench' }" type="button" @click="switchToBench">检修编组台</button>
    </nav>

    <!-- 缆道台账 -->
    <template v-if="tab === 'ledger'">
      <div class="stat-row">
        <article v-for="item in stats" :key="item.label" class="stat-card">
          <span class="stat-label">{{ item.label }}</span>
          <strong class="stat-value">{{ item.value }}</strong>
        </article>
      </div>

      <p class="status-legend">
        <span v-for="item in statusSummary" :key="item.status" class="legend-item">
          {{ item.status }}：{{ item.count }}
        </span>
      </p>

      <form class="filter-bar" @submit.prevent="reload">
        <label v-for="field in filterFields" :key="field" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="filters[field]" :placeholder="`按${field}检索`" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)">
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 2" class="empty-state">暂无测流缆道数据，可先登记测流缆道</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span>共 {{ total }} 条测流缆道记录</span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      </footer>
    </template>

    <!-- 检修编组台 -->
    <template v-else>
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">可编组管理单位</span>
          <strong class="stat-value">{{ unitGroups.length }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">高风险缆道</span>
          <strong class="stat-value" style="color: #b42318">{{ riskSummary.high }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">中风险缆道</span>
          <strong class="stat-value" style="color: #92400e">{{ riskSummary.medium }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">待提交/失败编组</span>
          <strong class="stat-value">{{ pendingGroups.length }}</strong>
        </article>
      </div>

      <section class="panel">
        <h3 class="panel-title">① 选择同单位缆道（混合状态可编组，已停用不可选）</h3>
        <div class="unit-head">
          <label>
            <span class="muted">管理单位</span>
            <select v-model="selectedUnit" @change="onUnitChange">
              <option value="" disabled>请选择管理单位</option>
              <option v-for="group in unitGroups" :key="group.unit" :value="group.unit">
                {{ group.unit }}（{{ group.cableIds.length }} 条）
              </option>
            </select>
          </label>
          <button class="btn small" type="button" :disabled="!selectedUnit" @click="selectAll">全选本单位</button>
          <button class="btn small" type="button" :disabled="!selectedUnit" @click="selectedIds = []">清空勾选</button>
          <span class="muted">已勾选 {{ selectedIds.length }} 条</span>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th class="check-cell">选择</th>
              <th>缆道编号</th>
              <th>所属站点</th>
              <th>管理单位</th>
              <th>跨度米数</th>
              <th>荷载能力</th>
              <th>建成日期</th>
              <th>检修基准日</th>
              <th>当前状态</th>
              <th>综合风险</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="risk in unitRisks" :key="risk.cableNo">
              <td class="check-cell">
                <input
                  v-model="selectedIds"
                  type="checkbox"
                  :value="Number(risk.row.id)"
                  :disabled="!isGroupable(risk.row) || inCommittedGroup(Number(risk.row.id))"
                />
              </td>
              <td>{{ risk.cableNo }}</td>
              <td>{{ risk.station }}</td>
              <td>{{ risk.unit }}</td>
              <td>{{ risk.spanMeters ?? '—' }}<span v-if="risk.spanMeters !== null"> 米</span></td>
              <td>{{ risk.loadTonnes ?? '—' }}<span v-if="risk.loadTonnes !== null"> 吨</span></td>
              <td>{{ risk.row['建成日期'] || '—' }}</td>
              <td>
                {{ risk.effectiveInspectDate || '—' }}
                <span v-if="risk.inspectDateFallback" class="badge badge-neutral">按建成日期</span>
              </td>
              <td>{{ risk.row.status }}</td>
              <td><span class="badge" :class="badgeClass(risk.level)">{{ risk.level }}</span></td>
            </tr>
          </tbody>
        </table>
        <p class="tip-line">规则：跨度 ≥ 400m 高风险、200–400m 中风险；荷载 &lt; 1t 高风险、1–2.5t 中风险；距最近检修超 365 天高风险、180 天中风险。最近检修日缺失的旧数据按建成日期兼容计算。</p>
      </section>

      <section class="panel">
        <h3 class="panel-title">② 统一排期并生成跨度 / 荷载风险清单</h3>
        <form class="form-grid" @submit.prevent="saveGroupDraft">
          <label>
            <span>计划检修日期</span>
            <input v-model="planDate" type="date" />
          </label>
          <label>
            <span>检修班组</span>
            <input v-model="crew" placeholder="如：周建国班组" />
          </label>
          <label>
            <span>编组备注</span>
            <input v-model="note" placeholder="可填写配合要求（选填）" />
          </label>
          <button class="btn" type="submit">暂存编组</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="submitNewGroup">
            {{ submitting ? '整组提交中…' : '整组提交并同步巡检待办' }}
          </button>
          <label class="muted" title="演示用：让首次提交在第 3 项失败，验证无半批与断点续做">
            <input v-model="faultDrill" type="checkbox" /> 故障演练（首次提交在第3项失败）
          </label>
        </form>
        <p v-if="benchMessage" :class="benchOk ? 'success-text' : 'error-text'" style="font-size: 13px">{{ benchMessage }}</p>

        <table v-if="selectedRisks.length" class="data-table" style="margin-top: 10px">
          <thead>
            <tr>
              <th>缆道编号</th>
              <th>所属站点</th>
              <th>跨度风险</th>
              <th>荷载风险</th>
              <th>检修超期风险</th>
              <th>综合</th>
              <th>风险说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="risk in selectedRisks" :key="risk.cableNo">
              <td>{{ risk.cableNo }}</td>
              <td>{{ risk.station }}</td>
              <td><span class="badge" :class="badgeClass(risk.spanRisk)">{{ risk.spanRisk }}</span></td>
              <td><span class="badge" :class="badgeClass(risk.loadRisk)">{{ risk.loadRisk }}</span></td>
              <td><span class="badge" :class="badgeClass(risk.overdueRisk)">{{ risk.overdueRisk }}</span></td>
              <td><span class="badge" :class="badgeClass(risk.level)">{{ risk.level }}</span></td>
              <td>{{ risk.reasons.join('；') }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="tip-line">勾选缆道后在此生成风险清单，可随编组一并核对。</p>
        <p v-if="selectedRisks.length" class="tip-line">
          选中 {{ selectedRisks.length }} 条：高 {{ selectedCount('高') }} / 中 {{ selectedCount('中') }} / 低 {{ selectedCount('低') }}
          <button class="btn small" type="button" style="margin-left: 10px" @click="exportSelectedRisks">导出风险清单 CSV</button>
        </p>
      </section>

      <section class="panel">
        <h3 class="panel-title">③ 编组台账（失败可从断点续做；巡检记录页同步出现配合待办）</h3>
        <p v-if="!groups.length" class="tip-line">暂无编组，完成①②后整组提交。</p>
        <article v-for="group in groups" :key="group.id" class="group-card">
          <div class="group-card-head">
            <strong>{{ group.id }} · {{ group.unit }}</strong>
            <span>
              <span class="badge" :class="statusBadge(group.status)">{{ statusLabel(group.status) }}</span>
              <button
                v-if="group.status !== 'committed'"
                class="btn small primary"
                type="button"
                style="margin-left: 10px"
                :disabled="submitting"
                @click="resumeGroup(group.id)"
              >
                {{ group.status === 'failed' ? `从断点续做（${group.progress}/${group.cableIds.length}）` : '提交整组' }}
              </button>
            </span>
          </div>
          <div class="group-meta">
            <span>缆道：{{ group.cableIds.map((id) => cableNoOf(id)).join('、') }}</span>
            <span>计划日期：{{ group.planDate }}</span>
            <span>班组：{{ group.crew || '待派工' }}</span>
            <span v-if="group.note">备注：{{ group.note }}</span>
          </div>
          <p v-if="group.result" class="progress-line" :class="group.result.ok ? 'success-text' : 'error-text'">
            {{ group.result.message }}
          </p>
          <p v-else class="progress-line">草稿：已暂存，尚未整组落库。</p>
        </article>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  assessAll,
  commitGroup,
  exportRiskCsv,
  getGroup,
  isGroupable,
  listUnitGroups,
  listGroupsByStatus,
  saveDraft,
} from '@/api/maintenance-service'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { CableRisk, MaintenanceGroup } from '@/data/maintenance-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('cableway')
const columns = ['缆道编号', '所属站点', '跨度米数', '建成日期', '最近检修日', '荷载能力', '检修人员', '缆道状态']
const actions = ['安排检修', '完成检修', '停用缆道']
const statuses = ['正常运行', '需检修', '检修中', '已停用']
const stats = [{ label: '缆道总数', value: 0 }, { label: '正常运行数', value: 0 }, { label: '需检修数', value: 0 }]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 编组台状态
const tab = ref<'ledger' | 'bench'>('ledger')
const allRisks = ref<CableRisk[]>([])
const unitGroups = ref(listUnitGroups())
const groups = ref<MaintenanceGroup[]>([])
const selectedUnit = ref('')
const selectedIds = ref<number[]>([])
const planDate = ref('')
const crew = ref('')
const note = ref('')
const faultDrill = ref(false)
const submitting = ref(false)
const benchMessage = ref('')
const benchOk = ref(true)

const riskSummary = computed(() => {
  const list = allRisks.value
  return {
    high: list.filter((item) => item.level === '高').length,
    medium: list.filter((item) => item.level === '中').length,
    low: list.filter((item) => item.level === '低').length,
  }
})

const unitRisks = computed(() =>
  allRisks.value.filter((risk) => risk.unit === selectedUnit.value),
)

const selectedRisks = computed(() =>
  allRisks.value.filter((risk) => selectedIds.value.includes(Number(risk.row.id))),
)

const pendingGroups = computed(() =>
  groups.value.filter((group) => group.status !== 'committed'),
)

const committedCableIds = computed(() => {
  const ids = new Set<number>()
  for (const group of groups.value.filter((item) => item.status === 'committed')) {
    for (const id of group.cableIds) {
      ids.add(id)
    }
  }
  return ids
})

function badgeClass(level: string): string {
  if (level === '高') return 'badge-high'
  if (level === '中') return 'badge-mid'
  return 'badge-low'
}

function statusBadge(status: string): string {
  if (status === 'committed') return 'badge-ok'
  if (status === 'failed') return 'badge-fail'
  return 'badge-draft'
}

function statusLabel(status: string): string {
  return { committed: '已提交', failed: '失败待续做', draft: '草稿' }[status] ?? status
}

function selectedCount(level: string): number {
  return selectedRisks.value.filter((risk) => risk.level === level).length
}

function inCommittedGroup(cableId: number): boolean {
  return committedCableIds.value.has(cableId)
}

function cableNoOf(id: number): string {
  return allRisks.value.find((risk) => Number(risk.row.id) === id)?.cableNo ?? `#${id}`
}

function onUnitChange() {
  selectedIds.value = []
  benchMessage.value = ''
}

function selectAll() {
  selectedIds.value = unitRisks.value
    .filter((risk) => isGroupable(risk.row) && !inCommittedGroup(Number(risk.row.id)))
    .map((risk) => Number(risk.row.id))
}

function switchToBench() {
  tab.value = 'bench'
  refreshBench()
}

function refreshBench() {
  allRisks.value = assessAll()
  unitGroups.value = listUnitGroups()
  groups.value = listGroupsByStatus()
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function exportSelectedRisks() {
  const { filename, content } = exportRiskCsv(selectedRisks.value)
  downloadCsv(filename, content)
}

function buildDraft(): MaintenanceGroup | null {
  try {
    return saveDraft({
      unit: selectedUnit.value,
      cableIds: selectedIds.value,
      planDate: planDate.value,
      crew: crew.value,
      note: note.value,
    })
  } catch (error) {
    benchOk.value = false
    benchMessage.value = error instanceof Error ? error.message : '编组校验失败'
    return null
  }
}

function saveGroupDraft() {
  const group = buildDraft()
  if (!group) {
    return
  }
  benchOk.value = true
  benchMessage.value = `编组 ${group.id} 已暂存（${group.cableIds.length} 条缆道，计划 ${group.planDate}），可整组提交或到巡检页配合提交`
  refreshBench()
}

async function submitNewGroup() {
  const group = buildDraft()
  if (!group) {
    return
  }
  await doCommit(group.id)
}

async function resumeGroup(id: string) {
  await doCommit(id)
}

async function doCommit(id: string) {
  benchMessage.value = ''
  submitting.value = true
  try {
    // 故障演练只注入第一次提交（attempt=1）；断点续做不再注入，保证续做成功。
    const existing = getGroup(id)
    const useFault = faultDrill.value && existing?.status !== 'failed'
    const report = await commitGroup(id, useFault ? { fault: { failAttempt: 1, failIndex: 2 } } : {})
    benchOk.value = report.group.result?.ok ?? false
    benchMessage.value =
      (report.group.result?.deduped ? '（去重）' : '') + (report.group.result?.message ?? '')
    refreshBench()
    reload()
  } catch (error) {
    benchOk.value = false
    benchMessage.value = error instanceof Error ? error.message : '整组提交失败'
    refreshBench()
  } finally {
    submitting.value = false
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '测流缆道登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats[0].value = payload.total
    stats[1].value = payload.items.filter((row) => row.status === '正常运行').length
    stats[2].value = payload.items.filter((row) => row.status === '需检修').length
    if (tab.value === 'bench') {
      refreshBench()
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '测流缆道列表读取失败'
  }
}

onMounted(reload)
</script>
