# UI-PLAN.md — the shadcn/ui migration, and what is left after it

> **Status: paused mid-migration on branch `ui/shadcn`.**
> The foundation is in and two components are converted. Everything still
> builds and every test passes. Pick it up at *Where to resume*.

---

## Why shadcn

The board is the product's front door and it looked like a prototype: hand-rolled
Tailwind classes, no shared tokens, inconsistent spacing, and colour picked per
component. shadcn/ui gives design tokens, a real component set, and — the reason
it fits this repo rather than a component library — **the components are copied
into `web/src/components/ui/` as source you own and edit**. No runtime
dependency to be trapped by, no upgrade treadmill.

---

## What is already done

### Foundation (complete)

| Thing | Where |
|-------|-------|
| shadcn initialised, Radix base, neutral tokens, Lucide icons | `web/components.json` |
| Design tokens + dark mode | `web/src/app/globals.css` |
| `cn()` class merger | `web/src/lib/utils.ts` |
| Primitives added | `web/src/components/ui/` — button, badge, card, input, textarea, select, separator, sheet, tooltip, label |

New dependencies: `radix-ui`, `lucide-react`, `class-variance-authority`, `clsx`,
`tailwind-merge`, `tw-animate-css`. The `shadcn` CLI itself is a **dev**
dependency — it must not end up in the production image.

### ⚠️ The one decision worth knowing about: dark mode

shadcn ships a **class-based** dark variant (`.dark`). This app already drives
**205 `dark:` utilities from `prefers-color-scheme`**, so adopting the class
would have silently disabled dark mode across every existing component — it
would still compile, still pass tests, and just quietly stop working.

`globals.css` therefore makes both the variant and the token block
media-driven:

```css
@custom-variant dark (@media (prefers-color-scheme: dark));

@media (prefers-color-scheme: dark) {
  :root { --background: …; }
}
```

**If you later want a manual light/dark toggle**, that is the place to change:
reintroduce `.dark` alongside the media query and add a provider that sets the
class. Do not simply paste shadcn's default back, or the 205 existing utilities
break.

### Components converted (2 of ~12)

- **`TaskCard.tsx`** — Card surface, `Badge` for labels/blocked/PR, Lucide
  icons, PR chip is now a real link (with `stopPropagation` so it does not start
  a drag). Priority stays a coloured left stripe deliberately: colour down the
  edge reads faster when scanning a column than a word does.
- **`RunBadge.tsx`** — `Badge` per status with a matching Lucide icon, the
  running one spins; `ApprovalControls` now uses `Button`.

Both gained `data-priority` / `data-selected` / `data-testid` hooks so tests can
assert on **behaviour rather than Tailwind classes** — the old tests queried
`.bg-red-500` and `.ring-2`, which is exactly what makes a restyle break a suite
for no good reason. Convert the remaining class-based assertions as you go.

---

## Where to resume

```bash
git checkout ui/shadcn
npm install
npm run dev:web
```

Convert in this order — highest visibility first, and each step is a commit
that leaves the app working:

1. **`Column.tsx`** — quick-add uses `Input`; header count and the ⚡ automation
   chip use `Badge`; drop-zone highlight uses tokens (`bg-accent`) rather than
   `bg-sky-100`. *(Started: the file is still original. This is the next task.)*
2. **`TaskDrawer.tsx`** — the big one. `Sheet` for the drawer itself, `Input` /
   `Textarea` / `Label` for the brief, `Select` for priority, `Separator`
   between sections, `Button` throughout. Keep every `data-testid`: the board
   E2E specs depend on `drawer-title`, `drawer-body`, `drawer-run-now`,
   `drawer-approve`, `drawer-reject`, `close-drawer`, `timeline`.
3. **`Board.tsx`** — page chrome, the filter bar, and the rejection/warning
   banners (a `Card` or an alert-styled surface rather than raw divs).
4. **`Timeline.tsx`** — the card's activity feed.
5. **`/runs` + `/runs/[id]`** — `Card` rows, `Badge` for status, `Button` for
   retry, `Separator` between sections.
