import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect, Layer, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import { Instance } from "@/project/instance"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import path from "path"

export const layer = Layer.effect(
  AppFileSystem.Service,
  Effect.gen(function* () {
    const real = yield* AppFileSystem.Service

    return AppFileSystem.Service.of({
      ...real,
      access: (target, options) =>
        checkAccess(target, options?.writable ? allowWrite() : allowRead(), "access").pipe(
          Effect.andThen(real.access(target, options)),
        ),
      copy: (fromPath, toPath, options) =>
        Effect.all([checkAccess(fromPath, allowRead(), "copy"), checkAccess(toPath, allowWrite(), "copy")]).pipe(
          Effect.andThen(real.copy(fromPath, toPath, options)),
        ),
      copyFile: (fromPath, toPath) =>
        Effect.all([
          checkAccess(fromPath, allowRead(), "copyFile"),
          checkAccess(toPath, allowWrite(), "copyFile"),
        ]).pipe(Effect.andThen(real.copyFile(fromPath, toPath))),
      chmod: (target, mode) =>
        checkAccess(target, allowWrite(), "chmod").pipe(Effect.andThen(real.chmod(target, mode))),
      chown: (target, uid, gid) =>
        checkAccess(target, allowWrite(), "chown").pipe(Effect.andThen(real.chown(target, uid, gid))),
      exists: (target) => (canAccess(target, allowRead()) ? real.exists(target) : Effect.succeed(false)),
      link: (fromPath, toPath) =>
        Effect.all([checkAccess(fromPath, allowRead(), "link"), checkAccess(toPath, allowWrite(), "link")]).pipe(
          Effect.andThen(real.link(fromPath, toPath)),
        ),
      makeDirectory: (target, options) =>
        checkAccess(target, allowWrite(), "makeDirectory").pipe(Effect.andThen(real.makeDirectory(target, options))),
      makeTempDirectory: (options) =>
        checkAccess(options?.directory ?? "/tmp", allowWrite(), "makeTempDirectory").pipe(
          Effect.andThen(real.makeTempDirectory(options)),
        ),
      makeTempDirectoryScoped: (options) =>
        checkAccess(options?.directory ?? "/tmp", allowWrite(), "makeTempDirectoryScoped").pipe(
          Effect.andThen(real.makeTempDirectoryScoped(options)),
        ),
      makeTempFile: (options) =>
        checkAccess(options?.directory ?? "/tmp", allowWrite(), "makeTempFile").pipe(
          Effect.andThen(real.makeTempFile(options)),
        ),
      makeTempFileScoped: (options) =>
        checkAccess(options?.directory ?? "/tmp", allowWrite(), "makeTempFileScoped").pipe(
          Effect.andThen(real.makeTempFileScoped(options)),
        ),
      open: (target, options) =>
        checkAccess(target, options?.flag && options.flag !== "r" ? allowWrite() : allowRead(), "open").pipe(
          Effect.andThen(real.open(target, options)),
        ),
      readDirectory: (target, options) =>
        checkAccess(target, allowRead(), "readDirectory").pipe(Effect.andThen(real.readDirectory(target, options))),
      readFile: (target) => checkAccess(target, allowRead(), "readFile").pipe(Effect.andThen(real.readFile(target))),
      readFileString: (target, encoding) =>
        checkAccess(target, allowRead(), "readFileString").pipe(Effect.andThen(real.readFileString(target, encoding))),
      readLink: (target) => checkAccess(target, allowRead(), "readLink").pipe(Effect.andThen(real.readLink(target))),
      realPath: (target) => checkAccess(target, allowRead(), "realPath").pipe(Effect.andThen(real.realPath(target))),
      remove: (target, options) =>
        checkAccess(target, allowWrite(), "remove").pipe(Effect.andThen(real.remove(target, options))),
      rename: (oldPath, newPath) =>
        Effect.all([checkAccess(oldPath, allowWrite(), "rename"), checkAccess(newPath, allowWrite(), "rename")]).pipe(
          Effect.andThen(real.rename(oldPath, newPath)),
        ),
      sink: (target, options) =>
        canAccess(target, allowWrite()) ? real.sink(target, options) : Sink.fail(deny(target, "sink")),
      stat: (target) => checkAccess(target, allowRead(), "stat").pipe(Effect.andThen(real.stat(target))),
      stream: (target, options) =>
        canAccess(target, allowRead()) ? real.stream(target, options) : Stream.fail(deny(target, "stream")),
      symlink: (fromPath, toPath) =>
        Effect.all([checkAccess(fromPath, allowRead(), "symlink"), checkAccess(toPath, allowWrite(), "symlink")]).pipe(
          Effect.andThen(real.symlink(fromPath, toPath)),
        ),
      truncate: (target, length) =>
        checkAccess(target, allowWrite(), "truncate").pipe(Effect.andThen(real.truncate(target, length))),
      utimes: (target, atime, mtime) =>
        checkAccess(target, allowWrite(), "utimes").pipe(Effect.andThen(real.utimes(target, atime, mtime))),
      watch: (target) => (canAccess(target, allowRead()) ? real.watch(target) : Stream.fail(deny(target, "watch"))),
      writeFile: (target, data, options) =>
        checkAccess(target, allowWrite(), "writeFile").pipe(Effect.andThen(real.writeFile(target, data, options))),
      writeFileString: (target, data, options) =>
        checkAccess(target, allowWrite(), "writeFileString").pipe(
          Effect.andThen(real.writeFileString(target, data, options)),
        ),
      isDir: (target) => (canAccess(target, allowRead()) ? real.isDir(target) : Effect.succeed(false)),
      isFile: (target) => (canAccess(target, allowRead()) ? real.isFile(target) : Effect.succeed(false)),
      existsSafe: (target) => (canAccess(target, allowRead()) ? real.existsSafe(target) : Effect.succeed(false)),
      readFileStringSafe: (target) =>
        canAccess(target, allowRead()) ? real.readFileStringSafe(target) : Effect.succeed(undefined),
      readJson: (target) => checkAccess(target, allowRead(), "readJson").pipe(Effect.andThen(real.readJson(target))),
      writeJson: (target, data, mode) =>
        checkAccess(target, allowWrite(), "writeJson").pipe(Effect.andThen(real.writeJson(target, data, mode))),
      ensureDir: (target) =>
        checkAccess(target, allowWrite(), "ensureDir").pipe(Effect.andThen(real.ensureDir(target))),
      writeWithDirs: (target, content, mode) =>
        checkAccess(target, allowWrite(), "writeWithDirs").pipe(
          Effect.andThen(real.writeWithDirs(target, content, mode)),
        ),
      readDirectoryEntries: (target) =>
        checkAccess(target, allowRead(), "readDirectoryEntries").pipe(
          Effect.andThen(real.readDirectoryEntries(target)),
        ),
      findUp: (target, start, stop) =>
        checkAccess(start, allowRead(), "findUp").pipe(Effect.andThen(real.findUp(target, start, stop))),
      up: (options) => checkAccess(options.start, allowRead(), "up").pipe(Effect.andThen(real.up(options))),
      globUp: (pattern, start, stop) =>
        checkAccess(start, allowRead(), "globUp").pipe(Effect.andThen(real.globUp(pattern, start, stop))),
      glob: (pattern, options) =>
        checkAccess(options?.cwd ?? process.cwd(), allowRead(), "glob").pipe(
          Effect.andThen(real.glob(pattern, options)),
        ),
    })
  }),
).pipe(Layer.provide(AppFileSystem.defaultLayer))

function allowRead() {
  return [Instance.directory, TRUNCATION_DIR, "/tmp"]
}

function allowWrite() {
  return [Instance.directory, TRUNCATION_DIR, "/tmp"]
}

function checkAccess(target: string, allowList: ReadonlyArray<string>, method: string) {
  return canAccess(target, allowList) ? Effect.void : Effect.fail(deny(target, method))
}

function deny(target: string, method: string) {
  return PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: target,
    cause: new AppFileSystem.FileSystemError({ method, cause: new Error(`Sandbox denied access to ${target}`) }),
  })
}

function canAccess(target: string, allowList: ReadonlyArray<string>) {
  return allowList.some((allow) => isInside(path.resolve(allow), path.resolve(target)))
}

function isInside(parent: string, child: string) {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
}

export * as SandboxFs from "./fs"
