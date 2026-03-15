import fs from "node:fs/promises"
import path from "node:path"

export function buildRuntimeMedia(baseDir: string) {
  return {
    async fetchRemoteMedia(params: { url: string }) {
      const res = await fetch(params.url)
      return {
        buffer: await res.arrayBuffer(),
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
      }
    },

    async saveMediaBuffer(buf: ArrayBuffer, mime: string, dir: string, _maxBytes: number, filename?: string) {
      const name = filename ?? `media-${Date.now()}.bin`
      const resolved = path.isAbsolute(dir) ? path.join(dir, name) : path.join(baseDir, dir, name)
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, Buffer.from(buf))
      return { path: resolved, contentType: mime }
    },
  }
}
