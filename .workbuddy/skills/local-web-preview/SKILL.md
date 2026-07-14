---
name: local-web-preview
description: "Serve a local HTML file or static site over HTTP and preview it in a browser. Use when an agent must open, preview, screenshot, or E2E-test a local web artifact (single HTML, static site, generated UI) through a browser or navigate tool."
license: Apache-2.0
agent_created: true
---

# Local Web Preview

## Purpose

Preview a local web artifact (single HTML file, static site, generated UI) in a
headless browser by serving it over HTTP. This skill exists because the naive
approach — running `python -m http.server` as a normal foreground command and
then navigating to it — fails in three distinct, easy-to-repeat ways. Follow
this skill to avoid all three.

## When To Use

- An agent generated or edited an `index.html` / static site and must "open" or
  "preview" it.
- A task requires a browser/navigate tool to load a local page (Playwright,
  browser automation, screenshot, E2E check).
- Any flow that needs a URL like `http://localhost:PORT/` reachable from a
  browser running on the same machine.

Do **not** use this for remote URLs or for files that can be loaded directly by
a non-browser viewer.

## Decision Tree

```
Task needs to preview a local web artifact?
  ├─ Yes → Is a server already running on the target port?
  │         ├─ Yes → Poll 127.0.0.1:PORT until 200, then navigate
  │         └─ No  → Start the server detached (Step 1), poll (Step 2), navigate (Step 3)
  └─ No  → This skill does not apply; use a normal file viewer
```

## The Three Pitfalls (what NOT to do)

1. **Foreground-blocking the server.** `python -m http.server` is a long-running,
   non-exiting process. Running it as a normal "execute and wait for exit"
   command makes the tool wait until its timeout, then **kill the process** —
   which releases the port. The subsequent browser navigate then hits
   `ERR_CONNECTION_REFUSED`. Always start the server detached/backgrounded.

2. **`cd /d` in a bash shell.** `cd /d "D:\path"` is Windows `cmd.exe` syntax. In
   bash / git-bash it errors with `cd: too many arguments`, so the server never
   starts. In bash, use `cd "/path"` (forward or backward slashes, no `/d`).

3. **Falling back to `file://`.** When the HTTP server is unreachable, do **not**
   navigate to `file:///D:/.../index.html`. Playwright and most headless
   browsers block the `file:` protocol by default (security policy). The correct
   fallback is to fix the server, or deploy the static site (e.g.
   `cloudstudio_deploy`), never to switch protocols.

## Correct Workflow

### Step 1 — Start the server detached (do not wait for exit)

Use the bundled helper, which backgrounds the server, detaches it so it
survives the launching shell, and polls until ready:

```bash
bash "<skill_dir>/scripts/serve_and_poll.sh" "<SITE_DIR>" <PORT> [PYTHON_EXEC]
```

Example:

```bash
bash "$HOME/.workbuddy/skills/local-web-preview/scripts/serve_and_poll.sh" \
  "/d/游戏产物/anime-strategy-game" 3000
```

The script prints `READY http://127.0.0.1:PORT/` on success and exits `0`,
leaving the server running. On failure it prints the server log and exits `2`.

Equivalent manual form (if not using the script):

```bash
cd "/path/to/site"
nohup python -m http.server 3000 --bind 127.0.0.1 >/tmp/srv.log 2>&1 &
disown
```

### Step 2 — Poll until ready (never navigate blind)

Confirm reachability before opening the browser. Use `127.0.0.1`, not
`localhost`, to avoid IPv6 (`::1`) resolution surprises:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/
# expect: 200
```

The bundled script already does this; if running manually, loop with a short
`sleep` until `200` or a bounded retry count.

### Step 3 — Navigate

Point the browser tool at the HTTP URL:

```
navigate -> http://127.0.0.1:3000/
```

### Step 4 — Cleanup (when done)

Kill the server when the preview is no longer needed to free the port:

```bash
# git-bash / bash
fuser -k 3000/tcp 2>/dev/null || true
# or find the pid from /tmp/srv.log / ps and `kill <pid>`
```

## Best Practices

- **Treat `serve_and_poll.sh` as a black box.** Run it directly; do not read its
  source into context unless debugging. Its job is only to start + poll.
- **Use `127.0.0.1`, not `localhost`.** Avoids IPv6 `::1` resolution surprises in
  sandboxed or dual-stack environments.
- **Always clean up.** A detached server keeps the port occupied after the task.
  Kill it (Step 4) when the preview is done.
- **Same-sandbox rule.** Some execution sandboxes isolate the network between
  separate command invocations. The bundled script starts the server and polls
  it in the *same* command, so it works even under such isolation. On a normal
  host, localhost is shared across calls.

## Shell & Environment Notes

- **bash only.** The helper and commands assume a bash/git-bash shell. `cmd.exe`
  does not understand `&`, `nohup`, or `disown`.
- **Python location.** If plain `python`/`python3` is not on PATH, pass the
  interpreter as the 3rd argument, or set `PYTHON_EXEC`:
  `PYTHON_EXEC="/c/Users/MECHREVO/.workbuddy/binaries/python/versions/3.13.12/python.exe"`.
- **Buffer caveat.** `python -m http.server` writes its startup line to stderr.
  Under a piped command it can be block-buffered and invisible until flushed;
  redirect to a log file (`>/tmp/srv.log 2>&1`) to inspect it reliably.
- **Port in use.** If the chosen port is taken, either kill the stale listener
  or pick another port and update the navigate URL accordingly.

## Reference Files

- **scripts/serve_and_poll.sh** — Deterministic helper that performs Steps 1–2 in
  one call: changes into the target directory (bash path), launches
  `python -m http.server` detached on `127.0.0.1:<PORT>`, polls with `curl`
  (falling back to a Python socket check), and prints `READY <url>` on success.
  Pass an explicit Python interpreter as the optional 3rd argument when `python`
  is not on PATH.
