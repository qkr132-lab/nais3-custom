# NAIS3 scene censor controls

## Atmosphere
Extend the existing compact Korean image studio. Preserve Pretendard, theme variables,
Lucide icons and Radix controls. Direction: native NAIS3 utility UI; variance 2,
motion 1, density 7. Scope is a batch toolbar, card status and settings dialog.

## Color
Use the existing runtime theme, never hard-code colors in new components.
Light / dark defaults from assets/main.css:
paper #fafafa / #0f0f10; surface #f1f1f2 / #161618;
surface-2 #e8e8ea / #1e1e21; ink #19191b / #e9e9ea;
muted #6d6d73 / #8e8e94; line #e3e3e6 / #252528;
accent #c2610a / #eb9550; danger #a85a52 / #c47a72.
Each name maps to --name and its Tailwind semantic utility. Accent-soft and
accent/10 backgrounds communicate selected state with text and checkmarks too.

## Typography
Use --font-ui (Pretendard Variable and Korean system fallbacks). Inherit --ui-scale.
Card status 11px medium; helper text 12px regular; controls 13px medium;
dialog title 15px semibold. Monospace only for expandable raw prompt preview.

## Spacing
Tailwind base unit 4px: 0, 0.5 (2px), 1, 1.5 (6px), 2, 2.5 (10px), 3, 4, 5, 6.
Icons 12/14/16px; touch/control heights 28/32/36px. Border 1px, focus ring 2px.
Dialog max width 460px (shared primitive); max height 85dvh with internal scroll.
Card footer gains a 28px status row outside the image; card itself keeps its aspect ratio.

## Components
Toolbar uses shared small Button. Censor action is adjacent to selection count.
Card status is a full-width footer button, muted when off and accent when on;
long summaries truncate with full accessible label/title. It never covers the image.
Dialog uses four stacked checkbox rows with per-option affected scene counts.
Mixed options remain unchanged unless explicitly changed; select all / clear all
are draft actions. Apply is explicit; cancel and Escape discard the draft.
Use rounded-md (6px), rounded-lg (8px), existing rounded-2xl dialog (16px).
Hover surface-2, keyboard focus accent ring, disabled shared Button opacity.
Save error is inline and retains the draft. Empty selection disables batch apply.

## Motion
No new animation. Preserve existing shared dialog behavior. No layout animation added.

## Depth
Border and tonal surfaces; shared modal overlay/shadow only. No new gradients,
decorative imagery, pills over images or standalone color system.

## Tag completion extension
Use the same theme and Pretendard. English tags use the existing mono stack;
Korean meanings and controls use UI type at 12px/13px. Semantic type colors from
the existing editor: artist #e05c50, character #5c9e6e, copyright #b07fd8,
meta #c9a34f, fragment #5cbe7d. No new palette.
Suggestion rows are fixed 48px, padded 10px horizontally, separated by tonal
selection rather than expanding descriptions. Popup width 360px, max viewport
width minus 16px; list max-height 288px with internal scrolling. Header 32px;
footer uses fixed two-line description height 32px and a compact action row.
Popup attaches to the editor edge through Radix Popover with 6px offset and 8px
collision padding; never follows the caret under the mouse. Existing modal
layering must be respected. No popup entrance animation or layout shifts.
English/Korean match reason, recent/frequent usage and loading/error/empty states
are explicit text. First result is selected; arrow keys choose; Enter/Tab insert;
Shift+Enter inserts a newline. IME confirmation never accepts a candidate.
Clicking inserts only on pointer release after a stable
row identity check. Escape dismisses only the suggestion layer. Ctrl+Space opens
search/history; user-confirmed insertion retains native undo and an undo toast.

## Censor strength and unified suggestions
Censor option rows contain a checkbox and a separate labelled native range control,
with a numeric value (0.1 steps), weak/strong endpoints and existing accent styling.
Positive ranges 0.1–5; common suppression magnitude 0–3 (rendered as a negative
weight). Preserve per-scene mixed values until explicitly edited. Use 24px range
height, 12px labels, 12px padding and existing borders/radii; keep footer visible
while the settings body scrolls. Reset weights is separate from enabling options.
Tag suggestions use a single list: relevance first, then recent/frequent history,
deduplicated by canonical tag. Remove the search/recent/frequent tab navigation.
