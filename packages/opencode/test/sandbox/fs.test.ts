import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as Scope from "effect/Scope"
import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SandboxFs } from "@/sandbox/fs"

// Run an effect with InstanceRef wired to a fresh temp workspace, providing
// SandboxFs over FSUtil with the sandbox flag set as requested. SandboxFs.layer
// self-provides FSUtil.defaultLayer but leaves RuntimeFlags open so the test
// controls the `sandbox` flag.
function runWithSandboxFs<A, E>(
  sandbox: boolean,
  effect: Effect.Effect<A, E, FSUtil.Service | Scope.Scope>,
) {
  return Effect.gen(function* () {
    const dirpath = path.join(os.tmpdir(), "opencode-sandbox-fs-test-" + Math.random().toString(36).slice(2))
    yield* Effect.promise(() => fs.mkdir(dirpath, { recursive: true }))
    const directory = yield* Effect.promise(() => fs.realpath(dirpath))
    yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(dirpath, { recursive: true, force: true })))

    const ctx = { directory, worktree: directory, project: "test" as any }
    return yield* effect.pipe(Effect.provideService(InstanceRef, ctx))
  }).pipe(Effect.scoped, Effect.provide(SandboxFs.layer.pipe(Layer.provide(RuntimeFlags.layer({ sandbox })))))
}

describe("SandboxFs (sandbox enabled)", () => {
  it("allows reading and writing files inside the workspace", async () => {
    const content = await Effect.runPromise(
      runWithSandboxFs(
        true,
        Effect.gen(function* () {
          const fss = yield* FSUtil.Service
          // Write inside the instance workspace directory, which is on the
          // allow-list. (Use InstanceRef to learn the workspace path.)
          const ctx = yield* InstanceRef
          const target = path.join(ctx!.directory, "hello.txt")
          yield* fss.writeFileString(target, "world")
          return yield* fss.readFileString(target)
        }),
      ),
    )
    expect(content).toBe("world")
  })

  it("denies reading files outside the workspace (e.g. /root)", async () => {
    const tag = await Effect.runPromise(
      runWithSandboxFs(
        true,
        Effect.gen(function* () {
          const fss = yield* FSUtil.Service
          return yield* fss.readFileString("/root/.bashrc").pipe(Effect.exit)
        }),
      ),
    )
    expect(tag._tag).toBe("Failure")
  })

  it("denies writing files outside the workspace (e.g. /etc)", async () => {
    const tag = await Effect.runPromise(
      runWithSandboxFs(
        true,
        Effect.gen(function* () {
          const fss = yield* FSUtil.Service
          return yield* fss.writeFileString("/etc/evil.txt", "bad").pipe(Effect.exit)
        }),
      ),
    )
    expect(tag._tag).toBe("Failure")
  })

  it("exists() returns false for denied paths instead of erroring", async () => {
    const result = await Effect.runPromise(
      runWithSandboxFs(
        true,
        Effect.gen(function* () {
          const fss = yield* FSUtil.Service
          return yield* fss.exists("/root/.bashrc")
        }),
      ),
    )
    expect(result).toBe(false)
  })

  it("isFile() returns false for denied paths instead of erroring", async () => {
    const result = await Effect.runPromise(
      runWithSandboxFs(
        true,
        Effect.gen(function* () {
          const fss = yield* FSUtil.Service
          return yield* fss.isFile("/root/.bashrc")
        }),
      ),
    )
    expect(result).toBe(false)
  })

  it("allows reading system paths like /tmp", async () => {
    const result = await Effect.runPromise(
      runWithSandboxFs(
        true,
        Effect.gen(function* () {
          const fss = yield* FSUtil.Service
          return yield* fss.exists("/tmp")
        }),
      ),
    )
    expect(result).toBe(true)
  })
})

describe("SandboxFs (sandbox disabled = passthrough)", () => {
  it("permits access outside the workspace when sandbox is off", async () => {
    // With sandbox off the wrapper must not interfere: /etc should be readable
    // (it exists on the host) just like the unwrapped FSUtil service.
    const result = await Effect.runPromise(
      runWithSandboxFs(
        false,
        Effect.gen(function* () {
          const fss = yield* FSUtil.Service
          return yield* fss.exists("/etc")
        }),
      ),
    )
    expect(result).toBe(true)
  })
})
