/**
 * runtime/pairing.ts
 *
 * Mirrors openclaw's pairing-store.ts logic, using the same file paths and
 * JSON schema so that the wecom plugin's pairing flow works correctly.
 *
 * File paths (same as openclaw):
 *   ~/.openclaw/credentials/{channel}-pairing.json       → pending requests
 *   ~/.openclaw/credentials/{channel}-{accountId}-allowFrom.json → approved senders
 *
 * If OPENCLAW_STATE_DIR is set, that overrides ~/.openclaw.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { xdgState } from "xdg-basedir"
import { withFileLock, readJsonFileWithFallback, writeJsonFileAtomically } from "../shims/openclaw-plugin-sdk.ts"

// ── Constants ─────────────────────────────────────────────────────────────────

const CODE_LEN = 8
const CODE_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const TTL_MS = 60 * 60 * 1000
const MAX_PENDING = 3
const DEFAULT_ACCOUNT = "default"
const LOCK_OPTS = {
  retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
  stale: 30_000,
} as const

// ── Path helpers ──────────────────────────────────────────────────────────────

function credentialsDir(): string {
  return path.join(xdgState!, "opencode", "credentials")
}

function safe(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\.\./g, "_")
  if (!s || s === "_") throw new Error(`invalid key: ${raw}`)
  return s
}

function pairingPath(channel: string): string {
  return path.join(credentialsDir(), `${safe(channel)}-pairing.json`)
}

function allowFromPath(channel: string, accountId?: string): string {
  const base = safe(channel)
  const acc = accountId?.trim() ? safe(accountId) : ""
  if (!acc || acc === DEFAULT_ACCOUNT) {
    // account-scoped file for the default account
    return path.join(credentialsDir(), `${base}-${DEFAULT_ACCOUNT}-allowFrom.json`)
  }
  return path.join(credentialsDir(), `${base}-${acc}-allowFrom.json`)
}

function legacyAllowFromPath(channel: string): string {
  return path.join(credentialsDir(), `${safe(channel)}-allowFrom.json`)
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

type PairingRequest = {
  id: string
  code: string
  createdAt: string
  lastSeenAt: string
  meta?: Record<string, string>
}

type PairingStore = { version: 1; requests: PairingRequest[] }
type AllowFromStore = { version: 1; allowFrom: string[] }

const EMPTY_PAIRING: PairingStore = { version: 1, requests: [] }
const EMPTY_ALLOW: AllowFromStore = { version: 1, allowFrom: [] }

async function ensureDir(file: string) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
}

async function readPairing(file: string): Promise<PairingRequest[]> {
  const { value } = await readJsonFileWithFallback<PairingStore>(file, EMPTY_PAIRING)
  return Array.isArray(value.requests) ? value.requests : []
}

async function writePairing(file: string, reqs: PairingRequest[]) {
  await ensureDir(file)
  await writeJsonFileAtomically(file, { version: 1, requests: reqs } satisfies PairingStore)
}

async function readAllowFrom(file: string): Promise<string[]> {
  const { value } = await readJsonFileWithFallback<AllowFromStore>(file, EMPTY_ALLOW)
  return Array.isArray(value.allowFrom) ? value.allowFrom.map(String).filter(Boolean) : []
}

async function writeAllowFrom(file: string, list: string[]) {
  await ensureDir(file)
  await writeJsonFileAtomically(file, { version: 1, allowFrom: list } satisfies AllowFromStore)
}

// ── Code generation ───────────────────────────────────────────────────────────

function genCode(existing: Set<string>): string {
  for (let i = 0; i < 500; i++) {
    let out = ""
    for (let j = 0; j < CODE_LEN; j++) out += CODE_ALPHA[crypto.randomInt(0, CODE_ALPHA.length)]
    if (!existing.has(out)) return out
  }
  throw new Error("failed to generate unique pairing code")
}

// ── Expiry helpers ────────────────────────────────────────────────────────────

function expired(req: PairingRequest, now: number): boolean {
  const t = Date.parse(req.createdAt)
  return !Number.isFinite(t) || now - t > TTL_MS
}

function prune(reqs: PairingRequest[], now: number): PairingRequest[] {
  return reqs.filter((r) => !expired(r, now))
}

function cap(reqs: PairingRequest[]): PairingRequest[] {
  if (reqs.length <= MAX_PENDING) return reqs
  return reqs
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-MAX_PENDING)
}

// ── Account matching ──────────────────────────────────────────────────────────

function matchAccount(req: PairingRequest, normalized: string): boolean {
  if (!normalized) return true
  return (
    String(req.meta?.accountId ?? "")
      .trim()
      .toLowerCase() === normalized
  )
}

// ── Public API ────────────────────────────────────────────────────────────────

export function buildRuntimePairing() {
  return {
    /**
     * Called by wecom plugin (two call signatures):
     *   old: readAllowFromStore(channel, env?, accountId?)  ← positional
     *   new: readAllowFromStore({ channel, accountId, env? }) ← object
     */
    async readAllowFromStore(
      channelOrParams: string | { channel: string; accountId?: string; env?: NodeJS.ProcessEnv },
      _env?: NodeJS.ProcessEnv,
      accountId?: string,
    ): Promise<string[]> {
      const channel = typeof channelOrParams === "string" ? channelOrParams : channelOrParams.channel
      const acc = typeof channelOrParams === "string" ? accountId : channelOrParams.accountId

      const normalized = acc?.trim().toLowerCase() || DEFAULT_ACCOUNT
      const scopedFile = allowFromPath(channel, normalized)
      const legacy = legacyAllowFromPath(channel)

      const [scoped, leg] = await Promise.all([readAllowFrom(scopedFile), readAllowFrom(legacy)])
      const seen = new Set<string>()
      return [...scoped, ...leg].filter((v) => {
        if (seen.has(v)) return false
        seen.add(v)
        return true
      })
    },

    async upsertPairingRequest(params: {
      channel: string
      id: string
      accountId: string
      meta?: Record<string, string | undefined | null>
      env?: NodeJS.ProcessEnv
    }): Promise<{ code: string; created: boolean }> {
      const file = pairingPath(params.channel)
      await ensureDir(file)

      return withFileLock(file, EMPTY_PAIRING, async () => {
        const now = new Date().toISOString()
        const nowMs = Date.now()
        const id = params.id.trim()
        const acc = params.accountId.trim().toLowerCase() || DEFAULT_ACCOUNT
        const metaBase = params.meta
          ? Object.fromEntries(
              Object.entries(params.meta)
                .map(([k, v]) => [k, String(v ?? "").trim()] as const)
                .filter(([, v]) => Boolean(v)),
            )
          : undefined
        const meta = { ...metaBase, accountId: acc }

        let reqs = prune(await readPairing(file), nowMs)
        const existing = reqs.find((r) => r.id === id && matchAccount(r, acc))

        if (existing) {
          const code = existing.code || genCode(new Set(reqs.map((r) => r.code)))
          reqs = reqs.map((r) => (r === existing ? { ...r, code, lastSeenAt: now, meta } : r))
          await writePairing(file, cap(reqs))
          return { code, created: false }
        }

        reqs = cap(reqs)
        if (reqs.length >= MAX_PENDING) {
          await writePairing(file, reqs)
          return { code: "", created: false }
        }

        const code = genCode(new Set(reqs.map((r) => r.code)))
        await writePairing(file, [...reqs, { id, code, createdAt: now, lastSeenAt: now, meta }])
        return { code, created: true }
      })
    },

    buildPairingReply(params: { channel: string; idLine: string; code: string }): string {
      return [
        "OpenClaw: access not configured.",
        "",
        params.idLine,
        "",
        `Pairing code: ${params.code}`,
        "",
        "Ask the bot owner to approve with:",
        `openclaw pairing approve ${params.channel} ${params.code}`,
      ].join("\n")
    },

    /**
     * Approve a pairing code: move from pending → allowFrom.
     * Called externally (e.g. from opencode UI or CLI).
     */
    async approvePairingCode(params: {
      channel: string
      code: string
      accountId?: string
    }): Promise<{ id: string } | null> {
      const file = pairingPath(params.channel)
      const code = params.code.trim().toUpperCase()
      if (!code) return null

      return withFileLock(file, EMPTY_PAIRING, async () => {
        const nowMs = Date.now()
        const reqs = prune(await readPairing(file), nowMs)
        const acc = params.accountId?.trim().toLowerCase() || ""
        const idx = reqs.findIndex((r) => r.code.toUpperCase() === code && matchAccount(r, acc))
        if (idx < 0) return null

        const entry = reqs[idx]!
        reqs.splice(idx, 1)
        await writePairing(file, reqs)

        const entryAcc = String(entry.meta?.accountId ?? "").trim() || DEFAULT_ACCOUNT
        const af = allowFromPath(params.channel, params.accountId || entryAcc)
        const current = await readAllowFrom(af)
        if (!current.includes(entry.id)) {
          await writeAllowFrom(af, [...current, entry.id])
        }
        return { id: entry.id }
      })
    },
  }
}
