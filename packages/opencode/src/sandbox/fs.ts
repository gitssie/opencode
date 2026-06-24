// DISABLED — pending re-port. See bd issue opencode-3j8.
//
// This module wrapped the old upstream `AppFileSystem` service (Context tag
// "@opencode/FileSystem") with a rich ~40-method low-level interface, applying
// path-based allow/deny access control to every filesystem operation.
//
// Upstream v1.17.9 re-architected the filesystem layer: the `AppFileSystem`
// namespace was removed. `@opencode-ai/core/filesystem` now exports `FileSystem`
// (Context tag "@opencode/v2/FileSystem") with a narrow 5-method high-level
// interface (read/list/find/glob/grep); the low-level fs operations moved to
// `FSUtil.Service` and `@effect/platform-node`'s `NodeFileSystem`.
//
// The original wrapper therefore no longer compiles against upstream and cannot
// be "minimally" adapted — the access-control logic must be re-targeted at the
// new service surface (likely an `FSUtil.Service` wrapper). That re-port is
// tracked in opencode-3j8 and intentionally deferred so this merge lands a
// buildable SQLite tree.
//
// The original implementation is preserved in git history at commit
// fb495452a (and earlier) for reference during the re-port. SandboxFs is NOT
// wired into the tool registry; only SandboxSpawner is active.

export {}

export * as SandboxFs from "./fs"
