# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/onnyh/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/onnyh/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it reads unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON text-editor tool calls to one written specification, finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none. The specification is SPEC.md.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-`/absent to read it from standard input. `--format=NAME` reads one format (`unified`, `search-replace`, `v4a`, `json`; `auto` detects it). `--check` reports what would change without writing anything. `--strict` matches lines exactly. Example:

```sh
node main.ts change.diff
cat change.diff | node main.ts --format=v4a -
```

Node 22 and its standard library only; nothing is installed. `runner.ts` is the kit's runner (kept as it is) and `check.ts` runs the practice set on your own machine.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
