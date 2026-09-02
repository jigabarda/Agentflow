# UI-PLAN.md — the shadcn/ui migration, and what is left after it

> **Status: the migration is complete on branch `ui/shadcn`.**
> All nine surfaces are converted, the app shell exists, and everything builds
> with 226 web tests and 36 E2E specs passing. What remains is in
> *What is left in the product, beyond the UI*.

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

### Components converted (all nine)

- **`TaskCard.tsx`** — Card surface, `Badge` for labels/blocked/PR, Lucide
  icons, PR chip is now a real link (with `stopPropagation` so it does not start
  a drag). Priority stays a coloured left stripe deliberately: colour down the
  edge reads faster when scanning a column than a word does.
- **`RunBadge.tsx`** — `Badge` per status with a matching Lucide icon, the
  running one spins; `ApprovalControls` now uses `Button`.

- **`Column.tsx`** — `Input` quick-add, `Badge` count and WIP warning, a real
  `Tooltip` on the automation chip. The drop target is a ring rather than a
  fill, so cards keep their own surface while you drag.
- **`TaskDrawer.tsx`** — `Input` / `Textarea` / `Label` / `Button` / `Badge` /
  `Separator`.
- **`AppNav.tsx`** *(new)* — the shared shell.
- **`Board.tsx`** — header, filter bar, and the rejection/WIP banners.
- **`Timeline.tsx`** — a rail with an outcome-coloured dot per event.
- **`/runs`, `/runs/[id]`, `/today`, `/settings/secrets`** — tokens throughout.
- **Editor panels** — one shared `controls.ts` replacing five drifting copies of
  the same `inputClass`.

The card gained `data-priority` / `data-selected` / `data-testid` hooks so tests
assert on **behaviour rather than Tailwind classes** — the old ones queried
`.bg-red-500` and `.ring-2`, which is exactly what makes a restyle break a suite
for no good reason.

### Where the plan was not followed, and why

- **The drawer is not a `Sheet`.** A Sheet is a modal dialog; an overlay that
  dims the board would undo the reason this is a drawer rather than a page. It
  stays a plain `aside` with shadcn components inside it.
- **Priority stays a native `<select>`.** It is what mobile and keyboard users
  get for free, and what `selectOption` drives in the E2E suite. The styling gap
  did not justify the churn. `controls.ts` makes it match.

### Two bugs found while converting

- shadcn's `init` wrote `--font-sans: var(--font-sans)` — self-referential, so
  `@apply font-sans` on `body` silently lost the typeface. It now points at
  `--font-geist-sans`, which is what `layout.tsx` actually defines.
- The drawer still carried a second "Automation" section reading *"Coming in
  Phase 7"* — dead text three phases out of date, directly below the real
  automation panel.

---

## The migration itself is done

All nine surfaces from the original list are converted, plus the app shell that
was listed last and turned out to matter most: until it existed, the board,
Today, Runs, Pipelines and Secrets were reachable only by typing a URL.

If you pick this up again, the rules that kept it safe were:

- **Keep every `data-testid`.** 36 E2E specs depend on them.
- **Replace class-based assertions with data attributes** when a restyle breaks
  one. A test asserting `.bg-red-500` is testing the wrong thing.
- Run `npm run test:web && npm run e2e` after each component — the E2E suite is
  the real guard, and it is fast (~30s).
- `npm run build` catches Tailwind and token mistakes that tests do not.

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
