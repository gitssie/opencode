import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, make as makeSpawner, makeHandle } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"

export const layer = Layer.effect(
  ChildProcessSpawner,
  Effect.gen(function* () {
    const real = yield* ChildProcessSpawner

    // Per-instance state: initialize sandbox once per project directory.
    const state = yield* InstanceState.make(
      Effect.fn("SandboxSpawner.state")(function* (ctx) {
        const config = sandboxConfig(ctx.directory)
        yield* Effect.promise(() => SandboxManager.initialize(config))
        yield* Effect.addFinalizer(() => Effect.promise(() => SandboxManager.reset()).pipe(Effect.ignore))
        return { config, directory: ctx.directory }
      }),
    )

    return makeSpawner((command) =>
      Effect.gen(function* () {
        const { config, directory } = yield* InstanceState.get(state)
        const wrapped = yield* Effect.promise(() =>
          SandboxManager.wrapWithSandbox(describe(command), undefined, config),
        )
        const handle = yield* real.spawn(
          ChildProcess.make(wrapped, [], {
            cwd: command._tag === "StandardCommand" ? (command.options.cwd ?? directory) : directory,
            shell: true,
            //stderr: "inherit",
          }),
        )
        const cleanup = Effect.sync(() => SandboxManager.cleanupAfterCommand())
        return makeHandle({
          pid: handle.pid,
          stdin: handle.stdin,
          stdout: handle.stdout,
          stderr: handle.stderr,
          all: handle.all,
          getInputFd: handle.getInputFd,
          getOutputFd: handle.getOutputFd,
          isRunning: handle.isRunning,
          exitCode: handle.exitCode.pipe(Effect.onExit(() => cleanup)),
          kill: (options) => handle.kill(options).pipe(Effect.onExit(() => cleanup)),
          unref: handle.unref,
        })
      }),
    )
  }),
).pipe(Layer.provide(CrossSpawnSpawner.defaultLayer))

function describe(command: ChildProcess.Command): string {
  if (command._tag === "StandardCommand" && command.options.shell) return command.command
  if (command._tag === "StandardCommand") return shellQuote([command.command, ...command.args])
  return `${describe(command.left)} | ${describe(command.right)}`
}

function sandboxConfig(directory: string): SandboxRuntimeConfig {
  return {
    filesystem: {
      // Deny all sensitive directories by default (read is blacklist-based).
      // allowRead re-opens the subset of system paths needed for tools to run.
      denyRead: ["/root", "/home"],
      allowRead: [
        directory,
        // Tool-chain paths required to execute shell commands
        "/usr/bin",
        "/usr/lib",
        "/usr/lib64",
        "/usr/local",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/etc/alternatives",
        "/etc/ssl/certs",
        "/etc/resolv.conf",
        "/etc/hosts",
        "/proc/self",
        "/tmp",
      ],
      // Write is whitelist-based: only the project directory and temp space.
      allowWrite: [directory, "/tmp"],
      denyWrite: ["/etc", "/usr", "/lib", "/lib64", "/bin", "/sbin", "/var", "/opt", "/root", "/home"],
    },
    network: {
      allowedDomains: ["*"], // - Array of allowed domains (supports wildcards like *.example.com). Empty array = no
      deniedDomains: [], // - Array of denied domains (checked first, takes precedence over allowedDomains)
    },
  }
}

function shellQuote(parts: ReadonlyArray<string>) {
  return parts.map((part) => `'${part.replaceAll("'", `'"'"'`)}'`).join(" ")
}

export * as SandboxSpawner from "./spawner"
