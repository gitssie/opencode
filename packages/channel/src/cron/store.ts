import { mkdir, rename } from "node:fs/promises"
import path from "node:path"
import { xdgConfig } from "xdg-basedir"
import type { CronJob, CronStoreFile } from "./types.ts"

export const DEFAULT_STORE_PATH = path.join(xdgConfig!, "opencode", "cron", "jobs.json")

export async function loadCronStore(p = DEFAULT_STORE_PATH): Promise<CronStoreFile> {
  const file = Bun.file(p)
  if (!(await file.exists())) return { version: 1, jobs: [] }
  try {
    const data = await file.json()
    if (data && typeof data === "object" && Array.isArray(data.jobs)) return data as CronStoreFile
  } catch {
    // corrupt — try backup
    const bak = Bun.file(`${p}.bak`)
    if (await bak.exists()) {
      try {
        const data = await bak.json()
        if (data && typeof data === "object" && Array.isArray(data.jobs)) return data as CronStoreFile
      } catch {
        // ignore
      }
    }
  }
  return { version: 1, jobs: [] }
}

export async function saveCronStore(store: CronStoreFile, p = DEFAULT_STORE_PATH): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  // backup existing
  const existing = Bun.file(p)
  if (await existing.exists()) await Bun.write(`${p}.bak`, await existing.arrayBuffer())
  // atomic write
  await Bun.write(tmp, JSON.stringify(store, null, 2))
  await rename(tmp, p)
}

export function findJob(store: CronStoreFile, id: string): CronJob | undefined {
  return store.jobs.find((j) => j.id === id)
}

export function upsertJob(store: CronStoreFile, job: CronJob): void {
  const idx = store.jobs.findIndex((j) => j.id === job.id)
  if (idx >= 0) store.jobs[idx] = job
  else store.jobs.push(job)
}

export function removeJob(store: CronStoreFile, id: string): boolean {
  const idx = store.jobs.findIndex((j) => j.id === id)
  if (idx < 0) return false
  store.jobs.splice(idx, 1)
  return true
}
