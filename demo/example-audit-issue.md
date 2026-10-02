# Repo carries ~96k tokens of bulk data that AI coding agents pay to read

### Summary

I was measuring what repositories cost AI coding agents to read and ran a scan on `acme/api`. About **94% of its token weight** is content a model pays for but cannot use. Sharing the numbers in case they're useful — no action needed if this isn't a priority.

### What the scan found

- `data/customers.csv` — **96k tokens** (31% of the repo)
- `package-lock.json` — **79k tokens** (25% of the repo)
- **Test fixtures & snapshots** — 38k tokens across 2 files (12%), largest is `tests/__snapshots__/users.test.js.snap` at 12k
- `assets/map.svg` — **28k tokens** (9% of the repo)
- **3 byte-identical copies** of `format.js` — 5.4k tokens read more than once

Total: **312k tokens**, of which **292k are waste** and ~274k are safely removable.

### Why it matters

The repo is 1.6× a 200k-token window, so an agent can never hold all of it — and right now 94% of what it does load is unusable.

For contributors using Cursor, Claude Code or Copilot, that's $1.46 of every full-context pass spent on files that teach the model nothing — and less room in the window for the code they're actually asking about.

### Suggested fix

An `.agentignore` (same syntax as `.gitignore`, and readable as a `.cursorignore`) covers it:

```gitignore
assets/
dist/
data/customers.csv
package-lock.json
tests/fixtures/sample-response.json
tests/__snapshots__/users.test.js.snap
src/generated/api_pb2.py
src/types/schema.generated.ts
CHANGELOG.md
src/lib/format.js
src/routes/format.js
.git/
node_modules/
.venv/
__pycache__/
*.log
*.map
```

Happy to open a PR with this if it'd be welcome — or feel free to ignore it, I know unsolicited issues are a cost of their own.

---

<sub>Measured with [ctxray](https://github.com/geraltbhai/ctxray) (MIT, `npx ctxray`). Token counts are BPE estimates, ~6% median error, calibrated against `o200k_base`.</sub>
