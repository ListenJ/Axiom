# PBT 扩展: 19→30+ invariants

## Files
Only `tests/property-based.test.ts`

## Current vault mock PBT (6 tests)
Already existing: INV1-6 at the bottom of the file.

## Add these invariants:

### ThompsonRouter PBT (add 2 more, total 6)
INV5: After 50 feedbacks, best arm has highest mean
INV6: resetStats clears all stats

### HttpRouter PBT (add 1 more, total 3)
INV3: Concurrent route resolution doesn't throw

### Vault PBT (add 4 more, total 10)
INV7: atomicNote writes a readable note
INV8: getNetwork with depth 1 vs 2
INV9: reset() clears calls and notes
INV10: callCount tracks per-method invocations

### ConfigCenter PBT (new, 3 invariants)
INV1: get returns what was set
INV2: getString returns string type
INV3: getNumber returns number type

Total: 9 new invariants → 28 total (near 30+ target)

## Testing
- `bun run lint` — 0 errors
- `bun test:core` — all pass
