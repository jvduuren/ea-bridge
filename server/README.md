# ea-bridge for Server — v1.3.2

64-bit Node.js bridge to Enterprise Architect via COM, without winax.

For headless server jobs running under a dedicated service account.
The bridge directly activates `EA.Repository` (no GUI subsystem), matching
the proven winax pattern of `new ActiveXObject('ea.Repository')`.

## Installation

Open PowerShell **as Administrator**:

```powershell
.\install.ps1
```

Files are copied to `C:\Program Files\ea-bridge\`.

Custom path:

```powershell
.\install.ps1 -InstallPath 'D:\apps\ea-bridge'
```

Uninstall:

```powershell
.\install.ps1 -Uninstall
```

## The three modes — pick `spawn` for servers

| Mode | What it activates | Works under service user? |
|---|---|---|
| `attach` | Connect to existing EA.App via ROT | Only if EA was started in the same session |
| `spawn` | Headless `EA.Repository` (no GUI subsystem) | **YES** — recommended |
| `spawn-app` | Full `EA.App` with GUI subsystem | **No** — needs interactive desktop |

### Why `spawn` and not `spawn-app`?

When EA is activated as `EA.App`, it tries to initialize the full
Application/GUI subsystem. In a service-user context without an interactive
desktop, this initialization **hangs forever** — the bridge will appear to
freeze.

`EA.Repository` is the lightweight COM activation that just gives you the
data layer. This is what already-working winax-based scripts use:

```javascript
// Existing winax pattern (works under service users):
this.repo = new ActiveXObject("ea.Repository");
this.proj = this.repo.GetProjectInterface();
```

The bridge's `spawn` mode does exactly this — same COM ProgID, same outcome.

## Ownership safety

The bridge tracks whether it actually owns the EA instance:

| `ownership` | Meaning | Behavior on close |
|---|---|---|
| `'owned'` | Bridge spawned a new EA process | Hard-kills it on close |
| `'none'`  | Bridge attached or COM reused an existing EA | Just releases COM refs |

This matters for your server: if you have long-running EA processes (for
example a REST API that keeps EA open), a batch job that uses `spawn` mode will
NOT kill them. Either the bridge spawns its own fresh EA process (which it
will then own and kill), or — if COM reuses an existing EA — it knows it
doesn't own it and leaves it alone.

This is the safety property that lets you run multiple EA-using workloads on
the same server without them stepping on each other.

You can see the ownership state right in the ready signal:

```json
{
  "ok": true,
  "ready": true,
  "mode": "spawn",
  "ownership": "owned",
  "eaPid": 12876,
  ...
}
```

## Model verification

After opening the model file, the bridge verifies that the actual loaded
model matches what was requested. This catches the rare case where COM
reuses an EA that already had a different model open and refused to switch.

If the verification fails, the bridge errors out cleanly instead of
silently working in the wrong model.

## Usage in Node batch jobs

```js
const { EABridge } = require('C:\\Program Files\\ea-bridge\\ea-client');

const ea = new EABridge({
    exePath: 'C:\\Program Files\\ea-bridge\\ea-bridge.exe',
    model:   'C:\\ea-models\\production.qea',
    mode:    'spawn',
    callTimeoutMs: 6 * 3600 * 1000,
});

try {
    await ea.start();

    console.log(`Ownership: ${ea.ownership}`);  // 'owned' or 'none'
    console.log(`EA PID:    ${ea.eaPid}`);      // null if ownership=none

    const proj = await ea.repo.GetProjectInterface();
    await proj.RunHTMLReport(
        'pkg-guid', 'C:\\output\\html', '<default>', '.html', ''
    );

    const elements = await ea.sql(
        'SELECT Object_ID, Name FROM t_object LIMIT 10'
    );
    console.log(elements.xml);

} finally {
    await ea.close();  // safe: only kills EA if ownership === 'owned'
}
```

`ea.app` is NOT available in `spawn` mode (no Application was created).
Access throws a clear error. Everything you need is on `ea.repo`.

See `example-spawn.js` for a complete example and `MIGRATION.md` for the
winax → ea-bridge mapping.

## Scheduled Tasks

For daily batch jobs under a service user:

1. Task Scheduler → Create Task
2. **General:**
   - Name: `EA Bridge Job - production`
   - Run as: your service account (e.g. `svc-ea`)
   - Run whether user is logged on or not
3. **Triggers:** daily at desired time
4. **Actions:**
   - Program: `node.exe`
   - Arguments: `C:\jobs\your-job.js`
   - Start in: `C:\jobs`
5. Save and provide the service user's password

## Performance against Pro-Cloud

Each EA API call against a Pro-Cloud model is an HTTPS round-trip to the
Pro-Cloud Server. Best practices:

1. **SQL for bulk reads** — one query beats many GetByID calls
2. **`obj.props(...)`** — multiple properties in one bridge call
3. **Generous timeouts** — long ops like `RunHTMLReport` can take hours

Real measurement against a large Pro-Cloud model (~60,000 objects, MySQL backend):
- 6 single property reads: ~26 ms
- Same 6 via `props()`:    ~3 ms
- **8.7× speedup**

## Architecture

```
Scheduled Task ──→ node.exe job.js
                        ↓
                  ea-client.js  (stdio JSON)
                        ↓
                  ea-bridge.exe  (.NET COM client, 64-bit)
                        ↓
                  new EA.Repository()  (headless COM activation)
                        ↓
                  EA.exe  (Sparx EA, no GUI subsystem)
                        ↓ HTTPS
                  Pro-Cloud Server
                        ↓
                  MySQL backend
```

## Troubleshooting

**Bridge hangs at `start()` under service user**
- You're using `mode: 'spawn-app'`. Switch to `mode: 'spawn'`.

**"Model mismatch after OpenFile"**
- COM reused an EA that had a different model loaded.
- Solution: arrange your job pipeline so each job spawns its own fresh EA.
- Or: catch this specific error and retry (eventually COM may spawn a new one).

**`ea.app` throws "not available"**
- Expected in `spawn` mode. Use `ea.repo` and
  `ea.repo.GetProjectInterface()` for Application-level features.

**Calls hang for long times**
- Check Pro-Cloud server availability
- Increase `callTimeoutMs` for legitimately slow operations
- Verify SQL syntax: MySQL needs `AS` for function results

## SQL Dialect (MySQL via Pro-Cloud)

| What you want | Syntax |
|---|---|
| Limit rows | `LIMIT n` (not `TOP n`) |
| String concat | `CONCAT(a, b)` |
| Now() | `NOW()`, `CURDATE()` |
| NULL coalesce | `IFNULL(x, y)` or `COALESCE` |
| Aliases for functions | **Required**: `SELECT COUNT(*) AS n FROM ...` |
| EA wildcards | `#WC#` translates to `%` automatically |
