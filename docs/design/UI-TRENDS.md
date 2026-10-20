# UI trends (2025–2026) and what OpsDraw takes from them

A short survey of how current desktop-class tools look and behave, and the decisions made for the
OpsDraw editor (`packages/app`). Tokens live in `packages/app/src/styles.css`.

## What the tools are doing

| Pattern                                                                                                                                                   | Seen in                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Few theme inputs, generated in a perceptual color space (LCH/OKLCH); mostly neutral grays with one accent; elevation from opacity and shadow, not borders | Linear's UI refresh ([Linear](https://linear.app/now/how-we-redesigned-the-linear-ui)), Tailwind v4's OKLCH palette ([guide](https://frontendchecklist.io/rules/css/color-oklch))                                               |
| High-contrast neutral system, presets for radii, fills, strokes and shadows                                                                               | Vercel Geist ([Geist](https://vercel.com/geist))                                                                                                                                                                                |
| Semantic, mode-aware tokens (`fgColor-default`, `bgColor-default`) instead of raw colors; light, dark and high-contrast files                             | GitHub Primer ([Primer color](https://primer.style/foundations/color/overview))                                                                                                                                                 |
| Docked, resizable panels around the canvas; a lighter, quieter chrome; contextual controls close to the work                                              | Figma UI3 ([Figma](https://www.figma.com/blog/our-approach-to-designing-ui3/)), draw.io's "Simple" theme ([draw.io](https://www.drawio.com/blog/simple-mode-diagrams))                                                          |
| Re-worked menus and keyboard access in canvas tools                                                                                                       | tldraw's 2023 UI ([tldraw](https://tldraw.dev/blog/release-notes-20230302))                                                                                                                                                     |
| Keyboard-first: ⌘K/Ctrl K command surfaces, shortcuts shown inline in results                                                                             | Raycast ([manual](https://manual.raycast.com/keyboard-shortcuts))                                                                                                                                                               |
| Rounder, concentric shapes; capsules for large touch controls, rounded rectangles for compact desktop controls                                            | Apple's 2025 design language ([summary](https://dev.to/arshtechpro/wwdc-2025-apples-liquid-glass-design-system-52an)), Material 3 Expressive ([Android](https://developer.android.com/design/ui/wear/guides/get-started/apply)) |
| Menu button, menu and combobox semantics with full keyboard support                                                                                       | WAI-ARIA APG: [menu button](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/), [menu](https://www.w3.org/WAI/ARIA/apg/patterns/menu/)                                                                                      |

## Decisions for OpsDraw

- **Color.** A cool-gray OKLCH scale (`--gray-0…15`, hue 260) plus one accent, the favicon blue
  `#2563eb` (`oklch(54.6% 0.215 262.9)`), lightened for dark mode. Components use only semantic
  tokens: `surface`, `surface-raised`, `surface-hover`, `border-subtle`, `border-strong`, `text`,
  `text-muted`, `accent`, `accent-contrast`, `accent-subtle`, `danger`, `focus`. Panels are separated
  by 1px subtle dividers; menus, dialogs and nodes float on soft layered shadows (`--shadow-1…3`).
- **Dark mode parity.** Light, dark and System. System follows `prefers-color-scheme` in pure CSS;
  an explicit choice sets `<html data-theme>`, is stored with the `storage` helper, and also drives
  the code editor, React Flow and Mermaid preview. The `%% @style` palette follows the same choice.
- **Shape.** Radius scale 4/6/8/12/16/full. Buttons and inputs 8px (compact 6px), menu items 6px
  inside 12px menus (concentric), canvas nodes 12px, groups and dialogs 16px. No pills: capsules
  read as touch UI; OpsDraw is a dense desktop tool.
- **Buttons.** Secondary (default), primary, ghost and danger variants; 32px and 26px sizes;
  hover/active/disabled states; `:focus-visible` rings only for keyboard focus.
- **App bar.** Logo, **File** and **Export** menus (APG menu button: Enter/Space/↓ open on the first
  item, ↑ on the last, arrows/Home/End/type-ahead, Esc returns focus, click outside closes, logical
  placement so menus flip in RTL), auto-layout as an icon segmented control with tooltips, the file
  name with an unsaved dot in the middle, and search, icon packs, language and theme on the right.
  Shortcuts are shown in menus (Ctrl/⌘ per platform).
- **Command palette (Ctrl/⌘ K).** Modal dialog with an APG combobox + listbox
  (`aria-activedescendant`): every action, view, theme, language and "Add <icon>" for the palette;
  matches words, word starts and letters in order.
- **Panels.** Inspector sections with small uppercase headings (no letter-spacing for Hebrew,
  Arabic, Japanese, Chinese), Canvas/Mermaid preview as a segmented tab control, themed minimap and
  controls, selected nodes with an accent ring.
- **Type and density.** System UI font stack (no web-font download, works offline in the desktop
  app), 11–16px scale, tabular numbers in the status bar, 48px app bar.
- **Motion.** 100–160ms ease-out fades for menus, dialogs and tooltips; all of it is switched off
  under `prefers-reduced-motion`.

## Contrast check (WCAG 2.2 AA)

Computed from the OKLCH tokens (converted to sRGB) with the WCAG relative-luminance formula. Text
needs 4.5:1; focus rings and input boundaries (non-text, SC 1.4.11) need 3:1. All pairs pass.

| Pair (foreground / background) | Used for                              | Light |  Dark | Needs |
| ------------------------------ | ------------------------------------- | ----: | ----: | ----: |
| text / bg                      | body text on app background           | 16.34 | 17.90 |   4.5 |
| text / surface                 | text on panels                        | 17.72 | 17.19 |   4.5 |
| text / surface-raised          | text in menus, dialogs, nodes         | 17.72 | 16.34 |   4.5 |
| text-muted / surface           | secondary text, section headings      |  5.75 |  9.31 |   4.5 |
| text-muted / bg                | secondary text on app background      |  5.30 |  9.70 |   4.5 |
| text-muted / surface-sunken    | search placeholder, palette hint      |  5.52 |  9.70 |   4.5 |
| text-muted / surface-hover     | segmented control labels              |  4.97 |  8.11 |   4.5 |
| text-muted / kbd-bg            | keyboard hints                        |  5.30 |  8.11 |   4.5 |
| accent-contrast / accent       | primary button label                  |  5.17 |  7.17 |   4.5 |
| accent-contrast / accent-hover | primary button label, hover           |  6.71 |  9.28 |   4.5 |
| accent-text / accent-subtle    | focused menu item, selected command   |  6.15 |  6.59 |   4.5 |
| danger / surface               | danger button label                   |  6.34 |  7.03 |   4.5 |
| danger / danger-subtle         | danger button hover, problems heading |  5.67 |  5.66 |   4.5 |
| text / warn-bg                 | warning banner                        | 16.20 | 12.61 |   4.5 |
| text / info-bg                 | info banner                           | 16.25 | 12.70 |   4.5 |
| surface / text                 | tooltip                               | 17.72 | 17.19 |   4.5 |
| focus / surface                | focus ring                            |  5.17 |  6.89 |     3 |
| focus / bg                     | focus ring on app background          |  4.77 |  7.17 |     3 |
| border-strong / surface        | input boundary                        |  3.64 |  3.24 |     3 |
| accent / surface               | selected node ring, unsaved dot       |  5.17 |  6.89 |     3 |