6. **`/today`** — same treatment as the run rows.
7. **`/settings/secrets`** — `Card`, `Input`, `Button`; keep the write-only
   behaviour exactly as it is.
8. **Editor (`/pipelines`)** — `NodeConfigPanel`, `NodePalette`,
   `ConnectionsPanel`, `AgentsPanel`, `VariablesPanel`. Leave the React Flow
   canvas itself alone; only the surrounding panels need it.
9. **A shared app shell** — there is currently no nav. Board / Today / Runs /
   Secrets are all reachable only by typing URLs or via ad-hoc links. A single
   header with those four links is probably the highest-value UI addition in
   this whole list.

### Rules while converting

- **Keep every `data-testid`.** 34 E2E specs depend on them.
- **Replace class-based assertions with data attributes** when a test breaks
  because of styling. A test that asserts `.bg-red-500` is testing the wrong
  thing.
- Run `npm run test:web && npm run e2e` after each component — the E2E suite is
  the real guard here, and it is fast (~30s).
- `npm run build` catches Tailwind/token mistakes that tests do not.

---

## Known gotchas

- **`npx shadcn@latest init` prompts interactively** and will hang a
  non-interactive shell. Use explicit flags: `init -y -p nova -b radix
  --no-monorepo`. For components: `add <name> -y`.
- The CLI writes into `web/`, so run it from that directory.
- `shadcn` must stay in `devDependencies`.
- Tailwind v4 has no `tailwind.config.js` here — tokens live in `globals.css`
  under `@theme inline`.

---

## What is left in the product, beyond the UI

Ranked by what actually reduces risk or unlocks use.

### 1. A better local model (highest value, ~10 minutes)

```bash
ollama pull qwen2.5-coder
```

The first live run **worked end to end** — real clone, real commit, real PR at
`jigabarda/agentflow-smoke-test#1` — but llama3.2 (3B) replaced the README
instead of appending to it. The plumbing is proven; model quality is now the
only thing between this and daily use. Re-run the golden loop with a 7B+ coder
model and compare the diff.

### 2. The crew, live

`triage → plan → implement → review` has only ever run against mocks. The
reviewer loop is exactly where a weak model most needs a stronger one checking
it. Seed with `POST /api/boards/{id}/crew`.

### 3. Vercel and Netlify are unverified

They are in precisely the position the GitHub nodes were in before the first
live run: written from documented APIs, pinned to fixtures, **never called**.
That is the same class of risk that produced the workspace bug — a mock
answering a question only the real thing can answer. The contracts are pure
functions in `packages/core/src/integrations/deploy.ts`, so a wrong field is a
one-file fix.

### 4. No canvas control for loop edges

The reviewer loop can only be created by `POST /api/boards/{id}/crew`. The
editor can display and save a loop edge but cannot create one. Needs a control
on the edge in `PipelineEditor.tsx`.

### 5. Issue sync is a planner with no caller

`worker/src/github/sync.ts` is written and tested (idempotent, never
destructive) but nothing runs it on a timer and there is no per-board opt-in UI.

### 6. The morning digest

Task 6 of Phase 9, marked optional and not built: a `schedule-trigger` pipeline
that summarises yesterday's runs into a card each morning.

---

## Housekeeping worth doing at some point

- **~230 leftover E2E boards** in the dev database (`Test board …`, `Golden …`,
  `Crew …`, `Dash …`, `Today …`) plus ~50 cancelled runs. The bare `/` opens
  onto "My work", which holds 45 cards of Phase-3 test junk. The E2E specs
  create a fresh board per test and never clean up — worth a teardown, or a
  separate test database.
- **`jigabarda/agentflow-smoke-test`** still exists with PR #1 open (the poor
  llama3.2 diff). Delete the repo, or keep it as the live-run target.
- **`GITHUB_TOKEN`** — your `gh` CLI token — is in the local dev database's
  encrypted secret store.
