# English pitch deck

The 12-slide English deck adapts the original presentation into a consulting-style narrative: conclusion-led headlines, responsibility tables, explicit token outcomes, and clearly scoped verification evidence. Content reflects the 17 September 2026 snapshot in the main README.

- [PDF](BlockNotice_pitch_en.pdf): presentation-ready, 16:9.
- [HTML](pitch.en.html): standalone slides; open locally in a browser.
- [Source](pitch.en.source.cjs): editable content and layout generator, using Node.js built-ins only.
- [Scene data](pitch.en.scene.json): structured text, vector shapes, groups, colors, and coordinates for a native Figma Slides build.
- [Design and evidence plan](pitch.en.plan.md): slide narrative and accuracy guardrails.

To regenerate HTML and scene data, run `node deck/pitch.en.source.cjs` from the repository root. Print the HTML to PDF with background graphics enabled and CSS page size respected (20 × 11.25 inches). The committed PDF was generated with Chrome and checked for 12 pages, text overflow, and text overlap.

**Figma status:** pending. The Figma plugin was invoked, but its account lookup returned `Unknown tool: figma.whoami` after reconnection. No native Figma file or share link exists yet. The HTML/PDF are local deliverables, not Figma exports.

The original Korean presentation remains available separately. No market-size, customer-traction, investment-return, physical-reserve, or security-audit claims were added.

## Korean deck

`BlockNotice_pitch_ko.pdf` is the Korean deck, rendered from `pitch.ko.source.cjs` into
`pitch.ko.html`. It reuses the English deck's design system — same canvas, grid, colour tokens and
`slide()`/`row()`/`stack()` primitives — with Korean copy and a Korean font stack, so the two decks read
as one set. Regenerate with `node deck/pitch.ko.source.cjs`, then print `pitch.ko.html` at 297x167mm with
background graphics on.

`pitch.html` is the earlier standalone Korean deck in a different, plainer style. It is kept for history and
is no longer the submitted file.
