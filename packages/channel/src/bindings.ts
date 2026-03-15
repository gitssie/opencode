/**
 * channel-bindings.json CRUD
 *
 * Schema (flat map of sessionKey → BindingEntry):
 * {
 *   [sessionKey: string]: BindingEntry
 * }
 *
 * File: ~/.config/opencode/channel-bindings.json
 */

import path from "node:path"
import { xdgConfig } from "xdg-basedir"
import { readJsonFileWithFallback, withFileLock, writeJsonFileAtomically } from "./shims/openclaw-plugin-sdk.ts"

const FILE = path.join(xdgConfig!, "opencode", "channel-bindings.json")
const LOCK_OPTS = { retries: { retries: 20, factor: 1.5, minTimeout: 50, maxTimeout: 500 }, stale: 5000 }

export type BindingEntry = {
  directory: string
  sessionID: string | null
  pairedAt: number
}

type Store = Record<string, BindingEntry>

async function load(): Promise<Store> {
  const { value } = await readJsonFileWithFallback<Store>(FILE, {})
  return value && typeof value === "object" ? value : {}
}

export async function getBinding(key: string): Promise<BindingEntry | undefined> {
  const store = await load()
  return store[key]
}

export async function setBinding(key: string, entry: BindingEntry): Promise<void> {
  await withFileLock(FILE, {}, async () => {
    const store = await load()
    store[key] = entry
    await writeJsonFileAtomically(FILE, store)
  })
}

export async function updateBinding(key: string, patch: Partial<BindingEntry>): Promise<void> {
  await withFileLock(FILE, {}, async () => {
    const store = await load()
    const prev = store[key]
    if (prev) store[key] = { ...prev, ...patch }
    await writeJsonFileAtomically(FILE, store)
  })
}

export async function listBindings(): Promise<Record<string, BindingEntry>> {
  return load()
}
