<template>
  <section class="page" data-module="cableway-grouping">
    <header class="page-head">
      <div>
        <h2>测流缆道检修编组台</h2>
        <p class="page-desc">
          多选同一所属站点的缆道统一排期，生成跨度、荷载风险清单；整组落库后同步巡检入口的配合待办。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/cableway">返回缆道列表</RouterLink>
      </div>
    </header>

    <p class="rule-box">
      编组规则：仅同一所属站点（管理单位）可编一组；不允许混合状态，所选缆道状态必须一致；
      仅「正常运行」「需检修」可排期（检修中已在修、已停用不再排）；至少 2 条成组；
      旧数据缺最近检修日时按建成日期计算超期。落库要么整批生效要么整批回滚，失败可从断点续做。
    </p>

    <h3 class="section-title">一、选择缆道（同站点 · 同状态）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>选择</th>
          <th>缆道编号</th>
          <th>所属站点</th>
          <th>当前状态</th>
          <th>跨度米数</th>
          <th>荷载能力</th>
          <th>基准检修日</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in cableways" :key="String(row.id)" :class="{ 'row-disabled': !selectable(row) }">
          <td>
            <input
              type="checkbox"
              :checked="selected.includes(Number(row.id))"
              :disabled="!selectable(row) && !selected.includes(Number(row.id))"
              @change="toggle(row)"
            />
          </td>
          <td>{{ row['缆道编号'] }}</td>
          <td>{{ row['所属站点'] }}</td>
          <td>{{ row.status }}</td>
          <td>{{ row['跨度米数'] || '—' }}</td>
          <td>{{ row['荷载能力'] || '—' }}</td>
          <td>
            {{ baselineOf(row).基准检修日 || '—' }}
            <span v-if="baselineOf(row).基准来源 === '建成日期'" class="tag">按建成日期</span>
          </td>
        </tr>
        <tr v-if="!cableways.length">
          <td colspan="7" class="empty-state">暂无测流缆道数据</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">二、统一排期</h3>
    <form class="filter-bar" @submit.prevent="submit">
      <label class="filter-item">
        <span>计划检修日</span>
        <input v-model="scheduleDate" type="date" :min="today" />
      </label>
      <label class="filter-item">
        <span>检修人员</span>
        <input v-model="crew" placeholder="检修负责人，可留空" />
      </label>
      <button class="btn primary" type="submit" :disabled="submitting || selected.length < 2 || !scheduleDate">
        {{ submitting ? '落库中…' : '提交编组并落库' }}
      </button>
      <span class="hint">已选 {{ selected.length }} 条</span>
    </form>

    <h3 class="section-title">三、跨度、荷载风险清单（{{ riskPreview.length }} 条）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>缆道编号</th>
          <th>跨度米数</th>
          <th>跨度风险</th>
          <th>荷载能力</th>
          <th>荷载风险</th>
          <th>基准检修日</th>
          <th>超期天数</th>
          <th>综合风险</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in riskPreview" :key="item.cablewayId">
          <td>{{ item.缆道编号 }}</td>
          <td>{{ item.跨度米数 ?? '—' }}</td>
          <td><span class="risk-badge" :data-level="item.跨度风险">{{ item.跨度风险 }}</span></td>
          <td>{{ item.荷载能力 ?? '—' }}</td>
          <td><span class="risk-badge" :data-level="item.荷载风险">{{ item.荷载风险 }}</span></td>
          <td>
            {{ item.基准检修日 || '—' }}
            <span v-if="item.基准来源 === '建成日期'" class="tag">按建成日期</span>
          </td>
          <td>{{ item.超期天数 === null ? '—' : item.超期天数 }}</td>
          <td><span class="risk-badge" :data-level="item.综合风险">{{ item.综合风险 }}</span></td>
        </tr>
        <tr v-if="!riskPreview.length">
          <td colspan="8" class="empty-state">勾选缆道后自动生成风险清单</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">四、编组批次台账</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>批次号</th>
          <th>管理单位</th>
          <th>计划检修日</th>
          <th>成员缆道</th>
          <th>风险概况</th>
          <th>状态</th>
          <th>断点 / 备注</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="batch in ledger" :key="batch.id">
          <td>{{ batch.id }}</td>
          <td>{{ batch.管理单位 }}</td>
          <td>{{ batch.计划检修日 }}</td>
          <td>{{ batch.items.map((item) => item.缆道编号).join('、') }}</td>
          <td>{{ riskSummary(batch) }}</td>
          <td><span class="batch-status" :data-status="batch.status">{{ batch.status }}</span></td>
          <td>
            <span v-if="batch.status === '失败待续做'" class="error-text">
              断点：{{ batch.failedStep }}（{{ batch.lastError }}）
            </span>
            <span v-else-if="batch.note">{{ batch.note }}</span>
            <span v-else>—</span>
          </td>
          <td class="row-actions">
            <button
              v-if="batch.status === '失败待续做' || batch.status === '待提交'"
              class="link"
              type="button"
              :disabled="submitting"
              @click="resume(batch.id)"
            >
              续做落库
            </button>
            <button
              v-if="batch.status === '失败待续做' || batch.status === '待提交'"
              class="link"
              type="button"
              :disabled="submitting"
              @click="cancel(batch.id)"
            >
              作废
            </button>
            <span v-if="batch.status === '已完成'">巡检待办 #{{ batch.inspectionTodoId }}</span>
          </td>
        </tr>
        <tr v-if="!ledger.length">
          <td colspan="8" class="empty-state">暂无编组批次</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span v-if="message" class="ok-text">{{ message }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  buildRiskItem,
  cancelBatch,
  listBatchLedger,
  resumeBatch,
  SCHEDULABLE_STATUSES,
  submitBatch,
  todayText,
} from '@/api/cableway-group'
import { listEntries } from '@/api/local-service'
import type { EntryRow, MaintenanceBatch, RiskItem } from '@/data/types'

