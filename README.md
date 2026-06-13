# AI Quota & Usage Tracker

Real-time dashboard that auto-discovers running Antigravity IDE language server processes and displays AI model quota usage across multiple accounts. No API keys required — it talks directly to the local language server.

![Platform](https://img.shields.io/badge/Platform-Antigravity-6366f1)
![status](https://img.shields.io/badge/status-active-success)
![Node](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)
![100% Local](https://img.shields.io/badge/data-100%25_local-22c55e)
![MIT](https://img.shields.io/badge/license-MIT-6366f1)

![screenshot](docs/Antigravity-Quota-Tracker.png)

## How it works

The app scans for running Antigravity language server processes via WMI, extracts the CSRF token and listening port, then queries the `GetUserStatus` gRPC endpoint to pull per-model quota data (remaining fraction, reset time). It caches discovered servers/ports to avoid repeated PowerShell overhead.

## Features

- **Auto-discovery** — detects running Antigravity IDE language servers with zero config
- **Multi-account** — tracks multiple Gmail accounts; manually add accounts that appear when they come online
- **Per-model quotas** — shows remaining percentage, status (Available/Low/Critical/Exhausted), and countdown to reset
- **Account persistence** — known accounts survive server restarts via `data.json`
- **Offline state** — accounts without a running IDE instance are shown collapsed with stale data
- **Plan normalization** — maps API plan names to clean labels (e.g. "Antigravity Starter Quota" → "Starter")
- **Model-available notifications** — green toast alerts when an exhausted model regains quota
- **Account management** — add, edit (name/email), and remove accounts from the UI
- **Mock mode** — `MOCK=true` environment variable serves demo data for testing

## Prerequisites

- Node.js 18+
- Antigravity IDE running (for live data)
- Windows (uses PowerShell/WMI for process discovery)

## Install

```bash
git clone <repo-url>
cd quota-tracker
npm install
```

## Usage

```bash
# Start with live auto-detection
node server.js

# Or use mock data for testing
MOCK=true node server.js
```

Open `http://localhost:3001` in a browser.

The dashboard polls the language server every 30 seconds and refreshes the UI every 10 seconds.

### Environment variables

| Variable        | Default | Description                 |
| --------------- | ------- | --------------------------- |
| `PORT`          | `3001`  | HTTP server port            |
| `POLL_INTERVAL` | `30000` | Polling interval in ms      |
| `MOCK`          | `false` | Serve mock data when `true` |

## API endpoints

| Method   | Path                   | Description                                       |
| -------- | ---------------------- | ------------------------------------------------- |
| `GET`    | `/api/quota`           | Current quota snapshot with live/offline accounts |
| `POST`   | `/api/refresh`         | Force immediate poll                              |
| `GET`    | `/api/accounts`        | List all known accounts                           |
| `POST`   | `/api/accounts`        | Add an account (`{ email }`)                      |
| `PUT`    | `/api/accounts/:email` | Update account name or email                      |
| `DELETE` | `/api/accounts/:email` | Remove an account                                 |
| `GET`    | `/api/notifications`   | Get and clear model-available alerts              |
| `GET`    | `/api/raw-response`    | Raw JSON from last language server query (debug)  |
| `GET`    | `/api/status`          | Poller status and recent errors                   |

## Project structure

```
quota-tracker/
├── server.js          # Express server — API endpoints, polling loop
├── antigravity.js     # Core logic — process discovery, quota fetching, caching, notifications
├── data.json          # Persistent account storage (auto-created)
├── package.json
├── public/
│   └── index.html     # Single-page dashboard UI
└── docs/
    ├── api.ts         # Reference TypeScript implementation
    └── account.json   # Sample API response for reference
```

## Technical notes

- Process discovery uses `Get-CimInstance Win32_Process` with LIKE patterns and pipe-delimited output to avoid JSON truncation of long command lines
- Port discovery falls back to `netstat -ano` if `Get-NetTCPConnection` is unavailable
- Protobuf v3 omits `0.0` float values from JSON — models with a `resetTime` but no `remainingFraction` are inferred as exhausted at 0%
- Plan names are normalized via a lookup table (`PLAN_ALIASES`) to produce clean display labels and CSS class names
