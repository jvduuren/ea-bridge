# ea-bridge for Architects — v1.3.2

Node.js bridge to Enterprise Architect via COM, without winax.

## Installation

```powershell
.\install.ps1
```

Files are copied to `%LOCALAPPDATA%\ea-bridge\`. No admin rights required.

Optional: add to user PATH:

```powershell
.\install.ps1 -AddToPath
```

Uninstall:

```powershell
.\install.ps1 -Uninstall
```

## Three modes

| Mode | Activation | When to use |
|---|---|---|
| `attach` | Connect to a running EA.App via the ROT | EA is already open with your model — typical desktop case |
| `spawn` | Direct `EA.Repository` activation (headless) | Pure scripting without keeping EA open |
| `spawn-app` | Full `new EA.App()` with GUI subsystem | Rare: only when you need EA.App-specific APIs |

For interactive desktop work, `attach` is what you want. For batch scripts
that don't need EA visible, `spawn` is the simpler choice.

## Usage

### Attach to your open EA

```js
const path = require('path');
const installDir = path.join(process.env.LOCALAPPDATA, 'ea-bridge');
const { EABridge } = require(path.join(installDir, 'ea-client.js'));

const ea = new EABridge({
    exePath: path.join(installDir, 'ea-bridge.exe'),
    model: 'C:\\path\\to\\your-model.qea',
    mode: 'attach',
});

await ea.start();
const diagram = await ea.repo.GetDiagramByID(4709);
const name = await diagram.Name;
console.log('Diagram:', name);
await ea.close();   // EA stays running - it's yours
```

### Headless one-off (spawn)

```js
const ea = new EABridge({
    exePath: path.join(installDir, 'ea-bridge.exe'),
    model: 'C:\\path\\to\\your-model.qea',
    mode: 'spawn',
});

try {
    await ea.start();
    // ... work ...
} finally {
    await ea.close();   // only kills EA if bridge spawned it (ownership)
}
```

## Ownership tracking — safety by design

The bridge tracks whether it actually owns the EA instance it talks to.
You can see this in `ea.ownership` after `start()`:

| `ea.ownership` | Meaning | Behavior on close |
|---|---|---|
| `'owned'`  | Bridge spawned a new EA process | Hard-kills it on close |
| `'none'`   | Bridge attached to / reused an existing EA | Just releases COM refs, EA keeps running |

**Why this matters:** if you have EA already open on your desktop and someone
runs a `spawn`-mode script, COM might internally reuse your existing EA
instead of spawning a new one. The bridge detects this and tags ownership
as `'none'` — your EA will NOT be killed when the script exits.

Same principle on servers: your long-running REST API EA processes are safe
from being accidentally terminated by a batch job that uses spawn mode.

## Quick reference

```js
// Properties (await):
const name = await element.Name;

// Methods:
const d = await ea.repo.GetDiagramByID(4709);

// Project interface (works in all modes via Repository):
const proj = await ea.repo.GetProjectInterface();
await proj.RunHTMLReport('pkg-guid', 'C:\\out', '<default>', '.html', '');

// Set a property:
await ea.set(element.__handle, 'Name', 'New name');
await element.Update();

// Batch-read several properties (recommended for Cloud models):
const info = await element.props('Name', 'Type', 'Stereotype');

// SQL:
const r = await ea.sql('SELECT Object_ID, Name FROM t_object LIMIT 10');

// Release a handle when done in long loops:
await element.release();
```

## Important: ea.app availability

In `spawn` mode (headless), the `ea.app` proxy is NOT available because no
EA.App was created. Accessing `ea.app` throws an error.

**99% of EA APIs work fine via `ea.repo`** including `ea.repo.GetProjectInterface()`
for reports/exports. Only use `attach` or `spawn-app` if you specifically need
EA.App-only features.

## Requirements

- Windows 10 / 11
- .NET Framework 4.8 (pre-installed on modern Windows)
- Sparx Enterprise Architect (32-bit; this is the x86 build)
- Node.js 16 or newer

## Architecture

```
Your Node script
      ↓ (require)
ea-client.js  (stdio JSON protocol)
      ↓ (spawn child process)
ea-bridge.exe  (.NET COM client)
      ↓ (COM)
EA.Repository or EA.App  (Sparx Enterprise Architect)
```

The bridge is a long-lived process per `EABridge` instance: spawn once, do
many operations, close at the end. Each call has ~1ms protocol overhead on
top of the actual EA work.

## Performance tips for Pro-Cloud models

1. Use SQL for bulk reads
2. Use `obj.props(...)` to batch multiple property reads
3. Avoid `for (...) await diagram.X` patterns - each await is a roundtrip
4. Release handles in long loops to avoid memory growth

## Troubleshooting

**Attach: "No running EA instance found with the requested model open"**
- EA is not running, or has a different model open
- Path comparison is case-insensitive but exact otherwise

**Spawn hangs in service-user context**
- You're using `spawn-app`. Switch to `spawn` (headless Repository instead
  of EA.App). The full EA.App activation needs an interactive desktop.

**Bridge exits immediately with no output**
- Usually .NET Framework. Verify .NET 4.8 is installed:
  ```powershell
  Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' | Select Release
  ```
  Release should be >= 528040.

**"Model mismatch after OpenFile"**
- COM reused an EA that already had a different model loaded and refused
  to switch. Close the other EA first, or use a fresh `spawn` invocation
  when no other EAs are running.

**`ea.app` throws "not available"**
- Expected in `spawn` mode. Use `ea.repo` and
  `ea.repo.GetProjectInterface()` for Application-level features.
