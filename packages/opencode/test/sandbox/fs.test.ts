import { describe, it } from "bun:test"

// DISABLED — pending re-port. See bd issue opencode-3j8.
//
// These tests exercised SandboxFs.layer, which wrapped the old upstream
// `AppFileSystem` service. Upstream v1.17.9 removed that service and replaced it
// with a narrow `FileSystem` (v2) service plus `FSUtil`, so both the layer and
// these tests no longer compile. The original assertions (workspace reads/writes
// allowed; /root, /etc denied; /tmp allowed; exists/isFile return false for
// denied paths) are preserved in git history at commit fb495452a for reference
// when the FS sandbox is re-ported. Re-enable as part of opencode-3j8.

describe.skip("SandboxFs (disabled pending re-port: opencode-3j8)", () => {
  it("re-port against upstream FileSystem/FSUtil architecture", () => {})
})
