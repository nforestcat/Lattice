# Lattice Design System

## 1. Atmosphere & Identity

Lattice is a quiet local-first workspace: dense, textual, and audit-friendly. The signature is restrained slate surfaces with blue action focus, where review states are visible without turning the app into a dashboard of warnings.

## 2. Color

### Palette

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Surface/primary | `--surface-primary` | `#ffffff` | n/a | Editor, cards, modal surfaces |
| Surface/secondary | `--surface-secondary` | `#f8fafc` | n/a | Preview blocks, subtle panels |
| Surface/chrome | `--surface-chrome` | `#eef1f4` | n/a | Sidebars and segmented controls |
| Text/primary | `--text-primary` | `#1e293b` | n/a | Body and compact titles |
| Text/secondary | `--text-secondary` | `#64748b` | n/a | Metadata, hints |
| Text/strong | `--text-strong` | `#0f172a` | n/a | Headings and code headers |
| Border/default | `--border-default` | `#d9dee3` | n/a | Panels and separators |
| Border/subtle | `--border-subtle` | `#e2e8f0` | n/a | Cards, diff blocks |
| Accent/primary | `--accent-primary` | `#1f6feb` | n/a | Primary buttons, focus, links |
| Accent/soft | `--accent-soft` | `#dbeafe` | n/a | Active tabs, informational pills |
| Status/success | `--status-success` | `#16a34a` | n/a | Additions, success |
| Status/warning | `--status-warning` | `#f59e0b` | n/a | Draft/review warnings |
| Status/error | `--status-error` | `#dc2626` | n/a | Destructive and failures |

### Rules

- Prefer slate neutrals, white cards, and thin borders.
- Blue is reserved for primary action, focus, links, and selected state.
- Green/red diff colors are semantic only.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| H2 | 15px | 700 | 1.3 | 0 | Panel headings |
| H3 | 14px | 600 | 1.35 | 0 | Card titles |
| Body | 13px | 400 | 1.45 | 0 | Dense workspace text |
| Body/sm | 12px | 400 | 1.4 | 0 | Buttons, metadata |
| Caption | 11px | 600 | 1.3 | 0.02em | Pills, labels |

### Font Stack

- Primary: `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- Mono: `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`

### Rules

- Keep review queue text compact and scannable.
- Use mono only for file paths, diff contents, and code-like values.

## 4. Spacing & Layout

### Base Unit

All spacing derives from 4px.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | Inline icon/label gaps |
| `--space-2` | 8px | Compact row gaps |
| `--space-3` | 12px | Card gaps and panel padding |
| `--space-4` | 16px | Column padding |
| `--space-6` | 24px | Empty-state padding |

### Grid

- Main shell: `280px / minmax(420px, 1fr) / 300px`.
- Review queue cards stack vertically with 12px gaps.

### Rules

- Use multiples of 4px.
- Dense tools should avoid hero-scale type or oversized cards.

## 5. Components

### Review Queue Card

- **Structure**: header pills, title, preview/diff, risk/provenance, actions.
- **Variants**: drafted, approved, applied, committed, rejected.
- **Spacing**: 12px card padding, 8px inner gap, 6px action gap.
- **States**: default, disabled, failed message, destructive warning.
- **Accessibility**: actions are real buttons; hunk selectors use labeled checkboxes.
- **Motion**: no decorative motion.

### Small Button

- **Structure**: compact text button.
- **Variants**: default, primary, success, disabled.
- **Spacing**: 4px/10px padding or equivalent.
- **States**: hover, disabled.
- **Accessibility**: visible text label; no icon-only action unless a title/label exists.
- **Motion**: optional 150-200ms transform/color change only.

### Diff Block

- **Structure**: label plus preformatted content.
- **Variants**: add, remove, neutral.
- **Spacing**: 8px/10px inner padding.
- **States**: scrollable overflow, wrapped text.
- **Accessibility**: labels describe before/after or selected hunks.
- **Motion**: none.

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | 150ms | ease-out | Hover/focus feedback |
| Standard | 200ms | ease-in-out | Existing panel/state transitions |

### Rules

- Animate only `transform`, `opacity`, `background-color`, `border-color`, or `box-shadow`.
- No decorative animation in review surfaces.

## 7. Depth & Surface

### Strategy

Mixed: thin borders for structure, subtle shadows only on elevated or hoverable cards already using them.

| Level | Value | Usage |
|-------|-------|-------|
| Border/default | `1px solid #d9dee3` | Main separators |
| Border/subtle | `1px solid #e2e8f0` | Cards and diff blocks |
| Shadow/subtle | `0 1px 3px rgba(0, 0, 0, 0.05)` | Existing hoverable cards |

### Rules

- Review queue additions should use borders before shadows.
- Avoid nested decorative cards; small framed controls inside a review card are acceptable when they represent a tool state.
