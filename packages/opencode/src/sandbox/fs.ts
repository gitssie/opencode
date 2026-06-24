import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import path from "path"

// SandboxFs wraps the FSUtil filesystem service (@opencode/FileSystem, which
// extends effect's low-level FileSystem) and intercepts every path-taking method
// with allow/deny access control. Reads and writes are confined to the active
// instance workspace, the tool-output truncation dir, and /tmp. Enforcement is
// gated on the OPENCODE_SANDBOX runtime flag: when disabled the real service is
// returned unchanged, so non-sandbox mode has zero overhead and zero behaviour
// change.
//
// The workspace directory is read per-invocation from InstanceState so each call
// is scoped to the current instance context. InstanceRef is a Context.Reference,
// so reading it adds nothing to the service's requirements (R stays `never`).
export const layer = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const real = yield* FSUtil.Service
    const flags = yield* RuntimeFlags.Service

    // Sandbox off: passthrough. The wrapper exists only to enforce isolation.
    if (!flags.sandbox) return real

    // Resolve the allow-list for the current instance at call time. InstanceState
    // .directory requires only the ambient InstanceRef reference, so this Effect
    // has no requirements (R = never).
    const allowList: Effect.Effect<string[]> = Effect.map(InstanceState.directory, (directory) => [
      directory,
      TRUNCATION_DIR,
      "/tmp",
    ])

    // Guard an Effect-returning operation: fail with PermissionDenied if the
    // target is outside the allow-list, otherwise run the real operation. The
    // declared return type preserves the real op's value/requirement channels and
    // unions PermissionDenied (a PlatformError) into the error channel.
    const guard = <A, E, R>(
      target: string,
      method: string,
      op: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | PlatformError.PlatformError, R> =>
      Effect.flatMap(
        allowList,
        (allow): Effect.Effect<A, E | PlatformError.PlatformError, R> =>
          canAccess(target, allow) ? op : Effect.fail(deny(target, method)),
      )

    // Soft variant for predicate-style methods: deny resolves to `false` instead
    // of an error, mirroring upstream existence-check semantics.
    const softBool = <E>(target: string, op: Effect.Effect<boolean, E>): Effect.Effect<boolean, E> =>
      Effect.flatMap(allowList, (allow) => (canAccess(target, allow) ? op : Effect.succeed(false)))

    return FSUtil.Service.of({
      ...real,
      access: (target, options) => guard(target, "access", real.access(target, options)),
      copy: (fromPath, toPath, options) =>
        guardPair(allowList, fromPath, toPath, "copy", real.copy(fromPath, toPath, options)),
      copyFile: (fromPath, toPath) =>
        guardPair(allowList, fromPath, toPath, "copyFile", real.copyFile(fromPath, toPath)),
      chmod: (target, mode) => guard(target, "chmod", real.chmod(target, mode)),
      chown: (target, uid, gid) => guard(target, "chown", real.chown(target, uid, gid)),
      exists: (target) => softBool(target, real.exists(target)),
      link: (fromPath, toPath) => guardPair(allowList, fromPath, toPath, "link", real.link(fromPath, toPath)),
      makeDirectory: (target, options) => guard(target, "makeDirectory", real.makeDirectory(target, options)),
      makeTempDirectory: (options) =>
        guard(options?.directory ?? "/tmp", "makeTempDirectory", real.makeTempDirectory(options)),
      makeTempDirectoryScoped: (options) =>
        guard(options?.directory ?? "/tmp", "makeTempDirectoryScoped", real.makeTempDirectoryScoped(options)),
      makeTempFile: (options) => guard(options?.directory ?? "/tmp", "makeTempFile", real.makeTempFile(options)),
      makeTempFileScoped: (options) =>
        guard(options?.directory ?? "/tmp", "makeTempFileScoped", real.makeTempFileScoped(options)),
      open: (target, options) => guard(target, "open", real.open(target, options)),
      readDirectory: (target, options) => guard(target, "readDirectory", real.readDirectory(target, options)),
      readFile: (target) => guard(target, "readFile", real.readFile(target)),
      readFileString: (target, encoding) => guard(target, "readFileString", real.readFileString(target, encoding)),
      readLink: (target) => guard(target, "readLink", real.readLink(target)),
      realPath: (target) => guard(target, "realPath", real.realPath(target)),
      remove: (target, options) => guard(target, "remove", real.remove(target, options)),
      rename: (oldPath, newPath) => guardPair(allowList, oldPath, newPath, "rename", real.rename(oldPath, newPath)),
      sink: (target, options) =>
        Sink.unwrap(
          Effect.map(allowList, (allow) =>
            canAccess(target, allow) ? real.sink(target, options) : Sink.fail(deny(target, "sink")),
          ),
        ),
      stat: (target) => guard(target, "stat", real.stat(target)),
      stream: (target, options) =>
        Stream.unwrap(
          Effect.map(allowList, (allow) =>
            canAccess(target, allow) ? real.stream(target, options) : Stream.fail(deny(target, "stream")),
          ),
        ),
      symlink: (fromPath, toPath) =>
        guardPair(allowList, fromPath, toPath, "symlink", real.symlink(fromPath, toPath)),
      truncate: (target, length) => guard(target, "truncate", real.truncate(target, length)),
      utimes: (target, atime, mtime) => guard(target, "utimes", real.utimes(target, atime, mtime)),
      watch: (target) =>
        Stream.unwrap(
          Effect.map(allowList, (allow) =>
            canAccess(target, allow) ? real.watch(target) : Stream.fail(deny(target, "watch")),
          ),
        ),
      writeFile: (target, data, options) => guard(target, "writeFile", real.writeFile(target, data, options)),
      writeFileString: (target, data, options) =>
        guard(target, "writeFileString", real.writeFileString(target, data, options)),
      isDir: (target) => softBool(target, real.isDir(target)),
      isFile: (target) => softBool(target, real.isFile(target)),
      existsSafe: (target) => softBool(target, real.existsSafe(target)),
      readFileStringSafe: (target) =>
        Effect.flatMap(allowList, (allow) =>
          canAccess(target, allow) ? real.readFileStringSafe(target) : Effect.succeed(undefined),
        ),
      readJson: (target) => guard(target, "readJson", real.readJson(target)),
      writeJson: (target, data, mode) => guard(target, "writeJson", real.writeJson(target, data, mode)),
      ensureDir: (target) => guard(target, "ensureDir", real.ensureDir(target)),
      writeWithDirs: (target, content, mode) =>
        guard(target, "writeWithDirs", real.writeWithDirs(target, content, mode)),
      readDirectoryEntries: (target) => guard(target, "readDirectoryEntries", real.readDirectoryEntries(target)),
      findUp: (target, start, stop) => guard(start, "findUp", real.findUp(target, start, stop)),
      up: (options) => guard(options.start, "up", real.up(options)),
      globUp: (pattern, start, stop) => guard(start, "globUp", real.globUp(pattern, start, stop)),
      glob: (pattern, options) => guard(options?.cwd ?? process.cwd(), "glob", real.glob(pattern, options)),
    })
  }),
).pipe(Layer.provide(FSUtil.defaultLayer))

// LayerNode form for the ToolRegistry.node graph. RuntimeFlags is supplied as a
// child node; FSUtil.defaultLayer is self-provided by `layer`.
export const node = LayerNode.make(layer, [RuntimeFlags.node])

// Guard an operation that touches two paths (both must be allowed).
function guardPair<A, E, R>(
  allowList: Effect.Effect<readonly string[]>,
  a: string,
  b: string,
  method: string,
  op: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PlatformError.PlatformError, R> {
  return Effect.flatMap(
    allowList,
    (allow): Effect.Effect<A, E | PlatformError.PlatformError, R> =>
      canAccess(a, allow) && canAccess(b, allow) ? op : Effect.fail(deny(canAccess(a, allow) ? b : a, method)),
  )
}

function deny(target: string, method: string) {
  return PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: target,
    cause: new FSUtil.FileSystemError({ method, cause: new Error(`Sandbox denied access to ${target}`) }),
  })
}

function canAccess(target: string, allowList: ReadonlyArray<string>) {
  const resolved = path.resolve(target)
  return allowList.some((allow) => {
    const parent = path.resolve(allow)
    return parent === resolved || FSUtil.contains(parent, resolved)
  })
}

export * as SandboxFs from "./fs"
