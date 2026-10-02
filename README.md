# ctxray

**See what your repository costs an AI coding agent.**

Point it at a repo. In under a second it tells you how many tokens the codebase is, what that costs on every model, which files are burning money without teaching the agent anything, and then writes the ignore file that removes them.

```
npx ctxray
```

No install, no config, no dependencies, no network calls. Node 18+.

---

```
  ctxray · ~/code/api
  1,204 files · 8.2 MB · scanned in 210ms · ctxray estimator (~6% median error)
  14 binary files (2.1 MB) counted as zero tokens — an agent skips them

  CONTEXT WEIGHT
  627k     tokens if an agent ingested this whole repo
    ██████████████████████▊·····························
  █ 275k signal (44%)   █ 352k waste (56%)

  GRADE   F   Severe. The agent is mostly reading noise.

  COST OF ONE FULL-CONTEXT PASS   (prices checked 2026-08-22)
  Claude Opus 5              $3.14  ████████████████  $1.76 of it wasted  ⚠ exceeds context window
  Claude Sonnet 5            $1.88  █████████▌······  $1.06 of it wasted  ⚠ exceeds context window
  Claude Haiku 4.5          $0.627  ███▏············  $0.352 of it wasted  ⚠ exceeds context window
  GPT-5 class                $3.14  ████████████████  $1.76 of it wasted
  Gemini 3.x Pro             $1.25  ██████▍·········  $0.704 of it wasted

  PROJECTED WASTE
  At 20 full-context Claude Opus 5 calls/day, the 352k wasted tokens cost
  $35.20 /day  ·  $1056 /month  ·  $12848 /year

  WHERE THE WASTE IS
  ● Lockfiles                       181k tok ██████████████████  1 file
  ● Test fixtures & snapshots        84k tok ████████▎·········  46 files
  ● Bulk data                        41k tok ████··············  3 files
  ● Build output                     28k tok ██▊···············  12 files
  ● Duplicate content                18k tok █▊················  9 files

  WORST OFFENDERS
      181k tok  package-lock.json         Dependency lockfile — huge, and the manifest says the same thing
       41k tok  test/fixtures/dump.json   Bulk data file (219 KB) — send a schema and 3 sample rows instead
       22k tok  dist/vendor.min.js        Minified bundle — maximum tokens, minimum meaning
```

---

## Why this exists

Coding agents got cheap enough to run constantly and expensive enough to notice. The bill is driven by input tokens, and input tokens are driven by what's in the repo — but nothing in your toolchain tells you what that number *is*.

So people find out the expensive way:

- A committed `package-lock.json` is routinely 150k–200k tokens. That is a whole Sonnet context window spent on integrity hashes.
- Jest snapshot directories quietly become the largest thing in the repo.
- A `fixtures/` folder with one 200k-row CSV costs more per agent call than the entire `src/` tree.
- Three copies of the same vendored helper get read three times, every time.

None of this helps the model. All of it is billed, and all of it makes the model worse — Chroma's "context rot" work found that every major model degrades as the input window fills, regardless of how large that window is. You are paying to make the answers worse.

`ctxray` puts a number on it and then removes it.

## What it does

| | |
| --- | --- |
| **Counts** | Every file, in tokens, using a BPE approximation calibrated against the real tokenizer |
| **Prices** | The whole repo across Claude, GPT and Gemini, with a daily/monthly/yearly burn projection |
| **Classifies** | 14 categories of context waste — lockfiles, build output, minified bundles, generated code, snapshots, bulk data, duplicates, vendored deps, binaries |
| **Fixes** | Writes an `.agentignore` derived from what it actually found, plus an `AGENTS.md` scaffold pre-filled with the repo's real shape |
| **Packs** | Given a token budget, picks the highest-value files that fit |
| **Guards** | CI mode and PR comments that catch waste before it lands |
| **Reports** | Drafts a write-up you can send to a maintainer — and refuses to when the repo is already clean |

## Install

```bash
npx ctxray            # no install
npm i -g ctxray       # or install it
```

## Usage

```bash
ctxray                              # scan the current directory
ctxray ~/code/api                   # scan somewhere else
ctxray --all                        # include what .gitignore hides
ctxray --model sonnet-5 --runs-per-day 60
ctxray --json | jq '.wasteCategories'
ctxray --list-files | head -20      # "tokens<TAB>path", heaviest first

ctxray init                         # write .agentignore + AGENTS.md
ctxray init --dry-run               # see them first
ctxray audit                        # draft a write-up for a maintainer
ctxray --badge                      # README badge markdown

ctxray --html report.html           # visual report            (Pro)
ctxray diff base.json --format pr   # PR comment               (Pro)
ctxray budget 100k                  # pack a context window    (Pro)
ctxray --ci --max-waste 15          # fail the build           (Pro)
```

