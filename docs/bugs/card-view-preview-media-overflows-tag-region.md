# Bug: Card View Preview Media Overflows Tag Region

## Summary
In dashboard card view, cards that use an image or thumbnail as the primary preview could allow that preview area to grow so large that the article tag region was displaced or fully hidden. The issue was most visible in wide single-card layouts, especially just before auto layout promoted the dashboard from one column to two columns.

The issue is now resolved with a footer-adjacent single-row tag strip and a rollback of the over-constrained measured preview-height/grid changes that caused secondary layout regressions.

## Affected Area
- Dashboard article card view
- Tagged cards with image or thumbnail previews
- Most visible in:
  - manual single-column card view
  - auto layout at the largest single-card width before it switches to a two-card grid

## Initial User-Visible Symptoms
- At smaller card widths, the card renders correctly and the tag chip remains visible.
- As the same card grows wider in a single-card layout, the preview image scales up further.
- At the widest single-card width before the auto-layout threshold, the image consumes enough vertical space that the tag chip is pushed down and hidden behind or below the footer/toolbar boundary.
- User-provided screenshots show the `Important` tag visible in the smaller card state and hidden in the widest single-card state.

## Expected Behavior
- Tagged cards should always reserve visible space for the tag region.
- Preview media should crop or shrink before it can consume the tag region.
- Footer actions and relative date should remain visible and anchored at the bottom of the card.
- Auto layout may change column count for better card stability, but the tag region should not depend on that transition to remain visible.

## Actual Behavior
- Historical behavior:
  - preview media could overtake the space that should remain available for tags
  - the tag region was not guaranteed to remain visible at wide single-card widths
  - later attempts also introduced auto-grid density regressions and collapsed preview-strip rendering
- Final behavior after the successful fix:
  - the tag strip remains visible
  - card view keeps a single visible tag row with overflow summarized into the existing `+N` chip
  - auto layout again uses the expected multi-column density
  - preview media returns to a stable bounded slot instead of collapsing into a strip

## Change History And Attempted Fixes

### Attempt 1: Card-View CSS Cap For Preview Media
Goal:
- Constrain preview media height in card view.
- Keep tags and footer from shrinking out of view.

Implementation:
- Added card-view-specific CSS to keep `.rss-dashboard-card-content` as a vertical flex layout.
- Added a responsive `max-height` cap to `.rss-dashboard-cover-container`.
- Replaced the previous free-growing cover sizing with a more bounded aspect-ratio-based approach.
- Marked `.rss-dashboard-article-tags` and `.rss-dashboard-card-footer` as non-shrinking sections.

Outcome:
- Build passed.
- User reported the issue still reproduced.

Assessment:
- The CSS-only cap did not reliably prevent preview media from consuming the tag area in all single-card width states.

### Attempt 2: Hardened Tag Area And Auto-Promotion For Auto Layout
Goal:
- Reserve a fixed tag block for tagged cards.
- Force auto layout to promote to two columns earlier when a single card becomes too wide to remain stable.

Implementation:
- Added an auto-layout helper in `src/components/article-list.ts` to promote `cardColumnsPerRow = 0` to `repeat(2, minmax(0, 1fr))` once the container exceeded a stable single-card width threshold.
- Added a card class for tagged cards: `.rss-dashboard-article-card--has-tags`.
- Added CSS to reserve a fixed two-row tag section and clip overflow within that region.
- Treated preview media as the flexible/shrinkable section in tagged cards.

Outcome:
- Build passed.
- User reported the issue still reproduced.

Assessment:
- Early promotion to a two-column grid reduced some extreme widths in auto layout, but it did not solve the underlying card-body layout conflict.
- Manual single-column layouts remained vulnerable, and even auto layout still allowed a failing width range before promotion.

### Attempt 3: Rebuild Card Body Into Explicit Header / Preview / Tags Slots
Goal:
- Fix the problem structurally instead of relying on the existing card flow.

Implementation:
- Reworked `renderCardView()` in `src/components/article-list.ts` so card content is split into:
  - `.rss-dashboard-card-header`
  - `.rss-dashboard-card-preview-region`
  - `.rss-dashboard-card-tags-region`
- Kept `.rss-dashboard-card-footer` as a separate bottom sibling.
- Updated tag syncing so `syncArticleTags()` creates and updates tags inside `.rss-dashboard-card-tags-region`.
- Added slot-specific CSS in `styles.css` so the preview region is meant to be the only shrinkable area and tagged cards reserve a fixed two-row tag block.
- Kept the auto-layout helper as a secondary guardrail.

Outcome:
- Build passed.
- User validated that the issue still persists in the same real-world scenario.

Assessment:
- The structural change was directionally correct, but runtime layout is still not enforcing the reserved tag space strongly enough.
- Existing card sizing rules, cover sizing rules, or CSS precedence may still allow the preview box to dominate the card body.

### Attempt 4: Final Card-View Grid Override
Goal:
- Force the runtime cascade to honor an explicit grid contract at the end of `styles.css`.
- Eliminate the old `padding-top: 56.25%` card-view cover sizing by overriding it with a slot-owned preview region.

Implementation:
- Added a final end-of-file card-view override block in `styles.css`.
- Made `.rss-dashboard-article-card` a two-row shell: content plus footer.
- Made `.rss-dashboard-card-content` an explicit grid with:
  - header
  - preview
  - fixed-height tags row for tagged cards
- Overrode card-view `.rss-dashboard-cover-container` so it uses `height: 100%` and `padding-top: 0`.
- Kept the footer outside the content grid and removed the previous `margin-top: auto` dependency.

