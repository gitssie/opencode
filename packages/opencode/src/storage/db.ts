import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres"
export * from "drizzle-orm"
import { LocalContext } from "@/util/local-context"
import { lazy } from "../util/lazy"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { NamedError } from "@opencode-ai/core/util/error"
import { Flag } from "@opencode-ai/core/flag/flag"
import { InstanceState } from "@/effect/instance-state"
import { init } from "#db"
import { Schema } from "effect"
import path from "path"
import { readFileSync, existsSync } from "fs"

export const NotFoundError = NamedError.create("NotFoundError", {
  message: Schema.String,
})

const log = Log.create({ service: "db" })

export const Path = lazy(() => {
  if (Flag.OPENCODE_DB) return Flag.OPENCODE_DB
  if (process.env.OPENCODE_DB_URL) return process.env.OPENCODE_DB_URL

  const configFile = path.join(Global.Path.data, "db.json")
  if (existsSync(configFile)) {
    try {
      const parsed = JSON.parse(readFileSync(configFile, "utf-8"))
      if (typeof parsed?.url === "string") return parsed.url
    } catch {
      log.warn("failed to parse db.json config file", { path: configFile })
    }
  }

  throw new Error("OPENCODE_DB_URL is not configured")
})

export type Transaction = NodePgTransaction<Record<string, never>, any, any>

type Client = NodePgDatabase

export const Client = lazy(() => {
  log.info("opening database", { url: Path() })
  return init(Path())
})

export async function close() {
  if (!Client.loaded()) return
  await (Client() as any).$client?.end?.()
  Client.reset()
}

export type TxOrDb = Transaction | Client

const ctx = LocalContext.create<{
  tx: TxOrDb
  effects: (() => void | Promise<void>)[]
}>("database")

export function use<T>(callback: (trx: TxOrDb) => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(callback(ctx.use().tx))
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const result = ctx.provide({ effects, tx: Client() }, () => Promise.resolve(callback(Client())))
      return result.then((v) => {
        for (const effect of effects) effect()
        return v
      })
    }
    return Promise.reject(err)
  }
}

export function effect(fn: () => any | Promise<any>) {
  const bound = InstanceState.bind(fn)
  try {
    ctx.use().effects.push(bound)
  } catch {
    bound()
  }
}

export function transaction<T>(
  callback: (tx: TxOrDb) => T | Promise<T>,
  // PostgreSQL does not use SQLite-style behavior flags; the parameter is
  // kept for call-site compatibility but ignored.
  _options?: {
    behavior?: "deferred" | "immediate" | "exclusive"
  },
): Promise<T> {
  try {
    return Promise.resolve(callback(ctx.use().tx))
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const txCallback = InstanceState.bind((tx: TxOrDb) =>
        ctx.provide({ tx, effects }, () => Promise.resolve(callback(tx))),
      )
      return (Client() as NodePgDatabase).transaction(txCallback).then((result) => {
        for (const effect of effects) effect()
        return result
      })
    }
    return Promise.reject(err)
  }
}

export * as Database from "./db"