Run `ctxray --help` for everything.

### `ctxray init`

Generates an `.agentignore` from your actual scan, not a boilerplate list:

```
# .agentignore — generated by ctxray
# 2026-08-22 · 1204 files scanned · 627k tokens total
#
# Estimated saving: 331k tokens per full-context pass.

# ---- directories that are almost entirely non-source ······· 28k tok · 12 files
dist/
coverage/

# ---- lockfiles ············································· 181k tok · 1 file
# Dependency lockfile — huge, and the manifest says the same thing
package-lock.json

# ---- test fixtures & snapshots ······························ 84k tok · 46 files
tests/__snapshots__/
tests/fixtures/large-response.json
```

It's `.gitignore` syntax, so it doubles as a `.cursorignore`, an `.aiexclude`, or an addition to your existing `.gitignore`. `ctxray` reads it back on the next run, so you can watch the number go down.

Alongside it you get an `AGENTS.md` scaffold with the repo's language mix, directory weights, and entry points already filled in — the parts an agent can read off the filesystem — leaving you the parts only you know.

### `ctxray budget`

```bash
$ ctxray budget 100k

  CONTEXT PACK — 100k token window, 15% reserved for the conversation

  38 files · 84k tokens · 61% of the repo's signal
```

Sorting by file size fills your window with `tsconfig.json`. This ranks by value per token — entry points, manifests and docs first, tests and deep leaves last — and greedily packs the window. Pipe it into whatever assembles your prompt:

```bash
ctxray budget 100k > context-files.txt
ctxray budget 100k --script pack.sh && ./pack.sh | pbcopy
```

### `ctxray audit`

Turns a scan into something you can send to a person — a GitHub issue, a PR description, an email, or a Slack message:

```bash
ctxray audit --format issue --repo acme/api
ctxray audit --format email --name Priya --out draft.txt
```

It has an unusual property for a report generator: **it refuses to write the message when the message isn't worth receiving.** Under 10% waste, under 20k wasted tokens, or fewer than 15 files, and it tells you to leave that repo alone. A tool that produces twenty confident issues about repositories that are already clean gets its author blocked, not thanked.

Read every draft before you send it. The tool writes the numbers; you are accountable for them.

### `ctxray diff`

```bash
ctxray --json > base.json
# ...make changes...
ctxray diff base.json --format pr
```

```
### 🟡 Context budget — Slightly more agent-visible waste than the baseline.

| | Base | This branch | Δ |
| --- | ---: | ---: | ---: |
| Tokens | 311,825 | 321,610 | +9.8k |
| Waste | 291,842 | 300,875 | +9.0k |
| Cost / full pass | $1.56 | $1.61 | $0.049 |

1 new file flagged as waste (9.0k tokens)
  tests/__snapshots__/orders.test.js.snap — snapshot under __snapshots__/
```

A one-off cleanup drifts back within a quarter. This is the ratchet.

### CI

```yaml
- run: npx ctxray --ci --max-waste 15 --max-tokens 400k
  env:
    CTXRAY_LICENSE: ${{ secrets.CTXRAY_LICENSE }}
```

Exits non-zero on a breach, writes GitHub Actions annotations, and posts a table to the job summary. Two ready-made workflows ship with the repo: [`ctxray.yml`](.github/workflows/ctxray.yml) for threshold enforcement, and [`ctxray-pr.yml`](.github/workflows/ctxray-pr.yml) which posts a self-updating context-budget comment on every pull request.

### Badges

```bash
ctxray --badge                                  # frozen numbers, no hosting
ctxray --badge --metric waste                   # or: tokens, grade
ctxray --badge-json .github/ctxray-badge.json   # self-updating via shields endpoint
```

## How accurate is the token count?

Accurate enough to make decisions with, and the error is published rather than hand-waved.

The estimator is a rule-based BPE approximation — no vocabulary file, no 300ms load, works offline. The rules mirror what real BPE does: `"\n"` plus indentation is a single token, a separator merges into the following word, identifiers split on camelCase, digits group in threes, punctuation runs partially merge.

Its constants were fitted by coordinate descent against `gpt-tokenizer` (`o200k_base`) over 435 files of Python, C, JavaScript, TypeScript, JSON, Markdown, YAML and shell:

| | |
| --- | --- |
| Corpus-wide bias | **0.0%** |
| Median per-file error | **6.1%** |
| 90th-percentile file error | **12.8%** |

