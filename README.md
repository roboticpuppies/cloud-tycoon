# Cloud Tycoon

A 2D pixel game for learning cloud architecture design. Build an architecture on a map of three stacked Availability Zones, hit RUN, and watch traffic flow while scheduled failures try to break it. Aimed at junior SRE, Cloud and DevOps engineers.

## Play

Open `index.html` in a browser. No build step, no server, no dependencies.

```bash
xdg-open index.html
# or serve it
python3 -m http.server 8000
```

Progress and designs are saved in the browser's localStorage.

## Controls

- **Place:** pick a component, click a tile.
- **Link:** drag from one node onto another. Start from the Users icon. Drag the same link again to remove it.
- **Move:** drag a node onto an empty tile.
- **Delete:** right-click a node, or select it and press Delete.

## Scenarios

| # | Scenario | Teaches |
|---|---|---|
| 1 | Hello, Cloud | Request path basics |
| 2 | The 3 AM Crash | Redundancy, load balancer health checks, N+1 |
| 3 | Zone Down | Multi-AZ design, failure domains |
| 4 | Database Down | Replication, failover, RTO |
| 5 | Cache Me If You Can | Caching read-heavy load |
| 6 | Cache Stampede | Designing for a cold cache |
| 7 | Background Jobs | Message queues, workers, backlog |
| 8 | Flash Sale | Auto scaling, scaling lag, minimum capacity |
| 9 | Going Global | CDN and edge latency |
| 10 | Penny Pincher | Cost optimization, right-sizing |
| 11 | Black Friday | Everything at once |
| 12 | Sandbox | Free play with chaos buttons |

Each run is scored on availability, average latency, monthly cost and async job completion. Passing gives 2 stars. Spending 80% of budget or less gives 3. A failed run produces a post-mortem that names what broke and why.

## Layout

| File | Purpose |
|---|---|
| `js/components.js` | Component catalogue: capacity, cost, latency, link rules |
| `js/sim.js` | Traffic and chaos simulator, post-mortem advice. Pure logic, no DOM |
| `js/scenarios.js` | Scenario definitions and reference designs |
| `js/sprites.js` | Pixel sprites as text maps |
| `js/game.js` | Canvas rendering, editing, UI |
| `test/check.js` | Headless balance check |

## Test

```bash
node test/check.js
```

Runs every reference design through the simulator and asserts it passes, and that the naive single-server design fails. Run it after changing any number in `components.js` or `scenarios.js`.

`index.html?demo=<scenario id>` loads the reference design and runs it. Add `&fast=1` to jump straight to the result.

## Adding a scenario

Append an object to `SCENARIOS` in `js/scenarios.js`: traffic `rate` and `mix`, `budget`, `targets`, a list of `events` (`kill`, `az`, `spike`), the `allowed` components and a reference `solution`. Then run the test.

## Simplifications

The model is deliberately small. Costs are proportional, not real prices. Latency is an average, not a percentile. One database primary only. The simulation is deterministic, so the same design always gets the same result.