const today = todayText()
const cableways = ref<EntryRow[]>([])
const selected = ref<number[]>([])
const scheduleDate = ref(today)
const crew = ref('')
const ledger = ref<MaintenanceBatch[]>([])
const message = ref('')
const errorMessage = ref('')
const submitting = ref(false)

const baselines = computed(() => {
  const map = new Map<number, RiskItem>()
  for (const row of cableways.value) {
    map.set(Number(row.id), buildRiskItem(row, today))
  }
  return map
})

const firstSelected = computed(() =>
  cableways.value.find((row) => selected.value.includes(Number(row.id))),
)

const riskPreview = computed(() =>
  cableways.value
    .filter((row) => selected.value.includes(Number(row.id)))
    .map((row) => buildRiskItem(row, today)),
)

function baselineOf(row: EntryRow): RiskItem {
  return (
    baselines.value.get(Number(row.id)) ?? {
      cablewayId: Number(row.id),
      缆道编号: String(row['缆道编号'] ?? row.id),
      跨度米数: null,
      跨度风险: '未知',
      荷载能力: null,
      荷载风险: '未知',
      基准检修日: '',
      基准来源: '无',
      超期天数: null,
      超期风险: '未知',
      综合风险: '未知',
    }
  )
}

function selectable(row: EntryRow): boolean {
  if (!SCHEDULABLE_STATUSES.includes(String(row.status))) {
    return false
  }
  const first = firstSelected.value
  if (!first) {
    return true
  }
  return (
    String(row['所属站点']) === String(first['所属站点']) &&
    String(row.status) === String(first.status)
  )
}

function toggle(row: EntryRow) {
  const id = Number(row.id)
  if (selected.value.includes(id)) {
    selected.value = selected.value.filter((item) => item !== id)
    return
  }
  if (selectable(row)) {
    selected.value = [...selected.value, id]
  }
}

function riskSummary(batch: MaintenanceBatch): string {
  const counts: Record<string, number> = { 高: 0, 中: 0, 低: 0, 未知: 0 }
  for (const item of batch.riskList) {
    counts[item.综合风险] += 1
  }
  return `高${counts['高']} 中${counts['中']} 低${counts['低']}`
}

async function submit() {
  message.value = ''
  errorMessage.value = ''
  submitting.value = true
  try {
    const result = await submitBatch({
      memberIds: selected.value,
      计划检修日: scheduleDate.value,
      检修人员: crew.value,
      today,
    })
    if (result.ok) {
      message.value = result.message
      selected.value = []
    } else {
      errorMessage.value = result.message
    }
  } finally {
    submitting.value = false
    reload()
  }
}

async function resume(batchId: string) {
  message.value = ''
  errorMessage.value = ''
  submitting.value = true
  try {
    const result = await resumeBatch(batchId)
    if (result.ok) {
      message.value = result.message
    } else {
      errorMessage.value = result.message
    }
  } finally {
    submitting.value = false
    reload()
  }
}

function cancel(batchId: string) {
  message.value = ''
  errorMessage.value = ''
  const result = cancelBatch(batchId)
  if (result.ok) {
    message.value = result.message
  } else {
    errorMessage.value = result.message
  }
  reload()
}

function reload() {
  cableways.value = listEntries('cableway').items
  ledger.value = listBatchLedger()
}

onMounted(reload)
</script>
