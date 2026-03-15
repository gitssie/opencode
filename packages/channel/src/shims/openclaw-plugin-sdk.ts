/**
 * Minimal shim for `openclaw/plugin-sdk` so wecom (and other) plugins
 * can be loaded without a full openclaw installation.
 *
 * Only the symbols actually imported by the wecom plugin are implemented.
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_ACCOUNT_ID = "default"

// ── emptyPluginConfigSchema ───────────────────────────────────────────────────

export function emptyPluginConfigSchema() {
  return {}
}

// ── formatPairingApproveHint ──────────────────────────────────────────────────

export function formatPairingApproveHint(channelId: string): string {
  return `Approve via: openclaw pairing list ${channelId} / openclaw pairing approve ${channelId} <code>`
}

// ── addWildcardAllowFrom ──────────────────────────────────────────────────────

export function addWildcardAllowFrom(allowFrom?: Array<string | number> | null): string[] {
  const next = (allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean)
  if (!next.includes("*")) next.push("*")
  return next
}

// ── readJsonFileWithFallback ──────────────────────────────────────────────────

export async function readJsonFileWithFallback<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  try {
    const raw = await fs.readFile(filePath, "utf-8")
    const parsed = JSON.parse(raw) as T
    return { value: parsed, exists: true }
  } catch (err) {
    return { value: fallback, exists: (err as { code?: string }).code !== "ENOENT" }
  }
}

// ── writeJsonFileAtomically ───────────────────────────────────────────────────

export async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(os.tmpdir(), `opencode-channel-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  await fs.rename(tmp, filePath)
}

// ── withFileLock ──────────────────────────────────────────────────────────────
// Process-scoped mutex (sufficient for single-process channel adapter).

const locks = new Map<string, Promise<void>>()

export async function withFileLock<T>(filePath: string, _opts: unknown, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(filePath) ?? Promise.resolve()
  let resolve!: () => void
  const next = new Promise<void>((r) => {
    resolve = r
  })
  locks.set(filePath, next)
  await prev
  try {
    return await fn()
  } finally {
    resolve()
    if (locks.get(filePath) === next) locks.delete(filePath)
  }
}
