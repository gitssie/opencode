import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import fs from "fs"

// The zerobox binary path is resolved from ZEROBOX_BIN env var, then the
// well-known system install location. No npm package fallback — the binary
// must be pre-installed in the environment (e.g. via Dockerfile or local install).
const CANDIDATE_PATHS = [
  process.env["ZEROBOX_BIN"],
  "/usr/local/bin/zerobox",
].filter(Boolean) as string[]

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

    // Resolve zerobox binary path once per layer instantiation.
    const zeroboxBin = yield* Effect.sync(() => resolveZerobox())

    return makeSpawner((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* real.spawn(command)

        // Read directory per-invocation so it respects the current instance context.
        const directory = yield* InstanceState.directory

        // Always use the instance workspace as cwd — the sandbox already
        // limits filesystem access to the workspace, so any other cwd would
        // either be outside the sandbox or duplicate the sandbox boundary.
        const cwd = directory
        const flags = buildZeroboxFlags(directory, zeroboxBin)

        // Shell commands: wrap in sh -c so the full shell command string is executed.
        // Non-shell commands: pass binary + args directly.
        const isShell = !!command.options.shell
        const zeroboxArgs = isShell
          ? [...flags, "--", "sh", "-c", command.command]
          : [...flags, "--", command.command, ...command.args]

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

// When the binary is at a system path (not under /root), we can safely deny
// /root and /home entirely. Otherwise fall back to denying only known
// credential subdirectories to avoid blocking the binary itself.
function buildZeroboxFlags(workspaceDir: string, zeroboxBin: string): string[] {
  const canDenyRoot = !zeroboxBin.startsWith("/root")
  const denyPaths = canDenyRoot
    ? ["/root", "/home"]
    : ["/root/.ssh", "/root/.gnupg", "/home"]
  const deny = denyPaths.flatMap((p) => ["--deny-read", p])
  return [
    "--profile", "system-read-linux",
    "--allow-read", workspaceDir,
    "--allow-write", workspaceDir,
    "--allow-net",
    ...deny,
  ]
}

export * as SandboxSpawner from "./spawner"
