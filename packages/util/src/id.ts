import z from "zod"

const prefixes = {
  session: "ses",
  message: "msg",
  permission: "per",
  user: "usr",
  part: "prt",
  pty: "pty",
} as const

type Prefix = keyof typeof prefixes

const LENGTH = 26
let lastTimestamp = 0
let counter = 0

export namespace Identifier {
  export function schema(prefix: Prefix) {
    return z.string().startsWith(prefixes[prefix])
  }

  export function ascending(prefix: Prefix, given?: string) {
    return generateID(prefix, false, given)
  }

  export function descending(prefix: Prefix, given?: string) {
    return generateID(prefix, true, given)
  }
}

function generateID(prefix: Prefix, desc: boolean, given?: string): string {
  if (!given) return create(prefix, desc)
  if (!given.startsWith(prefixes[prefix])) throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  return given
}

function create(prefix: Prefix, desc: boolean, timestamp?: number): string {
  const ts = timestamp ?? Date.now()
  if (ts !== lastTimestamp) {
    lastTimestamp = ts
    counter = 0
  }
  counter++
  let now = BigInt(ts) * BigInt(0x1000) + BigInt(counter)
  if (desc) now = ~now
  const b = new Uint8Array(6)
  for (let i = 0; i < 6; i++) b[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
  return prefixes[prefix] + "_" + bytesToHex(b) + randomBase62(LENGTH - 12)
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ""
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0")
  return hex
}

function randomBase62(n: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  const bytes = new Uint8Array(n)
  if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  let s = ""
  for (let i = 0; i < n; i++) s += chars[bytes[i]! % 62]
  return s
}
