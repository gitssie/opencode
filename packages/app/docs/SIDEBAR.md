# Sidebar Redesign Task

**Branch**: `dev-claw`  
**Last updated**: 2026-03-14

---

## Goal

Replace the current icon-rail + hover-panel sidebar with a VSCode-style persistent left panel that is always visible and never collapses. The panel is divided into three collapsible sections: **Projects**, **Skills**, and **Tasks (Sessions)**.

---

## Current Architecture

```
sidebar-rail (w-16, icon strip)
  └── Each Project → circle icon (ProjectTile)
       └── hover → ProjectPreviewPanel popup
  └── Bottom: Settings, Help icons

panel (right side, expands/collapses)
  └── Current project header (name, path, menu)
  └── "New Session" button
  └── Session list (LocalWorkspace)
```

Key files:

- `packages/app/src/pages/layout/sidebar-shell.tsx` — `SidebarContent` component (keep for mobile)
- `packages/app/src/pages/layout/sidebar-project.tsx` — `SortableProject`, `ProjectDragOverlay`
- `packages/app/src/pages/layout.tsx` — `SidebarPanel`, `sidebarContent`
- `packages/app/src/pages/layout/sidebar-items.tsx` — `SessionItem`, `ProjectIcon`
- `packages/app/src/pages/layout/helpers.ts` — `sortedRootSessions`, `displayName`

---

## Data Access Patterns

### Projects (already reactive)

```tsx
const projects = () => layout.projects.list() // LocalProject[], live via SSE
```

> Do NOT use `sdk.client.project.list()` — use `layout.projects.list()` from `useLayout()` context.

### Active directory

```tsx
const currentDir = createMemo(() => decode64(params.dir) ?? "")
```

### Sessions for current project (already reactive)

```tsx
const [data] = globalSync.child(currentDir())
const sessions = createMemo(() => sortedRootSessions(data, sortNow()))
```

> Do NOT use `sdk.client.experimental.session.list()` — use `globalSync.child()` for live data.

### Skills (REST, per-project)

```tsx
const sdk = useGlobalSDK()
const [skills] = createResource(
  () => currentDir() || true,
  async () => {
    const res = await sdk.client.app.skills({ directory: currentDir() || undefined })
    return res.data ?? []
  },
)
```

Skill source inference from `location` string:

```ts
const skillSource = (location: string): "global" | "project" | "hub" => {
  if (location.includes("/.config/opencode/") || location.includes(".config/opencode")) return "global"
  if (location.includes("/.opencode/")) return "project"
  return "hub"
}
```

### Notification count per project

```tsx
const notification = useNotification()
const unseenCount = (project: LocalProject) =>
  workspaceIds(project).reduce((n, dir) => n + notification.project.unseenCount(dir), 0)
```

---

## Target Design

```
┌──────────────────────────────────┐
│  ▼ 项目                          │  ← Collapsible section header
│    📁 project-a                  │     click → navigate to project
│    📁 project-b  ●               │     ● = unseen notification dot
│    [+ 打开项目]                  │     bottom CTA
├──────────────────────────────────┤
│  ▼ 技能                          │  ← Collapsible section header (entry only)
│    已安装 3 个技能 →             │     summary row, click → open Skills page
├──────────────────────────────────┤
│  ▼ 任务                          │  ← Collapsible section header
│    [+ 新会话]                    │     CTA at top
│    📝 session-1  (3m ago)        │     sessions for current project
│    📝 session-2  (1h ago)        │
├──────────────────────────────────┤
│  ⚙ 设置   ❓ 帮助               │  ← Fixed bottom bar
└──────────────────────────────────┘
```

### Skills section behavior

- Shows summary: "已安装 N 个技能" (count from `sdk.client.app.skills()`)
- Click → opens a new full-page-like dialog (similar to Settings)
- Skills page shows:
  - Top: installed skills list (name, source badge, location)
  - Bottom: discoverable/installable skills list (TBD — if API available)
- This is a **navigation entry point**, not an inline list

### Always-visible behavior

- No toggle button — sidebar is permanently expanded on desktop
- Fixed width (e.g. `244px`), resize handle kept optional
- `--main-left` CSS var always set to sidebar width
- Mobile: keep existing behavior (unchanged)

