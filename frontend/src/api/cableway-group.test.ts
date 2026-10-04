import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildRiskItem,
  CABLEWAY_KEY,
  commitOnce,
  INSPECTION_KEY,
  planBatch,
  resumeBatch,
  submitBatch,
} from '@/api/cableway-group'
import { invalidateBatchCache, readBatchesFresh, saveBatches } from '@/data/batch-store'
import { invalidateCache, listRows, readFresh, saveRows } from '@/data/local-store'
import type { EntryRow, MaintenanceBatch } from '@/data/types'

// node 环境没有浏览器存储，这里补一个内存版 localStorage。
class LocalStorageStub {
  private map = new Map<string, string>()
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value))
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  clear() {
    this.map.clear()
  }
}

const TODAY = '2026-10-04'

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).window = { localStorage: new LocalStorageStub() }
  invalidateCache()
  invalidateBatchCache()
})

function cableway(id: number): EntryRow {
  const row = readFresh()[CABLEWAY_KEY].find((item) => Number(item.id) === id)
  if (!row) {
    throw new Error(`测试数据缺少缆道 ${id}`)
  }
  return row
}

function patchCableway(id: number, patch: Record<string, string>) {
  const rows = readFresh()[CABLEWAY_KEY].map((row) =>
    Number(row.id) === id ? { ...row, ...patch } : row,
  )
  saveRows(CABLEWAY_KEY, rows)
}

function inspectionTodosOf(batchId: string): EntryRow[] {
  return readFresh()[INSPECTION_KEY].filter((row) => String(row['编组批次号'] ?? '') === batchId)
}

describe('编组校验', () => {
  it('拒绝跨站点编组', () => {
    const result = planBatch({ memberIds: [1, 4], 计划检修日: '2026-10-10', 检修人员: '', today: TODAY })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('同一所属站点')
  })

  it('拒绝混合状态编组', () => {
    const result = planBatch({ memberIds: [1, 2], 计划检修日: '2026-10-10', 检修人员: '', today: TODAY })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('混合状态')
  })

  it('拒绝不可排期状态（已停用）', () => {
    patchCableway(1, { status: '已停用' })
    patchCableway(3, { status: '已停用' })
    const result = planBatch({ memberIds: [1, 3], 计划检修日: '2026-10-10', 检修人员: '', today: TODAY })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('已停用')
  })

  it('少于 2 条不成组', () => {
    const result = planBatch({ memberIds: [1], 计划检修日: '2026-10-10', 检修人员: '', today: TODAY })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('至少选择 2 条')
  })
})

describe('风险清单与旧数据兼容', () => {
  it('缺最近检修日时按建成日期计算超期', () => {
    const risk = buildRiskItem(cableway(3), TODAY)
    expect(risk.基准来源).toBe('建成日期')
    expect(risk.基准检修日).toBe('2019-09-01')
    expect(risk.超期天数).toBe(2225)
    expect(risk.超期风险).toBe('高')
    expect(risk.综合风险).toBe('高')
  })

  it('有最近检修日时优先使用', () => {
    const risk = buildRiskItem(cableway(1), TODAY)
    expect(risk.基准来源).toBe('最近检修日')
    expect(risk.跨度风险).toBe('中') // 180m
    expect(risk.荷载风险).toBe('中') // 450kg
    expect(risk.超期风险).toBe('低') // 2025-11-02 至今未超期
    expect(risk.综合风险).toBe('中')
  })

  it('大跨度记为高风险', () => {
    expect(buildRiskItem(cableway(2), TODAY).跨度风险).toBe('高') // 260m
  })

  it('编组生成完整风险清单', () => {
    const result = planBatch({ memberIds: [1, 3], 计划检修日: '2026-10-10', 检修人员: '周立', today: TODAY })
    expect(result.ok).toBe(true)
    expect(result.batch?.riskList).toHaveLength(2)
    expect(result.batch?.status).toBe('待提交')
  })
})

