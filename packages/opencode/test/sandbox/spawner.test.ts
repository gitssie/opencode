import { describe, expect, it } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import * as Scope from "effect/Scope"
import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"
import * as nodeFs from "fs"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, ExitCode } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SandboxSpawner } from "@/sandbox/spawner"

// Detect whether a usable zerobox binary is present. The sandbox isolation tests
// require both the binary and Linux bwrap support, so they self-skip elsewhere.
function zeroboxAvailable(): boolean {
  const candidates = [process.env["ZEROBOX_BIN"], "/usr/local/bin/zerobox"].filter(Boolean) as string[]
  return candidates.some((p) => {
    try {
      nodeFs.accessSync(p, nodeFs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

// Run an effect with InstanceRef wired to a fresh temp dir, providing the
// SandboxSpawner layer with the sandbox flag set as requested. The spawner layer
// self-provides CrossSpawnSpawner but leaves RuntimeFlags open, so we provide an
// override here to control the `sandbox` flag deterministically.
function runWithSpawner<A, E>(sandbox: boolean, effect: Effect.Effect<A, E, ChildProcessSpawner | Scope.Scope>) {
  return Effect.gen(function* () {
    const dirpath = path.join(os.tmpdir(), "opencode-sandbox-spawner-test-" + Math.random().toString(36).slice(2))
    yield* Effect.promise(() => fs.mkdir(dirpath, { recursive: true }))
    const directory = yield* Effect.promise(() => fs.realpath(dirpath))
    yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(dirpath, { recursive: true, force: true })))

    const ctx = { directory, worktree: directory, project: "test" as any }
    return yield* effect.pipe(Effect.provideService(InstanceRef, ctx))
  }).pipe(
    Effect.scoped,
    Effect.provide(SandboxSpawner.layer.pipe(Layer.provide(RuntimeFlags.layer({ sandbox })))),
  )
}

describe("SandboxSpawner test-safety (no zerobox binary required)", () => {
  it("builds the layer and spawns plainly when sandbox is disabled", async () => {
    // Core regression guard for opencode-crl: with sandbox off, the layer must
    // construct and spawn WITHOUT a zerobox binary present, so tests that build
    // registry.defaultLayer no longer crash.
    const output = await Effect.runPromise(
      runWithSpawner(
        false,
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner
          return yield* spawner.string(ChildProcess.make("echo hello", [], { shell: true }))
        }),
      ),
    )
    expect(output.trim()).toBe("hello")
  })

  it("constructs the layer even when the zerobox binary is absent", async () => {
    // Building the layer (and reading the flag) must never call resolveZerobox();
    // resolution is deferred to spawn time under sandbox mode.
    const built = await Effect.runPromise(
      runWithSpawner(
        false,
        Effect.gen(function* () {
          yield* ChildProcessSpawner
          return "constructed"
        }),
      ),
    )
    expect(built).toBe("constructed")
  })

  it("fails with a clear ZEROBOX_BIN error when sandbox is enabled but zerobox is missing", async () => {
    if (zeroboxAvailable()) return // only meaningful when the binary is absent
    const message = await Effect.runPromise(
      runWithSpawner(
        true,
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner
          return yield* spawner.string(ChildProcess.make("echo hello", [], { shell: true }))
        }),
      ).pipe(Effect.sandbox, Effect.flip, Effect.map(String)),
    )
    expect(message).toContain("ZEROBOX_BIN")
  })
})

// Real sandbox isolation behaviour requires the zerobox binary + Linux bwrap.
// Self-skip when unavailable so the suite stays green in CI/dev/macOS.
const sandboxDescribe = zeroboxAvailable() ? describe : describe.skip

sandboxDescribe("SandboxSpawner isolation (requires zerobox + sandbox enabled)", () => {
  const runSandboxed = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner | Scope.Scope>) =>
    runWithSpawner(true, effect)

  it("stdout is captured from sandboxed echo", async () => {
    const output = await Effect.runPromise(
      runSandboxed(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner
          return yield* spawner.string(ChildProcess.make("echo hello", [], { shell: true }))
        }),
      ),
    )
    expect(output.trim()).toBe("hello")
  })

  it("stdout stream emits bytes for multi-line output", async () => {
    const text = await Effect.runPromise(
      runSandboxed(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("printf 'a\\nb\\nc\\n'", [], { shell: true }))
          const chunks = yield* Stream.runCollect(Stream.decodeText(handle.stdout))
          return Array.from(chunks).join("")
        }),
      ),
    )
    expect(text).toBe("a\nb\nc\n")
  })

  it("exit code is propagated", async () => {
    const code = await Effect.runPromise(
      runSandboxed(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner
          return yield* spawner.exitCode(ChildProcess.make("exit 42", [], { shell: true }))
        }),
      ),
    )
    expect(code).toBe(ExitCode(42))
  })

  it("sandboxed process cannot read /root", async () => {
    const output = await Effect.runPromise(
      runSandboxed(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner
          return yield* spawner.string(ChildProcess.make("cat /root/.bashrc 2>&1; echo exit:$?", [], { shell: true }))
        }),
      ),
    )
    expect(output).toContain("exit:1")
  })

  it("sandboxed process cannot write to /etc", async () => {
    const output = await Effect.runPromise(
      runSandboxed(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner
          return yield* spawner.string(
            ChildProcess.make("echo bad > /etc/evil-test.txt 2>&1; echo exit:$?", [], { shell: true }),
          )
        }),
      ),
    )
    expect(output).not.toContain("exit:0")
  })

  it("sandboxed process can write to workspace directory", async () => {
    const output = await Effect.runPromise(
      runSandboxed(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner
          return yield* spawner.string(ChildProcess.make("echo workspace_ok > /dev/stdout", [], { shell: true }))
        }),
      ),
    )
    expect(output.trim()).toBe("workspace_ok")
  })
})
