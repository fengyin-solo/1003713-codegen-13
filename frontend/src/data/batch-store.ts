import type { MaintenanceBatch } from './types'

// 编组批次台账单独存一份：业务数据（缆道、巡检）整批落库，台账记录进度与断点，
// 两边通过幂等步骤自愈——台账没写完时续做会跳过业务里已生效的部分。
const STORAGE_KEY = 'hydrology-monitor-station:cableway-batches'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): MaintenanceBatch[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as MaintenanceBatch[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

let cache: MaintenanceBatch[] | null = null

export function listBatches(): MaintenanceBatch[] {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

/** 绕过缓存直读：提交、续做前复核台账，避免和另一个入口的判断脱节。 */
export function readBatchesFresh(): MaintenanceBatch[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(listBatches())
  }
  return readStorage()
}

export function saveBatches(batches: MaintenanceBatch[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(batches))
  }
  cache = batches
}

export function invalidateBatchCache(): void {
  cache = null
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) {
      cache = null
    }
  })
}
