import nodePath from "path"
import { customType } from "drizzle-orm/pg-core"
import { AbsolutePath } from "../schema"

function storagePath(input: string) {
  if (process.platform !== "win32") return input
  return input.replaceAll("\\", "/")
}

function isWindowsStoragePath(input: string) {
  return /^[A-Za-z]:\//.test(input) || input.startsWith("//")
}

function absolute(input: string) {
  const result = storagePath(input)
  if (!nodePath.posix.isAbsolute(result) && !(process.platform === "win32" && isWindowsStoragePath(result))) {
    throw new Error(`Path is not absolute: ${input}`)
  }
  return result
}

function toPlatform(input: string) {
  if (process.platform !== "win32" || !isWindowsStoragePath(input)) return input
  return input.replaceAll("/", "\\")
}

export const absoluteColumn = customType<{
  data: AbsolutePath
  driverData: string
  driverOutput: string
}>({
  dataType() {
    return "text"
  },
  toDriver(input) {
    return absolute(input)
  },
  fromDriver(input) {
    return AbsolutePath.make(toPlatform(absolute(input)))
  },
})

// Legacy sessions may persist an empty directory. Keep that existing value
// readable while normalizing and validating every real directory.
export const directoryColumn = customType<{
  data: string
  driverData: string
  driverOutput: string
}>({
  dataType() {
    return "text"
  },
  toDriver(input) {
    return input ? absolute(input) : input
  },
  fromDriver(input) {
    return input ? toPlatform(absolute(input)) : input
  },
})

export const pathColumn = customType<{
  data: string
  driverData: string
  driverOutput: string
}>({
  dataType() {
    return "text"
  },
  toDriver(input) {
    return storagePath(input)
  },
  fromDriver(input) {
    return storagePath(input)
  },
})

/**
 * Postgres has no equivalent of sqlite's `text({ mode: "json" })`, which
 * auto-serializes on write and parses on read. This customType reproduces that
 * behaviour over a plain `text` column (storage parity with the old sqlite
 * schema) while keeping the typed `$type<T>()` brand honest.
 *
 * Usage: `jsonColumn<Foo>()` — returns a `text` column that JSON-(de)serializes.
 */
export const jsonColumn = <T>() =>
  customType<{ data: T; driverData: string; driverOutput: string }>({
    dataType() {
      return "text"
    },
    toDriver(input) {
      return JSON.stringify(input)
    },
    fromDriver(input) {
      return JSON.parse(input) as T
    },
  })()

export const absoluteArrayColumn = customType<{
  data: AbsolutePath[]
  driverData: string
  driverOutput: string
}>({
  dataType() {
    return "text"
  },
  toDriver(input) {
    return JSON.stringify(input.map(absolute))
  },
  fromDriver(input) {
    return (JSON.parse(input) as string[]).map((item) => AbsolutePath.make(toPlatform(absolute(item))))
  },
})
