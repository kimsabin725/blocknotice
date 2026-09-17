# English pitch deck — design and evidence plan

Adapted from `pitch.html`, `DEMO.md`, and `README.en.md`. The README is authoritative where older slides overstate guarantees. Evidence snapshot: 17 September 2026.

## Direction

Audience: TRUST404 judges and potential issuer/operator partners. Editorial approach: conclusion-led slide titles, a structured argument, clearly labeled evidence, and an explicit adoption hypothesis. No invented market size, revenue, traction, or customer claims.

Visual language: consulting presentation, with white analytical pages and navy opening/closing pages. Gold indicates a clock, transition, or key implication. Flat table rules and strong typography replace decorative card grids. All substantive diagrams are vector shapes and editable text.

Palette: navy `#10283F`, ink `#172D40`, gold `#AE812B`, pale gold `#F4EDDE`, slate `#526477`, light surface `#F1F4F6`, rule `#D7DEE4`, white `#FFFFFF`, teal `#21766B`, rust `#A24B35`.

Type: Arial Regular/Bold for clear, portable English typography. Figma font availability must be checked before build. Display sizes 76–100 px; slide titles 52–58 px; body 28–32 px; sources 18–20 px on a 1920 × 1080 canvas.

Signature: three numbered milestones connected by a gold clock line. Repeated in the cover, protocol, and close. Footer carries evidence date, source, and page number.

## Slide plan

| # | Conclusion / purpose | Spatial approach | Background |
|---|---|---|---|
| 1 | Make every redemption delay attributable | Oversized title on the left; three-stage vertical clock on the right; restrained project metadata below | Navy |
| 2 | One redemption journey. Three accountable clocks | Three horizontal numbered arguments above a full-width evidence strip | White |
| 3 | A token lock reveals custody—not who is delaying redemption | Long process across the middle; public evidence above and institutional blind spots below | White / light gray band |
| 4 | Start with holders who can sign and institutions that can integrate | Large primary-user statement on the left; three ranked eligibility rows on the right | White / navy left panel |
| 5 | Each clock starts from a different onchain event | Full-width aligned responsibility table, followed by a gold implication band | White |
| 6 | Public commitments make records independently checkable | Horizontal architecture with three layered columns; privacy boundary along the bottom | White |
| 7 | The escrow returns, holds, or burns under explicit conditions | Three large outcome lanes with trigger → state → token effect; concise dispute-period note | White |
| 8 | Missing evidence must remain distinct from a proven breach | Five-status vertical legend on the left; scoped guarantees and threat actors on the right | Light gray / white |
| 9 | The prototype is reproducible; production validation is still ahead | Three large evidence metrics above separate local and public evidence bands | White |
| 10 | The contribution is accountability for offchain decisions | Comparison table: rollup inclusion, transparency logs, BlockNotice; single emphasized delta below | White |
| 11 | Adoption depends on identity, disputes, and operational controls | Three numbered workstreams; readiness strip separates shipped prototype from proposed next steps | White |
| 12 | Verify the evidence. Then test the operating model | Closing claim at top-left, two large reproduction commands, concise deployment registry on the right | Navy |

## Accuracy guardrails

- 107 Solidity tests + 84 TypeScript tests = 191; 30 local scenarios = 20 attack + 10 honest. Expected findings match; no statistical false-positive-rate claim.
- Public Sepolia evidence is deployment/registration and three Sourcify exact matches, not full public-chain redemption or security audit.
- MockGold is permissionless-mint and has no physical-gold backing; three institution service IDs share one demo wallet.
- Content hashes coexist with public addresses, amounts, deadlines, and state metadata.
- Operator non-response returns tokens only when `finalize` is called; provider non-response and disputes retain the lock.
- After a delivery proof is accepted, the holder receives the full dispute period. After expiry in `DELIVERED`, anyone can call `burn`.
- No physical-delivery, reserve, private-reason truth, customer-balance, or legal-enforcement guarantee.
- Losing the holder key prevents holder-only actions; it does not erase public evidence.
- Institutional staking/penalties are absent, while holder token escrow is implemented.

## Delivery status

The English HTML and 12-page PDF are complete. Browser validation found no text overlaps or overflow; every slide was visually reviewed. Native Figma creation remains pending: after reconnection, the installed Figma plugin returned `Unknown tool: figma.whoami`. No Figma file has been created. The shared scene data preserves text, vector shapes, grouping, typography, and layout for transfer once tool access works.
