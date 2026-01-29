#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WORK_DIR="$(pwd)"

cd "$PROJECT_DIR" && OPENCODE_WORK_DIR="$WORK_DIR" bun run --conditions=browser "$SCRIPT_DIR/opencode-dev.ts" "$@"
