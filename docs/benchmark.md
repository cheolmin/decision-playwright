# Benchmarks

Measured on 2026-11-24/25 from Seoul, Windows 11, Microsoft Edge 158.
Decision: `Microsoft-Decision-1.1`, GlobalStandard, 100K TPM.
Host agent: Claude Code 2.1.296 through LiteLLM (GitHub Copilot models).

**Rules used in every test**

- The host model is forced per session (`--settings` and `--model`) and read back from the
  session result. A run counts only if the model was the one asked for.
- Success comes from the website: the URL that the server actually served, plus the agent's
  answer for "report" tasks. The agent saying "done" is not counted.
- "With skill" and "without skill" run in turns on the same task, so slow periods hit both.

## 1. One step: Decision vs LLM

Same page state, same element list, one "what next?" question. 6 pages × 10 calls.

| Chooser | Correct | Median | p90 | Max |
|---|---|---|---|---|
| **Decision-1.1** | 60/60 | **754 ms** | 1,030 ms | 1,157 ms |
| gpt-6-astra | 60/60 | 1,957 ms | 3,155 ms | 5,969 ms |
| gpt-6.1-terra | 60/60 | 3,255 ms | 4,640 ms | 5,365 ms |

| Page | Elements (Decision / LLM) | Decision | astra | terra |
|---|---|---|---|---|
| Search box | 3 / 3 | 718 ms | 1,901 ms | 4,289 ms |
| Sort dropdown | 3 / 3 | 761 ms | 2,013 ms | 3,908 ms |
| Settings checkbox | 6 / 6 | 727 ms | 1,924 ms | 2,885 ms |
| One link of 300 | **80** / 300 | 1,034 ms | 2,450 ms | 3,255 ms |
| Submit a filled form | 9 / 9 | 743 ms | 1,996 ms | 3,349 ms |
| Add to cart (49 buttons) | 49 / 49 | 769 ms | 1,936 ms | 2,860 ms |

Decision times above are from the client, East US 2 deployment through AI Gateway.

### Where the Decision time goes

The AI Gateway trace (`OTelSpans`, 99 requests) shows:

| Span | Median |
|---|---|
| Gateway inbound policies | 1.6 ms |
| **Backend (Decision model)** | **152 ms** |
| Gateway outbound | 1.2 ms |
| Whole gateway request | 155 ms |

The same request measured at the client in Seoul:

| | Time |
|---|---|
| New connection (DNS + TCP + TLS + request) | 690–875 ms |
| Reused connection | ~290 ms |
| Ping to East US 2 | 188 ms |

So about 0.6 s of a 0.75 s step is the network from Korea and the TLS setup, not the model.

## 2. Decision by region

Called from Seoul. 30 rounds × 2 request sizes (390 B and 17 KB), new and reused connection.

| Deployment | Inference region (header) | New conn, small | Reused, small | New conn, 17 KB | Reused, 17 KB | Errors |
|---|---|---|---|---|---|---|
| **Korea Central, GlobalStandard** | Australia East | **276 ms** | 213 ms | **385 ms** | 295 ms | 0 / 120 |
| **Korea Central, DataZoneStandard** | Australia East | **271 ms** | 210 ms | **359 ms** | 296 ms | 0 / 120 |
| East US 2 through AI Gateway | South Central US | 690 ms | 294 ms | 957 ms | 382 ms | 35 / 120 (429, 503) |
| East US 2, Foundry direct | South Central US | 875 ms | 292 ms | 1,149 ms | 366 ms | 4 / 120 (429) |

- With GlobalStandard and DataZoneStandard, Azure picks where inference runs. A Korea Central
  deployment ran in Australia East.
- A nearby entry point removes most of the cost of a new connection (54 ms vs 588 ms for TCP + TLS).

## 3. Agent tasks on test pages

Five local pages: search with sort, account settings (2 checkboxes, 2 dropdowns), a page with
300 links, a signup form (2 text fields, dropdown, radio, 2 checkboxes), and a 24-item cart.
3 runs per task and mode. Headless Edge.

| Model | Mode | Success | Mean | Median | LLM time | Decision time | Turns | Output tokens |
|---|---|---|---|---|---|---|---|---|
| gpt-6.1-terra | **with skill** | 15/15 | **55.3 s** | **51 s** | 33.3 s | 2.9 s (6 calls) | 6.7 | **389** |
| gpt-6.1-terra | without skill | 15/15 | 89.3 s | 74 s | 43.5 s | – | 7.2 | 968 |
| gpt-6-astra | **with skill** | 15/15 | **133.4 s** | **104 s** | 101.7 s | 4.5 s (6 calls) | 8.6 | **447** |
| gpt-6-astra | without skill | 15/15 | 182.0 s | 176 s | 92.3 s | – | 8.5 | 785 |

