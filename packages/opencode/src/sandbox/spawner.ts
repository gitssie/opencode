import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import fs from "fs"

// The zerobox binary path is resolved from ZEROBOX_BIN env var, then the
// well-known system install location. No npm package fallback — the binary
// must be pre-installed in the environment (e.g. via Dockerfile or local install).
const CANDIDATE_PATHS = [process.env["ZEROBOX_BIN"], "/usr/local/bin/zerobox"].filter(Boolean) as string[]

// Resolve the zerobox binary path. Returns the first executable candidate, or
// throws a clear error naming ZEROBOX_BIN. Called LAZILY (at spawn time, only
// when sandbox mode is enabled) so constructing the layer never crashes in
// environments without the binary (CI/dev/test).
function resolveZerobox(): string {
  for (const p of CANDIDATE_PATHS) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {}
  }
  throw new Error(
    `zerobox binary not found. Install it at /usr/local/bin/zerobox or set ZEROBOX_BIN. ` +
      `Download from https://github.com/afshinm/zerobox/releases`,
  )
}

export const layer = Layer.effect(
  ChildProcessSpawner,
  Effect.gen(function* () {
    const real = yield* ChildProcessSpawner
    const flags = yield* RuntimeFlags.Service

    // When sandbox mode is off, use the plain spawner unchanged. This keeps
    // non-sandbox environments — and any test that builds registry.defaultLayer
    // — working without a zerobox binary, because resolveZerobox() is never
    // called and the layer constructs cleanly.
    if (!flags.sandbox) return real

    return makeSpawner((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* real.spawn(command)

        // Resolve the zerobox binary lazily, only when an actual command is
        // spawned in sandbox mode. Failing here (rather than at layer build)
        // surfaces a clear ZEROBOX_BIN error exactly when the sandbox is used.
        const zeroboxBin = yield* Effect.try({
          try: () => resolveZerobox(),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }).pipe(Effect.orDie)

        // Read directory per-invocation so it respects the current instance context.
        const directory = yield* InstanceState.directory

        // Always use the instance workspace as cwd — the sandbox already
        // limits filesystem access to the workspace, so any other cwd would
        // either be outside the sandbox or duplicate the sandbox boundary.
        const cwd = directory
        const sandboxFlags = buildZeroboxFlags(directory, zeroboxBin)

        // Shell commands: wrap in sh -c so the full shell command string is executed.
        // Non-shell commands: pass binary + args directly.
        const isShell = !!command.options.shell
        const zeroboxArgs = isShell
          ? [...sandboxFlags, "--", "sh", "-c", command.command]
          : [...sandboxFlags, "--", command.command, ...command.args]

        return yield* real.spawn(
          ChildProcess.make(zeroboxBin, zeroboxArgs, {
            cwd,
            env: command.options.env,
            stdin: command.options.stdin,
            stdout: command.options.stdout,
            detached: command.options.detached,
            killSignal: command.options.killSignal,
          }),
        )
      }),
    )
  }),
).pipe(Layer.provide(CrossSpawnSpawner.defaultLayer))

// Note: RuntimeFlags is intentionally left as an open requirement on `layer` so
// callers (registry.defaultLayer, tests) provide it and can override the
// `sandbox` flag. CrossSpawnSpawner is self-provided as the underlying real
// spawner.

// LayerNode form for the ToolRegistry.node graph (used by the httpapi server /
// prompt runtime). RuntimeFlags is supplied as a child node; this gives the node
// graph the same sandbox-gated spawner as defaultLayer.
export const node = LayerNode.make(layer, [RuntimeFlags.node])

// When the binary is at a system path (not under /root), we can safely deny
// /root and /home entirely. Otherwise fall back to denying only known
// credential subdirectories to avoid blocking the binary itself.
function buildZeroboxFlags(workspaceDir: string, zeroboxBin: string): string[] {
  const canDenyRoot = !zeroboxBin.startsWith("/root")
  const denyPaths = canDenyRoot ? ["/root", "/home"] : ["/root/.ssh", "/root/.gnupg", "/home"]
  const deny = denyPaths.flatMap((p) => ["--deny-read", p])
  return [
    "--profile",
    "system-read-linux",
    "--allow-read",
    workspaceDir,
    "--allow-write",
    workspaceDir,
    "--allow-net",
    ...deny,
  ]
}

export * as SandboxSpawner from "./spawner"