Held out from the fit, whole-repository totals against `--exact`:

| Repository | Estimated | Exact (`o200k_base`) | Error |
| --- | ---: | ---: | ---: |
| npm CLI | 627,059 | 612,944 | +2.3% |
| A Python/React monorepo | 269,031 | 270,277 | −0.5% |
| ctxray itself | 71,976 | 66,976 | +7.5% |

Reproduce it yourself:

```bash
npm i gpt-tokenizer
npm run calibrate        # per-extension error table
npm run tune             # re-fit the constants
```

Want exact numbers instead of estimates?

```bash
npm i gpt-tokenizer
ctxray --exact
```

Two honest caveats. The calibration corpus skews toward Python, C and JavaScript, so exotic languages will drift further. And Anthropic's tokenizer is not `o200k_base` — it is close enough for budgeting, but Claude counts are approximations of an approximation.

## What counts as "waste"

Each finding carries a severity that drives the *reclaimable* figure, because the tool should not promise savings it cannot deliver:

| Severity | Meaning | Counted as reclaimable |
| --- | --- | --- |
| ● always | An agent never needs this | 100% |
| ● usually | Rarely needed; safe default | 90% |
| ● review | Depends on the project | 50% |

The rules are deliberately conservative. Directories like `packages/`, `bin/`, `lib/` and `env/` are **not** flagged despite looking like build output, because monorepos, Node CLIs and Go projects keep real source there — and the worst thing this tool could do is tell you to hide your own code from your agent. `.d.ts` files are not flagged either; type declarations are high-value context.

If you disagree with a call, delete the line. The generated file is a starting point, and it says so at the top.

Binary files are counted as **zero** tokens. Pricing them as base64 would inflate every headline number in the report, and no agent runner does that anyway — they're tracked separately and still added to the ignore file.

## Programmatic use

```js
const { analyze } = require('ctxray');
const { estimateTokens } = require('ctxray/tokenizer');
const { pack } = require('ctxray/budget');

const report = analyze('./', { exact: false });
console.log(report.totals.tokens, report.totals.wasteTokens);

for (const cat of report.wasteCategories) {
  console.log(cat.category, cat.tokens, cat.files);
}

const window = pack(report, 100_000);
console.log(window.selected.map(f => f.path));
```

The full report shape is documented by `ctxray --json`.

## Free vs Pro

Everything that **finds** problems is free forever, MIT-licensed, and always will be. Pro unlocks the outputs you share with other people and wire into automation.

| | Free | Pro |
| --- | :---: | :---: |
| Full scan, token counts, cost model | ✓ | ✓ |
| Waste detection, all 14 categories | ✓ | ✓ |
| Duplicate detection | ✓ | ✓ |
| `ctxray init` — `.agentignore` + `AGENTS.md` | ✓ | ✓ |
| `ctxray audit` — write-ups for maintainers | ✓ | ✓ |
| `--badge` README badges | ✓ | ✓ |
| JSON output, programmatic API | ✓ | ✓ |
| `--html` visual report | | ✓ |
| `diff` — PR comments and baselines | | ✓ |
| `budget` context packer | | ✓ |
| `--ci` thresholds and exit codes | | ✓ |
| Commercial use in CI | | ✓ |

Solo $19 · Team $49 · one-time, all future versions: **[buy a licence](https://eigensys-website.vercel.app/#contact)**

```bash
ctxray activate CTXRAY-…
# or, in CI:
export CTXRAY_LICENSE=CTXRAY-…
```

The licence check runs entirely on your machine and is trivial to bypass. That's deliberate and it's stated in [`src/license.js`](src/license.js) — it exists to make paying the obvious path for people who find this useful, not to fight anyone.

## Development

```bash
git clone https://github.com/geraltbhai/ctxray
cd ctxray
npm test          # 63 tests, no dependencies
npm run demo
```

The test suite builds a synthetic repository containing every waste category and asserts on real numbers. Two cases are worth knowing about:

- A **round-trip test** generates an `.agentignore`, re-scans, and verifies the savings actually materialised. It caught a real bug — gitignore has no inline comments, so annotated patterns were silently matching nothing.
- A **key-parity test** proves the Cloudflare licence worker and the CLI produce byte-identical keys, because a divergence there means buyers receive keys their own install rejects.

## Contributing

The most useful contributions are **classifier rules**: a directory or file pattern that is reliably waste (or reliably *not* waste, if `ctxray` gets it wrong on your repo). Open an issue with the path and the ecosystem. False positives are treated as bugs.

## Licence

MIT for the free tier. See [LICENSE](LICENSE).
