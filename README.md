# dsh-llmwiki-memory

English | [中文](README.zh.md)

A dsh plugin: maintains "working topic memory" as an [OKF (Open Knowledge Format v0.2)](https://github.com/GoogleCloudPlatform/open-knowledge-format) knowledge bundle, persisted in a local git repository (optionally synced to a private GitHub repo), with conclusions traceable through git history, sessions automatically observed and distilled into knowledge, and relevant topics injected to the model before every turn.

> **Requires dsh >= 0.1.2-alpha.4** (adapted to the dsh 0.1.2-alpha.4 settings namespace and LLM seam; the rc line is no longer supported).

## The problem it solves

Long sessions forget. Cross-session, even more so. This plugin maintains **structured topic memory**: each Topic records a matter's **name, dependencies, open questions, current conclusion, impact, and recommendations**. When a conclusion changes, edit the file and commit — `git log` directly answers "when, by whom, and why did this conclusion change".

## Core features

- **Strict OKF v0.2 compliance**: each Topic is a `markdown + YAML frontmatter` concept document (`type: Topic`) that the whole OKF ecosystem (Obsidian, OKF validators) can consume directly; ships with the provenance (`sources`), trust (`generated`/`verified`), and lifecycle (`status`/`stale_after`) field families.
- **Git-traceable**: one conclusion change = one commit (write-through); the `topic_history` tool and `/wiki history` make change history first-class.
- **Local-first**: local-only mode by default (`~/.dsh/llmwiki/`), zero config, zero credentials; setting `repo` enables GitHub sync (single repo, single bundle, single `main`, write-through + debounced push; rebase conflicts are demoted and flagged for a human — no automatic smart-merge).
- **LLM-free hot-path injection**: per-turn lexical matching (CJK bigrams + words + weighted tags + `depends` graph walk), millisecond-scale; zero matches = zero injection; per-topic digest ≤300 tokens, top-K ≤4, total budget ≤1.5k tokens — all configurable.
- **Observable, tunable injection**: every turn writes an Injection Log (hits, scores, near-misses, budget usage); `/wiki stats` reports hit rate, top-N, near-miss distribution, and tuning suggestions — tune from evidence, not vibes.
- **Knowledge as a graph**: `depends` (machine-readable directed edges) plus body `[[wikilinks]]` and markdown links (human-written edges) form one graph; retrieval walks it in both directions (per-level decay, configurable depth) so a single hit pulls in a knowledge subgraph; every write rebuilds the `meta/backlinks.json` reverse index, and `/wiki show` lists "who references me, and how" — check the blast radius before changing a conclusion.
- **Two-stage observer (M2)**: the main model jots atomic observations with `topic_observe`; a background distill lane (session end + every N turns, model configurable) distills them into formal Topics in batches; when the model itself deems something worth keeping, it `topic_save`s directly.

## Quick start

1. Install (command below), restart dsh;
2. Run `/wiki onboard` — native dsh ask-user panels walk you through the five decisions: mode / repo / distill model / injection tier / auto-observe — nothing is written until the final confirm;
3. Work as usual: relevant conclusions are injected every turn; say "remember…" to have the model `topic_save`; `/wiki status` for health, `/wiki stats` for injection stats.

## Tools & commands

| Model tools | Purpose |
|---|---|
| `topic_save` | Distill/revise a Topic (name / dependencies / open questions / conclusion / impact / recommendations) |
| `topic_observe` | Jot an atomic observation (decision/finding/constraint/question), pending distill |
| `topic_search` | LLM-free keyword search over memory |
| `topic_history` | A topic's conclusion change history (git log as a tool) |

| Command | Purpose |
|---|---|
| `/wiki onboard` | Interactive setup wizard on dsh-native ask-user panels (mode / repo / distill model / injection tier / auto-observe); typed fallback where no ask-user UI exists |
| `/wiki status` | Bundle health: topic count, observation backlog, conflicts, sync status |
| `/wiki stats` | Injection stats: hit rate, top-N, near-miss distribution, tuning advice |
| `/wiki list` / `show` / `history` | Browse topics, backlinks, and change history |
| `/wiki graph` | Generate a relationship-graph web page (force-directed, draggable/zoomable, hover for conclusions) and open it in the browser |
| `/wiki sync [pull\|push]` | GitHub mode: manual pull/push (automatic by default) |
| `/wiki config` / `set <key> <value>` | View and edit config (thresholds, budgets, distill model, …) |

## Install

```bash
dsh plugin --profile <your profile> add @aiwayds/dsh-llmwiki-memory
```

First thing after installing: run `/wiki onboard`. The bundle lives at `~/.dsh/llmwiki/` by default (`$DSH_LLMWIKI_HOME` overrides). GitHub sync: `/wiki set repo <owner/name>` (suggested repo name `dsh-wiki-memory`, to keep it distinct from the plugin's own source repo); credentials come from `$GITHUB_TOKEN` or a logged-in gh CLI (login is not this plugin's job).

## Configuration

First-time setup belongs to `/wiki onboard`; day-to-day tuning is `/wiki set <key> <value>` (writes the `llmwiki` namespace in `settings.yaml`, effective from the next session). All keys and defaults:

| Key | Default | Meaning |
|---|---|---|
| `repo` | empty (local-only) | GitHub sync repo `owner/name`; suggested `dsh-wiki-memory`; empty = back to local-only |
| `autoInject` | `true` | Per-turn injection master switch |
| `injectDedup` | `true` | Session-level injection dedup: topics already injected in this session are not re-injected (registry cleared at session end; budget-dropped topics stay injectable; deduped topK slots are NOT backfilled) — ADR 0012 |
| `topK` | `4` | Max topics injected per turn |
| `perTopicBudget` | `300` | Per-topic digest token budget |
| `totalBudget` | `1500` | Total injection budget per turn |
| `matchThreshold` | `0.3` | Hit threshold; tune from `/wiki stats` near-miss evidence |
| `tagBoost` | `0.15` | Additive boost per tag hit |
| `graphDepth` | `2` | `depends` graph walk depth (0 disables) |
| `recencyWindowDays` | `7` | Recency bonus window (+0.2) |
| `autoObserve` | `true` | Capture atomic observations every turn |
| `includeSubagents` | `true` | Whether injection and observation also engage subagent sessions (ADR 0011); `off` skips them entirely |
| `observationMaxChars` | `2000` | Per-side per-turn observation truncation |
| `distillProvider` / `distillModel` | empty (distill off) | Distill lane model route; both must be set to enable. With a UI, `/wiki set distill-provider` / `distill-model` without a value opens a picker panel (provider list → that provider's model catalog); a mixed `provider model` / `provider/model` value for `distill-model` splits into both keys |
| `distillEveryTurns` | `5` | Distill every N turns of a long session |
| `distillOnSessionEnd` | `true` | Distill once when a session ends |
| `distillBatchSize` | `40` | Observations per distill model call. On an output-limit (`max-tokens`) failure the batch halves automatically (floor 5) and retries — a failing batch can no longer livelock the backlog; the shrink persists until reload or a config change. Note: `/wiki set distillBatchSize` back to the same value does not reset the shrink — set a different value or reload the plugin |
| `distillMaxModelCalls` | `3` | Max model calls per distill run, including the one corrective retry for ops echoing no valid `observed_ids` (the run stalls when the budget can't fit it). Batches already distilled keep their marks when the budget stops the run (partial progress), recorded as `partial: …` in the distill state |
| `pushDebounceSeconds` | `45` | GitHub-mode debounced push interval |

## Acknowledgements

This project's shape is directly inspired and supported by:

- **[zosmaai/pi-llm-wiki](https://github.com/zosmaai/pi-llm-wiki)** — a native OKF v0.2 knowledge extension for pi and this project's direct inspiration; its two-stage observation (cheap atomic observations + background distill), cache-safe injection (volatile content never enters the system prompt), and layered vault & ownership model are all absorbed here.
- **[GoogleCloudPlatform/open-knowledge-format](https://github.com/GoogleCloudPlatform/open-knowledge-format)** — the Open Knowledge Format (OKF) v0.2 spec this bundle format strictly follows.
- **[Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a5bf55591489e981c11519de94f)** — the starting point of the whole "an LLM maintains a personal knowledge base" methodology.
- **[fan56/pi-topic-memory](https://github.com/fan56/pi-topic-memory)** — the same author's predecessor: a working topic ledger with silent injection for pi; its LLM-free hot-path matching and injection-timing experience is this project's direct technical ancestor.
- **[chancelu/dsh-llmwiki](https://github.com/chancelu/dsh-llmwiki)** — a fellow dsh-ecosystem precedent; this project's same-turn injection seam (`agent/inbox/spliced` + `systemPrompt.context()`) follows the mechanism it validated on real dsh.

## Known boundaries

- **Subagents engage memory by default — one switch to opt out**: by default (`include-subagents` on), injection and observation apply to subagent sessions too. `/wiki set include-subagents off` skips delegated sessions entirely — no injection, no observation, no distill triggers; the topic tools stay on the global layer, so an explicit `topic_save` from a child still lands. Out-of-process subagents (claude-code/codex providers) never load this plugin anyway.
- **Session-end distill in headless one-shot sessions**: the distill lane runs asynchronously after turn/end fires, and a headless process exits right after answering — a real model call (seconds) mostly loses the race against process exit. Multi-turn long sessions (tui/web) are unaffected for the every-N-turns distill; `meta/distill-state.json` records each lane's outcome, checkable via `/wiki status`.
- **Config read timing**: `/wiki set` and `settings.yaml` edits take effect most reliably from the next session start.
- **Picking a distill model**: `/wiki onboard` splits the distill decision into two dependent questions (provider first, then that provider's model catalog), pre-validated with `resolveModelInfo` — a provider with no live route blocks and re-asks, an off-catalog model (a non-NO_ADAPTER failure: outside the advisory catalog, possibly still usable) warns but is allowed; hosts without an ask UI or a usable model route fall back to typed input. The same validation backs the `/wiki set` picker panels.

## Design docs

- [CONTEXT.md](CONTEXT.md) — domain glossary
- [docs/adr/](docs/adr/) — 0001–0012: OKF compliance, remote shape, sync strategy, two-stage observer, bundle layout, injection defaults, observability & tunables, dual-mode persistence, onboarding wizard, subagent isolation, the include-subagents switch, injection dedup default-on

## License

MIT
