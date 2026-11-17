# Cloud Tycoon

Browser game that teaches cloud architecture design to junior SRE, Cloud and DevOps engineers. The player builds an architecture on a grid, runs a traffic simulation, and scheduled failures try to break it.

Scratch project. Not a git repo.

## Run and test

```bash
xdg-open index.html        # play; no build step, no server needed
node test/check.js         # headless balance check, must print "all good"
```

Run `node test/check.js` after any change to `js/components.js`, `js/sim.js` or `js/scenarios.js`. It asserts every reference design passes its scenario and the naive single-server design fails it. It also validates that reference designs only use allowed components and legal links.

## Constraints

- **No build step, no dependencies, no ES modules.** The game must work when `index.html` is opened from `file://`, which blocks module imports. Scripts load in order through plain `<script>` tags.
- **`components.js`, `sim.js` and `scenarios.js` must stay free of DOM access.** They run in both the browser and node. Each ends with the same export shim: `module.exports` in node, `Object.assign(global, api)` in the browser.
- **The simulation is deterministic.** Randomness comes from a seeded generator (`scenario.seed`, default 1337). Do not call `Math.random()` in `sim.js`; the same design must always produce the same result. `Math.random()` in `game.js` is fine for visual effects only.
- **All art is code.** Sprites are 16x16 text maps in `js/sprites.js`. No image files.

## Layout

| File | Purpose |
|---|---|
| `js/components.js` | Component catalogue (capacity, cost, latency), link rules, grid size, `zoneOf` |
| `js/sim.js` | `Sim` class (traffic routing, chaos events, scoring) and `analyze` (post-mortem advice) |
| `js/scenarios.js` | Scenario definitions and reference designs |
| `js/sprites.js` | Pixel sprites |
| `js/game.js` | Canvas rendering, editing, panels, main loop |
| `test/check.js` | Headless balance check |

## Model

- Grid is 12 columns by 6 rows. Traffic flows left to right from the Users icon.
- **Zones are horizontal bands, two rows each, stacked top to bottom** (AZ-a, AZ-b, AZ-c). `zoneOf(row)` takes a row, not a column.
- Components marked `zoneless` (CDN, load balancer, queue) are managed services and survive AZ outages.
- Four request kinds: `static`, `read`, `write`, `async`. Each scenario sets a `mix`.
- Each tick is 0.1 simulated seconds. Requests are routed recursively through `Sim.route`; every request ends in exactly one `ok` or `fail` call, so `stats.ok + failures == stats.total`.
- A node that drops a request records a reason key (`overload`, `db-dead`, `no-db`, ...). Adding a new reason means adding it to both `REASON_TEXT` and `REASON_LABEL` in `sim.js`, and usually an advice rule in `analyze`.
- Scoring: all checks pass gives 2 stars, cost at 80% of budget or less gives 3, availability alone gives 1.
- Cost is a fixed monthly price per component. Auto scaling adds a per-instance price averaged over the run. There is no data transfer cost yet.

## Network levels

The first six scenarios (`net: true`, written in Indonesian for vocational students) teach AWS networking as one story. Rules that only apply when `scenario.net` is set:

- The grid is one VPC. `subnetOf(col)`: columns 0-1 are outside the VPC (`igw`, `s3`), 2-6 public subnets, 7-11 private subnets. `canPlace` enforces this in the UI and in `test/check.js`.
- Users must enter through `igw` (or `s3` for static). The IGW only delivers to nodes in a public subnet.
- Node `cfg` holds the settings edited in the SELECTED panel: `http`, `https`, `ssh` (`myip`/`any`) on web kinds, `dbsrc` (`web`/`any`) on `db`, `s3auth` (`key`/`role`) on web kinds, `public` on `s3`. Unset means closed, like a new Security Group.
- `Sim.audit()` returns best-practice findings. Any finding fails the run (check key `audit`). Scenario flags switch rules on: `needSsh`, `uploads`, `privateApp`, `egress`, `elastic`, `localDb`.
- The `scan` event kills every node that is internet-reachable with a port open to 0.0.0.0/0.
- `carry: '<id>'` makes a level start from the design saved for the previous level. `start` is the previous level's solution, so the check proves each level demands something new.

## Adding or changing a scenario

1. Edit `SCENARIOS` in `js/scenarios.js`. Reference designs use the compact `design(nodes, edges)` helper: nodes are `[kind, col, row, cfg?]`, edges are `'from>to'` strings, ids are generated as `kind-N` in order.
2. Give every scenario a `solution` that passes, ideally with 3 stars, so the "show a solution" button is honest.
3. Run `node test/check.js`. The output prints each check value and the 3-star cost line, which is what to tune budgets against.

Changing any number in `components.js` shifts the balance of every scenario. Rerun the check and retune budgets and targets rather than loosening the test.

## Checking the UI

Headless Chrome is available. The page has URL hooks for this:

- `index.html?demo=<scenario id>` loads the reference design and starts the run.
- `&at=<seconds>` fast-forwards the simulation to that time before the first frame.
- `&fast=1` runs to the end and shows the result screen.

```bash
google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
  --user-data-dir="$SCRATCH/prof" --window-size=1500,950 --virtual-time-budget=3000 \
  --enable-logging=stderr --screenshot="$SCRATCH/shot.png" \
  "file://$PWD/index.html?demo=zone&at=22" 2>&1 | grep -E "CONSOLE|Uncaught"
```

`requestAnimationFrame` barely advances under `--virtual-time-budget`, so a headless run does not progress on its own. Use `&at=` to capture a mid-run state. Pointer interaction (place, drag to link, move, delete) cannot be verified headlessly; say so rather than claiming it works.

Use a separate `--user-data-dir` so demo runs do not write into the real browser profile's saved progress.

## Saved state

Progress and per-scenario designs live in localStorage under the `cloudtycoon.` prefix. Keys from the old names (`cloudcraft.`, `cloudcommander.`) are migrated once at startup. A saved design overrides a scenario's `start` layout, so layout or grid changes do not reach players who already have a saved design for that scenario.

## Look

The UI follows a bright tycoon-game style: green rounded frames (`.panel`) that hold light inset boxes (`.box`) with dark text. Put text on an inset, not directly on a green frame, except white headings. The world canvas is a daylight scene, so anything drawn on it needs the dark `INK` outline to stay readable (see `text()` and the packet drawing in `js/game.js`). The map is top-down, not isometric.
