# OpenClaw App Implementation Tasks

**Branch**: `dev-claw`  
**Base**: upstream v1.2.26  
**Last updated**: 2026-03-14

---

## Overview

Implement the management UI for OpenClaw within `packages/app`. All features are implemented as new Tabs inside the existing `dialog-settings.tsx` settings dialog. No new routes or layouts needed.

---

## Task List

### Phase 1: MCP Server Management (`settings-mcp.tsx`)

**Status**: [ ] Not started

**File**: `packages/app/src/components/settings-mcp.tsx` (create)

**API**:

- `globalSDK.client.mcp.status()` → `{ [name]: McpStatus }`
- `globalSDK.client.mcp.add({ name, config: McpLocalConfig | McpRemoteConfig })`
- `globalSDK.client.mcp.connect({ name })`
- `globalSDK.client.mcp.disconnect({ name })`

**Sub-tasks**:

- [ ] 1.1 MCP server list — show name + status badge (color-coded)
  - `connected` → green
  - `disabled` → gray
  - `failed` → red (show error message)
  - `needs_auth` → orange
  - `needs_client_registration` → orange
- [ ] 1.2 Action buttons per status:
  - `connected` → Disconnect button
  - `disabled` / `failed` → Connect button
  - `needs_auth` → Auth guide text
- [ ] 1.3 Add MCP server form (two types):
  - Local stdio: name, command (array), env (key-value pairs)
  - Remote HTTP: name, URL, headers (key-value pairs)
- [ ] 1.4 Submit add form → `mcp.add()` then `mcp.connect()`
- [ ] 1.5 Toast on success/failure

---

### Phase 2: Skill List (`settings-skills.tsx`)

**Status**: [ ] Not started

**File**: `packages/app/src/components/settings-skills.tsx` (create)

**API**:

- `globalSDK.client.app.skills()` → `{ name, description, location, content }[]`

**Sub-tasks**:

- [ ] 2.1 Skill list — show name, description, source badge, location path
  - Source inference from `location`:
    - Contains `/.config/opencode/` or system config dir → Global
    - Contains `/.opencode/` relative → Project
    - Other → Hub
- [ ] 2.2 Keyword search (filter by name or description)
- [ ] 2.3 Content preview (first 300 chars of `content`, expandable)
- [ ] 2.4 Desktop: show "Open Directory" button via `platform.openPath`
- [ ] 2.5 Web: show "Copy Path" fallback

---

### Phase 3: Agent Management (`settings-agents.tsx`)

**Status**: [ ] Not started

**File**: `packages/app/src/components/settings-agents.tsx` (create)

**API**:

- `globalSDK.client.app.agents()` → `Agent[]`
- `globalSync.updateConfig({ agent: { ...existing, [name]: AgentConfig } })` for CRUD

**Agent Source Logic** (no `source` field in API — derive from `native` flag):

- `native: true` → native (read-only)
- otherwise → config (editable)

**Sub-tasks**:

- [ ] 3.1 Agent list (left panel):
  - Show name, description, mode badge, source badge (native / config)
  - Search by name keyword
  - Filter by mode (all / primary / subagent / all-modes)
  - "New Agent" button in top-right
- [ ] 3.2 Agent detail (right panel):
  - Show all fields: name, description, mode, color, hidden, model (modelID/providerID), prompt, temperature, top_p, steps
  - Show permission summary (edit/bash/webfetch/task) — read-only display
  - Native agents: entire panel read-only, no edit button
  - Config agents: show Edit and Delete buttons
- [ ] 3.3 Create Agent form:
  - Fields: name (required, unique, alphanumeric+dash), description, mode, modelID, providerID, prompt, temperature, top_p, color, hidden, maxSteps
  - Name format validation
  - Save → `updateConfig({ agent: { ...current.agent, [name]: cfg } })`
  - Redirect to detail view on success
- [ ] 3.4 Edit Agent form (same fields, name read-only)
- [ ] 3.5 Delete Agent:
  - Confirmation dialog
  - Remove from `config.agent`, call `updateConfig()`
  - Redirect to list on success
- [ ] 3.6 Agent-Skill association section in detail view (stretch goal, skip for MVP)

---

### Phase 4: Wire up `dialog-settings.tsx`

**Status**: [ ] Not started

**File**: `packages/app/src/components/dialog-settings.tsx` (modify ~10 lines)

**Sub-tasks**:

- [ ] 4.1 Import `SettingsAgents`, `SettingsMcp`, `SettingsSkills`
- [ ] 4.2 Add new "管理" section in `Tabs.List` with 3 triggers (agents, mcp, skills)
- [ ] 4.3 Add 3 `Tabs.Content` entries

---

## Implementation Notes

### Pattern to follow

See `packages/app/src/components/settings-providers.tsx` — use `createResource` for data fetching, `showToast` for feedback, `useGlobalSDK` + `useGlobalSync` for data access.

### UI Components (all from `@opencode-ai/ui/*`)

- Layout: `Button`, `Tag`, `Icon`, `Spinner`
- Forms: `TextField` (`@opencode-ai/ui/text-field`), `Switch` (`@opencode-ai/ui/switch`), `Select` (`@opencode-ai/ui/select`)
- Containers: `SettingsList` (local component)
- Feedback: `showToast` from `@opencode-ai/ui/toast`

### SolidJS

- Use `createStore` over multiple `createSignal` (per AGENTS.md)
- Use `createResource` for async SDK calls
- Use `For`, `Show`, `Switch/Match` for conditional rendering

### No new dependencies

Do not add any new npm packages. Use only existing `@opencode-ai/ui` components.

---

## Completion Criteria

- [ ] All 3 settings files created and functional
- [ ] `dialog-settings.tsx` updated with new tabs
- [ ] `bun typecheck` passes in `packages/app`
- [ ] No ESLint errors
- [ ] Committed to `dev-claw` branch and pushed to origin
