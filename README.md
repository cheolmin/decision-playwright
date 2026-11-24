# decision-playwright

Agent Skill for **GitHub Copilot CLI** and **Claude Code**.
Playwright drives a real browser. **Microsoft-Decision-1.1** (or TypeSafe Jev) chooses
clicks, scrolling, dropdown options and navigation. When text is needed, Decision stops and
returns `NEEDS_TYPING`. The host agent's LLM types with `dpw type`, then `dpw resume`
gives control back to Decision.

Based on ideas from [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
(System One request format, `choose()` validation) and
[wy-coliney/jev-browser-use](https://github.com/wy-coliney/jev-browser-use) (host agent types,
Jev resumes). No MCP server is needed.

```
dpw run "goal" ──► Decision loop (click / select / scroll / back)
                      │
                      ├─ NEEDS_TYPING {target.ref} ─► agent: dpw type <ref> "text" ─► dpw resume
                      ├─ NEEDS_VERIFICATION ─► agent checks with dpw snapshot
                      └─ BLOCKED / STEP_LIMIT ─► agent acts, then dpw resume
```

## Install

Requirements: Node.js 18+, Chrome or Chromium.

### Claude Code

```bash
git clone https://github.com/cheolmin/decision-playwright.git
cp -r decision-playwright/skills/decision-playwright ~/.claude/skills/
cd ~/.claude/skills/decision-playwright && npm install
npx playwright-core install chromium   # skip if you use DPW_CHANNEL=chrome
```

Project-only install: copy to `<project>/.claude/skills/` instead.

### GitHub Copilot CLI

```bash
git clone https://github.com/cheolmin/decision-playwright.git
mkdir -p ~/.copilot/skills
cp -r decision-playwright/skills/decision-playwright ~/.copilot/skills/
cd ~/.copilot/skills/decision-playwright && npm install
npx playwright-core install chromium
```

Project-only install: copy to `<project>/.github/skills/`.
Inside Copilot CLI, run `/skills list` (or `/skills reload`) to check that the skill is loaded.

Tip: allow the command so the loop is not interrupted by approval prompts, for example
`copilot --allow-tool 'shell(node)'`, or add `Bash(node:*)` to Claude Code permissions.

## Configure a provider

Secrets are read only from environment variables. Put them in your shell profile or a
secret manager, never in the repository.

### 1. Azure AI Foundry API key (`foundry`)

```bash
export DECISION_PROVIDER=foundry
export FOUNDRY_RESOURCE=my-resource             # https://my-resource.services.ai.azure.com
export FOUNDRY_API_KEY=...                      # sent as api-key header
export DECISION_DEPLOYMENT=Microsoft-Decision-1.1   # your deployment name
```

Request: `POST https://<resource>.services.ai.azure.com/providers/microsoft/v1/systemone`.
Use `FOUNDRY_ENDPOINT` instead of `FOUNDRY_RESOURCE` for a full base URL.

### 2. Custom endpoint (`endpoint`)

```bash
export DECISION_PROVIDER=endpoint
export DECISION_ENDPOINT_URL=https://proxy.example.com/v1/systemone
export DECISION_API_KEY=...
export DECISION_MODEL=Microsoft-Decision-1.1
# optional: default is "Authorization: Bearer <key>"
export DECISION_AUTH_HEADER=api-key   # header name
export DECISION_AUTH_SCHEME=          # empty = raw key
```

Works with an Entra ID token (`DECISION_API_KEY=$(az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv)`) or a proxy such as LiteLLM.

### 3. Azure API Management / AI Gateway (`apim`, unverified)

```bash
export DECISION_PROVIDER=apim
export APIM_GATEWAY_URL=https://my-apim.azure-api.net/foundry
export APIM_SUBSCRIPTION_KEY=...
export DECISION_MODEL=Microsoft-Decision-1.1
# optional
export APIM_KEY_HEADER=Ocp-Apim-Subscription-Key   # or api-key
export APIM_PATH=/providers/microsoft/v1/systemone
```

The API in APIM must forward the `/systemone` operation to the Foundry backend. This path
is not a chat-completions route, so you may need to add the operation by hand. This mode was
tested only against a mock server.

### 4. TypeSafe Jev (`typesafe`, default)

```bash
export DECISION_PROVIDER=typesafe
export TYPESAFE_API_KEY=...
export TYPESAFE_MODEL=jev-latest
```

Check the resolved settings (no secrets printed):

```bash
node ~/.claude/skills/decision-playwright/scripts/dpw.mjs config
```

### Browser options

| Variable | Meaning |
|---|---|
| `DPW_EXECUTABLE_PATH` | Path to a Chrome/Chromium binary |
| `DPW_CHANNEL` | `chrome`, `msedge`, ... (installed browser) |
| `DPW_HEADED=1` | Show the browser window |
| `DPW_MAX_STEPS` | Decision steps per run/resume (default 40) |
| `DPW_SESSION` / `--session` | Session name (default `default`) |
| `DPW_STATE_DIR` | Daemon state folder (default `~/.decision-playwright`) |
| `DECISION_MAX_PAGE_CHARS` | Page text sent to Decision (default 12000) |
| `DECISION_TIMEOUT_MS` | Request timeout (default 30000) |

## Usage

```bash
DPW="node ~/.claude/skills/decision-playwright/scripts/dpw.mjs"
$DPW run "Search for red shoes sorted by price" --url https://shop.example.com
# {"status":"NEEDS_TYPING","target":{"ref":"e3","label":"Query",...}}
$DPW type e3 "red shoes"
$DPW resume
# {"status":"NEEDS_VERIFICATION", ...}
$DPW snapshot
$DPW stop
```

## Test

The test starts a mock System One server and local pages, then runs
`run → NEEDS_TYPING → type → resume → NEEDS_VERIFICATION` for all four providers and
checks URL path, auth header and `model` of each request.

```bash
cd skills/decision-playwright && npm install && cd ../..
node test/run-tests.mjs
```

## Security

- The daemon listens on `127.0.0.1` only and requires a random token stored in a `0600` file.
- HTTP error bodies from providers are never printed.
- Password fields are reported as `sensitive` and their values are masked.

## License

MIT