Per task, gpt-6.1-terra (mean seconds):

| Task | With skill | Without skill |
|---|---|---|
| Search | 66.9 | 71.3 |
| Settings | 63.1 | 77.5 |
| 300-link page | **47.0** | 67.9 |
| Signup form | **54.7** | 87.1 |
| Cart | **44.5** | 142.8 |

Without the skill, most extra time is the agent writing, running and fixing Playwright code
(39 s of tool time vs 12 s).

## 4. Real websites, visible browser

Headed Edge, real sites, gpt-6.1-terra, 3 runs per task and mode.
v0.2 = one agent turn per text field. v0.3 = `dpw run --fill` and multi-field `dpw type`.

| Task | Site | v0.2 | **v0.3** | Without skill |
|---|---|---|---|---|
| Log in, add 2 items, check out | saucedemo.com | 66.6 s · 10.7 turns | **40.9 s** · 6.0 turns | 29.5 s · 2.3 turns |
| Log in, log out, report message | the-internet.herokuapp.com | 45.4 s · 7.3 turns | **31.5 s** · 5.3 turns | 21.4 s |
| Category → book → price | books.toscrape.com | 31.9 s | 31.9 s | 23.4 s |
| Page 3 → first book title | books.toscrape.com | 35.9 s | 35.6 s | 22.8 s |
| Search → article → birth date | wikipedia.org | 37.4 s | 43.4 s | 35.1 s |
| Dropdown, then 2 checkboxes | the-internet.herokuapp.com | 36.3 s | 34.7 s | 24.0 s |
| **All** | | 42.3 s · 7.2 turns | **36.3 s** · 5.9 turns | 26.0 s · 2.2 turns |

All runs succeeded (18/18 in each column).

Time split, mean per session:

| | v0.3 with skill | Without skill |
|---|---|---|
| Host LLM | 12.4 s | 9.3 s |
| Decision-1.1 | 2.5 s | – |
| Browser actions | 1.8 s | – |
| Other tools, shell, process start | 14.9 s | 12.2 s |

**Why the skill is still slower here.** Without the skill the agent wrote one Playwright script
per task (mostly `data-test` or exact text selectors) and it worked the first time: 2 turns.
With the skill, a session is at least load skill → `dpw run` → `dpw snapshot && dpw stop` →
answer, and agents also ran `dpw setup` or `dpw config` first. Each agent turn costs about
2 s of LLM time plus about 1 s to start the shell.

**What `--fill` changed.** In v0.2 every text field was one `NEEDS_TYPING → type → resume`
round: the saucedemo checkout took 8 tool calls. In v0.3 the agent passes the known values
(`--fill '{"Username":"standard_user",...,"Postal Code":"12345"}'`) and the whole checkout is
one `dpw run` with no stop.

What this means: the skill saves the most when the agent would otherwise have to explore,
retry or read a long page (test pages: −38%). On small, stable, well-labeled pages, one plain
Playwright script is faster.

## 5. Bugs found by these tests and fixed

| Found in | Problem | Fix |
|---|---|---|
| Live API | A choice with only 1 candidate returns HTTP 422 | Skip the question; take the only target |
| 300-link page | Only the first 200 elements were sent; the target was cut | Rank elements by rare goal words, then viewport |
| Signup form | Weak `BLOCKED` with empty fields | Fall back to the next operation (TYPE_TEXT) |
| Signup form | `DONE` on a filled form that was not sent | Submit the changed form once, then continue |
| Wikipedia, login | Asked to type the same field again after the page changed | Stop with `NEEDS_VERIFICATION` and a reason |
| Edge headed | Translate popup over the page | Turn off translate and first-run prompts |
| One session | One dropped connection failed the run | Retry network errors twice |
| saucedemo | One agent turn per text field (5 fields = 5 extra turns) | `--fill` with known values; `NEEDS_TYPING` lists all empty fields; `dpw type` takes several fields |

## Reproduce

The benchmark scripts are not in this repository. They depend on a local LiteLLM setup.
The mock tests in `test/` cover the fixes above: `node test/run-tests.mjs`.