Outcome:
- Build passed.
- User reported the issue still reproduces in the failing wide single-card state.

Assessment:
- Even a final cascade override was not sufficient to stop the preview from effectively consuming the tag region.
- That strongly suggests the root problem is no longer “missing CSS,” but that the actual runtime geometry is being driven by a factor that the current stylesheet-only approach is not controlling reliably.

### Attempt 5: Footer-Adjacent Tag Strip Plus Measured Preview Height
Goal:
- Move tags out of the shrinkable card body.
- Measure preview height at runtime so the preview is assigned the remaining card space directly.

Implementation:
- Moved the card tag region to a footer-adjacent strip outside `.rss-dashboard-card-content`.
- Added runtime measurement in `src/components/article-list.ts` to calculate preview height from:
  - card height
  - header height
  - tag strip height
  - footer height
  - content padding and gaps
- Applied preview sizing after render, on resize, on tag updates, and after image-load failure cases.
- Added source-level card-view CSS in `src/styles/card-view.css` to support the measured preview region and footer-adjacent tag strip.

Outcome:
- The tag visibility problem improved materially.
- User reported that tag handling is now closer to the intended behavior.
- However, new regressions appeared:
  - auto layout is now only showing around two cards per row in states that previously showed five or six
  - preview images can collapse into a very thin horizontal strip
  - preview media no longer presents acceptably in normal auto-grid layout

Assessment:
- The measured-layout approach improved the tag-row failure but destabilized the broader card rendering model.
- The preview-height calculation is likely too tightly coupled to the fixed-height card contract and is now starving the preview region in normal grid states.
- The auto-layout density regression suggests the current post-fix card dimensions and/or grid constraints are no longer matching the original auto-fill behavior.

### Attempt 6: Single-Row Tag Strip With Width-Based Overflow Compaction
Goal:
- Keep only one visible tag row in card view.
- Replace hidden overflow tags with the existing `+N` summary chip based on real available width.

Implementation:
- Added card-specific tag rendering logic in `src/components/article-list.ts` to measure available tag-strip width.
- Rendered only the tags that fit within a single row.
- Collapsed the rest into the existing overflow chip.
- Updated `src/styles/card-view.css` so the card-view tag strip is a single non-wrapping flex row.

Outcome:
- Tag-strip behavior improved further and now matches the intended “single row plus overflow chip” behavior more closely.
- The image-strip and auto-grid regressions remain.

Assessment:
- Tag compaction is not the cause of the new media/layout regressions.
- The broader problem is now centered on card sizing, grid density, and preview-height allocation.

### Final Resolution: Preserve The Tag Strip, Remove The Over-Constrained Preview Logic
Goal:
- Keep the successful tag-strip behavior.
- Restore normal auto-grid density and preview rendering.

Implementation:
- Kept the footer-adjacent card tag strip.
- Kept the single-row card tag renderer with width-based overflow compaction into the existing `+N` chip.
- Removed the forced two-column auto-layout behavior that was reducing grid density in `auto`.
- Removed the measured preview-height logic that was collapsing previews into thin strips.
- Replaced the measured preview contract with a simpler bounded preview slot in `src/styles/card-view.css`.

Outcome:
- User validated the final result as correct.
- The original tag-visibility bug is resolved.
- The later regressions affecting auto-grid density and preview presentation are resolved as part of the final rollback/redesign.

## Technical Analysis
The repeated failures suggest the bug is not just a missing `max-height` or a missing `flex-shrink` rule. The stronger likelihood is that card view still has a layout contract mismatch between:
- fixed overall card height
- preview media that derives size from width or aspect ratio
- legacy or competing card-content sizing rules
- footer anchoring rules
- tag region reservation that is not absolute in the final computed layout

Likely root-cause scenarios:
- The preview container still participates in normal flow in a way that allows its intrinsic or aspect-ratio sizing to exceed the intended preview slot.
- A legacy selector in the existing stylesheet is overriding or partially overriding the newer slot-layout rules in the actual runtime cascade.
- The card body is still effectively using content-driven height at some widths, so the tag region is losing space despite the intended fixed reservation.
- The current card architecture is trying to preserve a fixed card height while also allowing width-driven media growth, which is fragile unless the row sizing is fully explicit and the preview area is hard-clipped.
- Some portion of the runtime card layout may need measured inline sizing rather than static CSS assumptions.
- The tags region may still be living inside a container that can be visually clipped even when its row is nominally reserved.
- The newest regressions suggest the measured preview-height system is over-constraining the card body and producing preview heights that are too small in normal grid states.
- The auto-layout grid calculation may now be interacting badly with the revised card shell, causing the dashboard to choose fewer columns than before.
- The current implementation may be solving the original tag collision by effectively shrinking the preview too aggressively rather than restoring a balanced card layout.

## Recommended Next Solution
None. The issue is resolved.

Final chosen solution:
1. Keep the footer-adjacent tag strip.
2. Keep the single-row card tag compaction logic with the existing `+N` overflow chip.
3. Avoid measured per-card preview sizing for this layout.
4. Keep auto grid behavior aligned with the original auto-fill density model.

## Validation
- Confirmed tagged cards keep a visible tag strip.
- Confirmed the tag strip is limited to one visible row with overflow summarized into `+N`.
- Confirmed auto layout returns to expected multi-column density.
- Confirmed preview media no longer collapses into a narrow strip.

## Status
Resolved.

Current state:
- Multiple implementation attempts have been made.
- The final implementation keeps the successful tag-strip behavior and removes the preview/grid regressions introduced by intermediate attempts.
- The user has confirmed the final result is correct.
