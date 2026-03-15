import fs from "node:fs/promises"
import path from "node:path"
import { listBindings } from "../bindings.ts"

export function buildRuntimeMedia(fallbackDir: string) {
  return {
    async fetchRemoteMedia(params: { url: string }) {
      const res = await fetch(params.url)
      return {
        buffer: await res.arrayBuffer(),
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
      }
    },

    async saveMediaBuffer(
      buf: ArrayBuffer,
      mime: string,
      dir: string,
      _maxBytes: number,
      filename?: string,
      accountId?: string,
    ) {
      const name = filename ?? `media-${Date.now()}.bin`
      let base = fallbackDir
      // resolve project workspace dir from bindings when possible
      const bindings = await listBindings()
      const entries = Object.entries(bindings)
      if (entries.length > 0) {
        // pick the binding matching accountId prefix, or first binding
        const match = accountId ? entries.find(([k]) => k.startsWith(accountId + ":")) : undefined
        const [, entry] = match ?? entries[0]
        base = path.join(entry.directory, "media")
      }
      const resolved = path.isAbsolute(dir) ? path.join(dir, name) : path.join(base, dir, name)
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, Buffer.from(buf))
      return { path: resolved, contentType: mime }
    },
  }
}