describe('整组落库', () => {
  it('成功落库：缆道进检修中，巡检入口同步配合待办', async () => {
    const planned = planBatch({ memberIds: [1, 3], 计划检修日: '2026-10-10', 检修人员: '周立', today: TODAY })
    const batchId = planned.batch!.id
    const result = await resumeBatch(batchId)
    expect(result.ok).toBe(true)

    const first = cableway(1)
    const third = cableway(3)
    expect(first.status).toBe('检修中')
    expect(third.status).toBe('检修中')
    expect(first['编组批次号']).toBe(batchId)
    expect(third['计划检修日']).toBe('2026-10-10')

    const todos = inspectionTodosOf(batchId)
    expect(todos).toHaveLength(1)
    expect(todos[0].status).toBe('待巡检')
    expect(todos[0]['站点编号']).toBe('城东水文站')
    expect(todos[0]['巡检日期']).toBe('2026-10-10')
    expect(String(todos[0]['检查项目'])).toContain(batchId)

    expect(readBatchesFresh().find((b) => b.id === batchId)?.status).toBe('已完成')
  })

  it('任一项失败不留半批，台账记录断点', async () => {
    const planned = planBatch({ memberIds: [1, 3], 计划检修日: '2026-10-10', 检修人员: '', today: TODAY })
    const batchId = planned.batch!.id
    // 模拟另一个入口在落库前把 CABL-0003 停用了
    patchCableway(3, { status: '已停用' })

    const result = await resumeBatch(batchId)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('断点')

    // 前半批（CABL-0001）也不能落库：业务数据保持原样
    expect(cableway(1).status).toBe('正常运行')
    expect(cableway(1)['编组批次号']).toBeUndefined()
    expect(inspectionTodosOf(batchId)).toHaveLength(0)

    const batch = readBatchesFresh().find((b) => b.id === batchId)!
    expect(batch.status).toBe('失败待续做')
    expect(batch.failedStep).toContain('CABL-0003')
    expect(batch.lastError).toContain('已停用')
  })

  it('失败项从断点续做：修复冲突后接着落库成功', async () => {
    const planned = planBatch({ memberIds: [1, 3], 计划检修日: '2026-10-10', 检修人员: '', today: TODAY })
    const batchId = planned.batch!.id
    patchCableway(3, { status: '已停用' })
    const failed = await resumeBatch(batchId)
    expect(failed.ok).toBe(false)

    // 现场处理完，缆道恢复可排期状态，从断点续做
    patchCableway(3, { status: '正常运行' })
    const resumed = await resumeBatch(batchId)
    expect(resumed.ok).toBe(true)
    expect(cableway(1).status).toBe('检修中')
    expect(cableway(3).status).toBe('检修中')
    expect(inspectionTodosOf(batchId)).toHaveLength(1)
    expect(readBatchesFresh().find((b) => b.id === batchId)?.attempts).toBe(2)
  })
})

describe('并发与幂等', () => {
  it('同一批次重复提交只生效一次', async () => {
    const planned = planBatch({ memberIds: [1, 3], 计划检修日: '2026-10-10', 检修人员: '', today: TODAY })
    const batchId = planned.batch!.id
    const first = await resumeBatch(batchId)
    const second = await resumeBatch(batchId)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.duplicated).toBe(true)
    expect(inspectionTodosOf(batchId)).toHaveLength(1)
  })

  it('两个入口提交相同编组：后到的幂等合并，不重复落库', async () => {
    const input = { memberIds: [1, 3], 计划检修日: '2026-10-10', 检修人员: '', today: TODAY }
    const first = await submitBatch(input)
    expect(first.ok).toBe(true)
    const batchId = first.batch!.id

    // 第二个入口（或另一个标签页）提交同一选择
    const second = await submitBatch(input)
    expect(second.ok).toBe(false)
    expect(second.duplicated).toBe(true)
    expect(inspectionTodosOf(batchId)).toHaveLength(1)
    expect(listRows(INSPECTION_KEY).filter((row) => String(row['编组批次号'] ?? ''))).toHaveLength(1)
  })

  it('并发产生的孪生批次落库时幂等合并', async () => {
    const planned = planBatch({ memberIds: [1, 3], 计划检修日: '2026-10-10', 检修人员: '', today: TODAY })
    const batchA = planned.batch!
    // 模拟两个标签页同时编组：台账里出现同幂等键的第二个批次
    const twin: MaintenanceBatch = {
      ...JSON.parse(JSON.stringify(batchA)),
      id: `${batchA.id}-TWIN`,
      status: '待提交',
    }
    saveBatches([...readBatchesFresh(), twin])

    expect(commitOnce(batchA.id).ok).toBe(true)
    const merged = commitOnce(twin.id)
    expect(merged.ok).toBe(true)
    expect(merged.duplicated).toBe(true)
    expect(merged.batch?.note).toContain(batchA.id)

    // 业务侧只生效了一次
    expect(inspectionTodosOf(batchA.id)).toHaveLength(1)
    expect(inspectionTodosOf(twin.id)).toHaveLength(0)
    expect(cableway(1)['编组批次号']).toBe(batchA.id)
  })
})
