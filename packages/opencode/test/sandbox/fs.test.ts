import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceRef } from "@/effect/instance-ref"
import { Instance } from "@/project/instance"
import { SandboxFs } from "@/sandbox/fs"

// Minimal layer: no DB — just InstanceRef wired directly to a temp dir.
// Instance.restore is required because fs.ts reads Instance.directory via ALS.
async function runWithSandboxFs<A, E>(effect: Effect.Effect<A, E, AppFileSystem.Service>) {
  const dirpath = path.join(os.tmpdir(), "opencode-sandbox-fs-test-" + Math.random().toString(36).slice(2))
  await fs.mkdir(dirpath, { recursive: true })
  const directory = await fs.realpath(dirpath)
  try {
    const ctx = { directory, worktree: directory, project: "test" as any }
    return await Instance.restore(ctx, () =>
      Effect.runPromise(
        effect.pipe(
          Effect.scoped,
          Effect.provideService(InstanceRef, ctx),
          Effect.provide(SandboxFs.layer),
        ),
      ),
    )
  } finally {
    await fs.rm(dirpath, { recursive: true, force: true })
  }
}

// SandboxFs.layer provides AppFileSystem with path-based access control.
// Workspace reads and writes are allowed; paths outside (like /root, /home) are denied.

describe("SandboxFs", () => {
  it("allows reading files inside workspace", () =>
    runWithSandboxFs(
      Effect.gen(function* () {
        const fss = yield* AppFileSystem.Service
        const tmp = yield* fss.makeTempDirectoryScoped()
        yield* fss.writeFileString(tmp + "/hello.txt", "world")
        const content = yield* fss.readFileString(tmp + "/hello.txt")
        expect(content).toBe("world")
      }).pipe(Effect.scoped),
    ),
  )

  it("denies reading files outside workspace (e.g. /root)", () =>
    runWithSandboxFs(
      Effect.gen(function* () {
        const fss = yield* AppFileSystem.Service
        const result = yield* fss.readFileString("/root/.bashrc").pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it("exists() returns false for denied paths instead of error", () =>
    runWithSandboxFs(
      Effect.gen(function* () {
        const fss = yield* AppFileSystem.Service
        const result = yield* fss.exists("/root/.bashrc")
        expect(result).toBe(false)
      }),
    ),
  )

  it("denies writing files outside workspace (e.g. /etc)", () =>
    runWithSandboxFs(
      Effect.gen(function* () {
        const fss = yield* AppFileSystem.Service
        const result = yield* fss.writeFileString("/etc/evil.txt", "bad").pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it("allows reading system paths like /tmp", () =>
    runWithSandboxFs(
      Effect.gen(function* () {
        const fss = yield* AppFileSystem.Service
        const result = yield* fss.exists("/tmp")
        expect(result).toBe(true)
      }),
    ),
  )

  it("isFile() returns false for denied paths instead of error", () =>
    runWithSandboxFs(
      Effect.gen(function* () {
        const fss = yield* AppFileSystem.Service
        const result = yield* fss.isFile("/root/.bashrc")
        expect(result).toBe(false)
      }),
    ),
  )
})
