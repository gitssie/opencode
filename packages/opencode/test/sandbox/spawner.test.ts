import { describe, expect } from "bun:test"
import { Effect, Layer, Stream, Scope } from "effect"
import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, ExitCode } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstanceRef } from "@/effect/instance-ref"
import { SandboxSpawner } from "@/sandbox/spawner"
import { it } from "../lib/effect"

// Minimal layer: no DB, no InstanceStore — just InstanceRef wired directly.
function withSandboxInstance<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const dirpath = path.join(os.tmpdir(), "opencode-sandbox-test-" + Math.random().toString(36).slice(2))
    yield* Effect.promise(() => fs.mkdir(dirpath, { recursive: true }))
    const directory = yield* Effect.promise(() => fs.realpath(dirpath))
    yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(dirpath, { recursive: true, force: true })))

    const ctx = { directory, worktree: directory, project: "test" as any }
    return yield* effect.pipe(Effect.provideService(InstanceRef, ctx))
  }).pipe(
    Effect.scoped,
    Effect.provide(SandboxSpawner.layer),
    Effect.provide(CrossSpawnSpawner.defaultLayer),
  )
}

describe("SandboxSpawner", () => {
  it.live("stdout is captured from sandboxed echo", () =>
    withSandboxInstance(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const output = yield* spawner.string(ChildProcess.make("echo hello", [], { shell: true }))
        expect(output.trim()).toBe("hello")
      }),
    ),
  )

  it.live("stdout stream emits bytes for multi-line output", () =>
    withSandboxInstance(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("printf 'a\\nb\\nc\\n'", [], { shell: true }))
        const chunks = yield* Stream.runCollect(Stream.decodeText(handle.stdout))
        const text = Array.from(chunks).join("")
        expect(text).toBe("a\nb\nc\n")
      }),
    ),
  )

  it.live("exit code is propagated", () =>
    withSandboxInstance(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const code = yield* spawner.exitCode(ChildProcess.make("exit 42", [], { shell: true }))
        expect(code).toBe(ExitCode(42))
      }),
    ),
  )
})