---

## Implementation Plan

### Phase 1: New sidebar component

**File**: `packages/app/src/pages/layout/sidebar-new.tsx` (create)

Build a self-contained component `NewSidebar`:

```tsx
export const NewSidebar: Component<{
  currentDir: Accessor<string>
  projects: Accessor<LocalProject[]>
  sortNow: Accessor<number>
  onOpenProject: () => void
  onOpenSettings: () => void
  onOpenHelp: () => void
  onOpenSkills: () => void
  navigateToProject: (directory: string) => void
  navigateToNewSession: (directory: string) => void
}> = (props) => { ... }
```

**Sub-tasks:**

- [ ] 1.1 `SectionHeader` sub-component
  - Collapsible, chevron icon rotates on expand/collapse
  - State persisted to `localStorage` keyed by section name
  - Default: all sections expanded

- [ ] 1.2 Projects section
  - `For each={props.projects()}` — show `displayName(project)` + notification dot
  - Highlight row for active project (`project.worktree === currentDir()`)
  - Click row → `navigateToProject(project.worktree)`
  - Bottom: `[+ 打开项目]` button → `onOpenProject()`

- [ ] 1.3 Skills section (entry point only)
  - `createResource` → `sdk.client.app.skills({ directory: currentDir() || undefined })`
  - Show count summary: "N skills installed"
  - Click summary row → `onOpenSkills()` (opens skills dialog/page)

- [ ] 1.4 Tasks section
  - `createMemo(() => sortedRootSessions(globalSync.child(currentDir())[0], props.sortNow()))`
  - Top: `[+ 新会话]` button → `navigateToNewSession(currentDir())`
  - `For each={sessions()}` → session title + relative time
  - Use `SessionItem` from `sidebar-items.tsx` if props are compatible, else inline row

- [ ] 1.5 Bottom bar
  - `IconButton` for settings → `onOpenSettings()`
  - `IconButton` for help → `onOpenHelp()`

---

### Phase 2: Wire up in layout.tsx

**File**: `packages/app/src/pages/layout.tsx` (modify)

- [ ] 2.1 Import `NewSidebar` from `./layout/sidebar-new`
- [ ] 2.2 Add `onOpenSkills` handler (open a skills dialog — similar to how `openSettings` works)
- [ ] 2.3 Replace desktop `<nav data-component="sidebar-nav-desktop">` children with `<NewSidebar ...props />`
- [ ] 2.4 Make `--main-left` always equal to sidebar width (remove `layout.sidebar.opened()` gate)
- [ ] 2.5 Keep `sidebarContent(true)` for mobile unchanged
- [ ] 2.6 Remove `ResizeHandle` if sidebar is fixed-width, or keep if resizable is desired

---

### Phase 3: Skills page/dialog

**File**: `packages/app/src/components/dialog-skills.tsx` (create) or a new page

- [ ] 3.1 Full-screen or large dialog (like `DialogSettings`)
- [ ] 3.2 Installed skills list: name, source badge, location path, description
- [ ] 3.3 Desktop: "Open Directory" button for project skills
- [ ] 3.4 Discoverable skills list (if API supports it — TBD)

---

## i18n Keys Needed

Add to `en.ts` and `zh.ts`:

```ts
"sidebar.section.projects": "Projects",
"sidebar.section.skills": "Skills",
"sidebar.section.tasks": "Tasks",
"sidebar.skills.count": "{{count}} skills installed",
"sidebar.skill.source.global": "Global",
"sidebar.skill.source.project": "Project",
"sidebar.skill.source.hub": "Hub",
```

---

## What NOT to change

- `sidebar-shell.tsx` — keep for mobile
- `sidebar-project.tsx`, `sidebar-items.tsx` — reuse components
- `sidebar-workspace.tsx` — keep for workspace feature
- Mobile sidebar logic in `layout.tsx`

---

## Completion Criteria

- [ ] `NewSidebar` component created with all 3 sections
- [ ] Desktop sidebar always visible, mobile unchanged
- [ ] Skills entry opens dedicated page/dialog
- [ ] `bun typecheck` passes in `packages/app`
- [ ] All text uses `language.t()` translation keys
- [ ] No new npm dependencies
