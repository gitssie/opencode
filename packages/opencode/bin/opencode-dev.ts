const workDir = process.env.OPENCODE_WORK_DIR
if (workDir) {
  process.chdir(workDir)
}

await import("../src/index.ts")
