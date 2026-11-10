# Device farm spikes (2026-11-10)

Throwaway trials for sharing always-on Macs with physical phones across the team.
Write-up and decisions: `.redline/device-farm.html`.

- `adb-gate.mjs` — adb smart-socket proxy in front of the host adb server. Laptops set
  `ADB_SERVER_SOCKET=tcp:<host>:<port>`; only leased serials pass, `adb devices` is filtered,
  host-wide commands are refused. Checks the first request frame only (not production-safe).
- `argent-gate.mjs` — HTTP gateway in front of an Argent tool-server. Each `/tools/:name` call's
  device argument is checked against live holders in Commando's device-lock API; `list-devices`
  is filtered; host-wide tools are refused. Laptops keep stock `argent mcp` with
  `ARGENT_TOOLS_URL` / `ARGENT_AUTH_TOKEN` pointed at the gateway.
- `tcp-count.mjs` — byte-counting TCP pipe used to measure what crosses the "network".
