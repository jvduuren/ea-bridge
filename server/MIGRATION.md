# Migration Guide: winax → ea-bridge

For server-side scripts running under a dedicated service account,
the migration is essentially mechanical — the bridge's `spawn` mode uses
the **same COM activation** as existing winax scripts.

## The key insight

Existing winax server scripts typically use:

```javascript
const winax = require('winax');
this.repo = new ActiveXObject("ea.Repository");
this.proj = this.repo.GetProjectInterface();
```

This activates `EA.Repository` directly — a headless COM activation
that works under service users without an interactive desktop.

The bridge's `mode: 'spawn'` does exactly the same:

```csharp
// Inside ea-bridge.exe:
repo = new EA.Repository();
```

Same ProgID, same behavior, same compatibility with service users.

## Setup mapping

### Before (winax)

```js
const winax = require('winax');
const repo = new winax.Object('EA.Repository');
repo.OpenFile('C:\\ea-models\\production.qea');
const proj = repo.GetProjectInterface();
```

### After (ea-bridge)

```js
const { EABridge } = require('C:\\Program Files\\ea-bridge\\ea-client');

const ea = new EABridge({
    exePath: 'C:\\Program Files\\ea-bridge\\ea-bridge.exe',
    model: 'C:\\ea-models\\production.qea',
    mode: 'spawn',
});
await ea.start();

// ea.repo plays the role of the old `repo`
const proj = await ea.repo.GetProjectInterface();
```

## API calls — side-by-side

The EA API calls are identical, just with `await` and via `ea.repo`.

| Operation | winax | ea-bridge |
|---|---|---|
| Get diagram by ID | `repo.GetDiagramByID(4709)` | `await ea.repo.GetDiagramByID(4709)` |
| Read property | `diagram.Name` | `await diagram.Name` |
| Set property | `element.Name = 'X'` | `await ea.set(element.__handle, 'Name', 'X')` |
| Call method | `element.Update()` | `await element.Update()` |
| SQL query | `repo.SQLQuery('...')` | `(await ea.sql('...')).xml` |
| Project interface | `repo.GetProjectInterface()` | `await ea.repo.GetProjectInterface()` |
| HTML report | `proj.RunHTMLReport(...)` | `await proj.RunHTMLReport(...)` |
| XMI export | `proj.ExportPackageXMI(...)` | `await proj.ExportPackageXMI(...)` |

## Complete example — HTML export job

### Before (winax)

```js
const winax = require('winax');

const repo = new winax.Object('EA.Repository');
repo.OpenFile('C:\\ea-models\\production.qea');

const proj = repo.GetProjectInterface();
proj.RunHTMLReport(packageGuid, 'C:\\out\\html', '<default>', '.html', '');

repo.CloseFile();
// (winax doesn't have a clean shutdown - EA may linger)
```

### After (ea-bridge)

```js
const { EABridge } = require('C:\\Program Files\\ea-bridge\\ea-client');

const ea = new EABridge({
    exePath: 'C:\\Program Files\\ea-bridge\\ea-bridge.exe',
    model: 'C:\\ea-models\\production.qea',
    mode: 'spawn',
    callTimeoutMs: 6 * 3600 * 1000,
});

try {
    await ea.start();

    const proj = await ea.repo.GetProjectInterface();
    await proj.RunHTMLReport(
        packageGuid, 'C:\\out\\html', '<default>', '.html', ''
    );

} finally {
    await ea.close();   // safe cleanup with ownership tracking
}
```

Notice the `finally` block — guarantees cleanup runs even on error.
The bridge's ownership tracking ensures it only kills EA instances it
spawned itself; existing REST API EAs are safe.

## Important differences

### 1. Calls are async

```js
// Old:
const name = diagram.Name;

// New:
const name = await diagram.Name;
```

### 2. Setters need explicit syntax

JavaScript Proxies can't model async setters cleanly:

```js
// Old:
element.Name = 'New Name';

// New:
await ea.set(element.__handle, 'Name', 'New Name');
await element.Update();
```

### 3. Batch reads for Cloud performance

Each property is a Cloud roundtrip. Instead of:

```js
// 6 roundtrips:
const id    = await diagram.DiagramID;
const name  = await diagram.Name;
// ...
```

Use `props()` — 1 roundtrip:

```js
const info = await diagram.props(
    'DiagramID', 'Name', 'Type', 'Stereotype', 'PackageID'
);
```

Measured improvement against a large Pro-Cloud model: **8.7×** faster.

### 4. Resource cleanup in long loops

```js
for (const id of largeList) {
    const element = await ea.repo.GetElementByID(id);
    // ... work ...
    await element.release();   // important in loops
}
```

At job end, `ea.close()` releases everything.

### 5. Long-running jobs need explicit timeouts

```js
const ea = new EABridge({
    // ...
    callTimeoutMs: 6 * 3600 * 1000,   // 6 hours
});
```

### 6. No `ea.app` in spawn mode

Since we activate `EA.Repository` directly (not `EA.App`), the bridge has
no `app` object. Accessing `ea.app` throws.

All Application-level features are accessible via Repository:

```js
const proj = await ea.repo.GetProjectInterface();   // works
// proj has RunHTMLReport, ExportPackageXMI, etc.
```

### 7. New: ownership tracking

The bridge tracks whether it owns the EA it talks to:

```js
await ea.start();
console.log(ea.ownership);   // 'owned' or 'none'
console.log(ea.eaPid);       // PID if 'owned', null if 'none'
```

| `ownership` | When | `close()` behavior |
|---|---|---|
| `'owned'` | Bridge spawned a fresh EA process | Hard-kills it |
| `'none'`  | COM reused an existing EA, or attach mode | Only releases COM refs |

This protects long-running EA processes (REST APIs, GUI sessions) from
being accidentally terminated by other scripts.

### 8. New: model verification

After `OpenFile`, the bridge verifies that the actual loaded model matches
what was requested. If COM reused an EA that already had a different model
open and refused to switch, the bridge errors out instead of silently
working in the wrong model.

## Performance tips for Pro-Cloud

1. SQL for bulk reads
2. `props()` for multi-property reads
3. Avoid `for (...) await X` patterns
4. Release handles in long loops
5. Warmup is automatic (bridge does a `ping()` after start)
