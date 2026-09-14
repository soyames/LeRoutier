# Cross-system Tests

`e2e/` contains user journeys spanning applications/services. `fixtures/` contains deterministic shared test data.

Critical scenarios include concurrent last-seat booking, intermediate-stop seat reuse, payment callback replay, driver boarding/alighting, trip disruption and passenger recovery, stale location updates and low-connectivity retry behavior.

Current automated coverage is in `e2e/apps.spec.js`: production rendering,
shared UI/CSS, direct paths, reloads, navigation/history and mobile viewport
behavior for Passenger, Driver and Regulation. Run `pnpm build`,
`pnpm exec playwright install chromium`, then `pnpm test` from the repository root.
Backend/domain scenarios above remain planned until those services exist.
