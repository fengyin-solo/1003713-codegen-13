<template>
  <section class="page" data-module="inspection">
    <header class="page-head">
      <div>
        <h2>巡检记录管理</h2>
        <p class="page-desc">维护巡检记录；检修配合待办与测流缆道检修编组台共用同一份编组，两个入口并发提交只生效一次。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡检记录</button>
        <button class="btn" type="button" @click="exportRows">导出巡检记录清单</button>
      </div>
    </header>

    <nav class="tab-bar">
      <button class="tab-item" :class="{ active: tab === 'ledger' }" type="button" @click="tab = 'ledger'">巡检台账</button>
      <button class="tab-item" :class="{ active: tab === 'coop' }" type="button" @click="switchToCoop">检修配合待办</button>
    </nav>

    <!-- 巡检台账 -->
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
            <td>
              {{ row.status }}
              <span v-if="row['来源编组']" class="badge badge-draft" style="margin-left: 4px">配合编组 {{ row['来源编组'] }}</span>
            </td>
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
            <td :colspan="columns.length + 2" class="empty-state">暂无巡检记录数据，可先登记巡检记录</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span>共 {{ total }} 条巡检记录</span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      </footer>
    </template>

    <!-- 检修配合待办：第二入口 -->
    <template v-else>
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">待配合编组（草稿/失败）</span>
          <strong class="stat-value">{{ pendingGroups.length }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">已生效编组</span>
          <strong class="stat-value" style="color: #027a48">{{ committedGroups.length }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">配合检修待办</span>
          <strong class="stat-value">{{ coopTodos.length }}</strong>
        </article>
      </div>

      <section class="panel">
        <h3 class="panel-title">待配合的检修编组（在此提交即等同于缆道页整组落库，会同步本页待办）</h3>
        <p v-if="!pendingGroups.length" class="tip-line">没有待配合的编组；可到「测流缆道 → 检修编组台」勾选同单位缆道并暂存编组。</p>
        <article v-for="group in pendingGroups" :key="group.id" class="group-card">
          <div class="group-card-head">
            <strong>{{ group.id }} · {{ group.unit }}</strong>
            <span>
              <span class="badge" :class="group.status === 'failed' ? 'badge-fail' : 'badge-draft'">
                {{ group.status === 'failed' ? `失败 · 断点 ${group.progress}/${group.cableIds.length}` : '草稿' }}
              </span>
              <button
                class="btn small primary"
                type="button"
                style="margin-left: 10px"
                :disabled="submittingId === group.id"
                @click="submitFromCoop(group.id)"
              >
                {{ submittingId === group.id ? '提交中…' : group.status === 'failed' ? '从断点续做并生成待办' : '配合提交整组' }}
              </button>
            </span>
          </div>
          <div class="group-meta">
            <span>缆道 {{ group.cableIds.length }} 条</span>
            <span>计划检修：{{ group.planDate }}</span>
            <span>班组：{{ group.crew || '待派工' }}</span>
          </div>
          <p v-if="group.result" class="progress-line" :class="group.result.ok ? 'success-text' : 'error-text'">{{ group.result.message }}</p>
        </article>
        <p v-if="coopMessage" :class="coopOk ? 'success-text' : 'error-text'" style="font-size: 13px">{{ coopMessage }}</p>
      </section>

      <section class="panel">
        <h3 class="panel-title">已同步的配合检修待办</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>记录编号</th>
              <th>站点</th>
              <th>配合编组</th>
              <th>配合缆道</th>
              <th>巡检日期</th>
              <th>巡检人员</th>
              <th>检查项目</th>
              <th>处理措施</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="todo in coopTodos" :key="String(todo.id)">
              <td>{{ todo['记录编号'] }}</td>
              <td>{{ todo['站点编号'] }}</td>
              <td>{{ todo['来源编组'] }}</td>
              <td>{{ todo['配合缆道'] }}</td>
              <td>{{ todo['巡检日期'] }}</td>
              <td>{{ todo['巡检人员'] }}</td>
              <td>{{ todo['检查项目'] }}</td>
              <td>{{ todo['处理措施'] }}</td>
              <td><span class="badge badge-draft">{{ todo.status }}</span></td>
            </tr>
            <tr v-if="!coopTodos.length">
              <td colspan="9" class="empty-state">暂无配合检修待办，编组整组提交后自动生成</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { commitGroup, listGroupsByStatus } from '@/api/maintenance-service'
import {
  downloadEntries,
  listEntries,
  listRows,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { MaintenanceGroup } from '@/data/maintenance-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('inspection')
const columns = ['记录编号', '站点编号', '巡检日期', '巡检人员', '检查项目', '发现问题', '处理措施', '巡检状态']
const actions = ['完成巡检', '报告故障', '确认处置']
const statuses = ['待巡检', '已巡检', '发现故障', '已处置']
const stats = [{ label: '本月巡检次数', value: 0 }, { label: '已巡检站点', value: 0 }, { label: '待处置故障', value: 0 }]

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

// 配合待办页签
const tab = ref<'ledger' | 'coop'>('ledger')
const groups = ref<MaintenanceGroup[]>([])
const inspectionRows = ref<EntryRow[]>([])
const submittingId = ref('')
const coopMessage = ref('')
const coopOk = ref(true)

const pendingGroups = computed(() => groups.value.filter((group) => group.status !== 'committed'))
const committedGroups = computed(() => groups.value.filter((group) => group.status === 'committed'))
const coopTodos = computed(() =>
  inspectionRows.value.filter((row) => Boolean(row['来源编组'])),
)

function switchToCoop() {
  tab.value = 'coop'
  refreshCoop()
}

function refreshCoop() {
  groups.value = listGroupsByStatus()
  inspectionRows.value = listRows(meta.key)
}

async function submitFromCoop(id: string) {
  coopMessage.value = ''
  submittingId.value = id
  try {
    const report = await commitGroup(id)
    coopOk.value = report.group.result?.ok ?? false
    coopMessage.value =
      (report.group.result?.deduped ? '（与另一入口并发，已去重）' : '') +
      (report.group.result?.message ?? '')
    refreshCoop()
    reload()
  } catch (error) {
    coopOk.value = false
    coopMessage.value = error instanceof Error ? error.message : '配合提交失败'
  } finally {
    submittingId.value = ''
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
  errorMessage.value = '巡检记录登记入口尚未接入审批流'
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
    stats[1].value = payload.items.filter((row) => row.status === '已巡检').length
    stats[2].value = payload.items.filter((row) => row.status === '发现故障').length
    if (tab.value === 'coop') {
      refreshCoop()
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '巡检记录列表读取失败'
  }
}

onMounted(reload)
</script>
