# ea-bridge

**Node.js bridge to Sparx Enterprise Architect via COM — no `winax`, no native Node modules.**

ea-bridge lets plain Node.js scripts use the full Enterprise Architect (EA)
automation API: `Repository`, `Project`, elements, diagrams, SQL queries,
HTML reports, XMI export, and so on. It consists of two parts:

- **`ea-bridge.exe`** — a small .NET Framework console app that talks to EA over COM.
- **`ea-client.js`** — a dependency-free Node.js client that starts the bridge
  and drives it over a line-based JSON protocol on stdio.

Because the COM work happens in a separate process, there is nothing to
compile with `node-gyp`, no dependency on your Node.js version or ABI, and a
crash or hang in EA cannot take your Node process down with it.

## Features

- **Three connection modes**: attach to a running EA, start EA headless
  (`EA.Repository`), or start the full `EA.App`.
- **Works under service accounts**: `spawn` mode uses the same headless
  `EA.Repository` activation as `new ActiveXObject('ea.Repository')`, so it
  runs from Task Scheduler without an interactive desktop.
- **Ownership tracking**: the bridge knows whether it started EA itself. On
  `close()` it only kills EA processes it owns. Your open EA session or a
  long-running EA service process is never terminated by a batch job.
- **Model verification**: after opening a model the bridge checks that the
  loaded model is the one you asked for. If it isn't, it fails instead of
  silently working in the wrong model.
- **Fast against Pro Cloud Server**: batched property reads (`props()`) and SQL
  helpers cut round-trips. Reading six properties in one call was measured at
  8.7× faster than six separate reads.
- **Familiar API**: the same EA object model as winax, with `await` in front of it.

## Editions

The release ships in two editions. They share the same `ea-client.js` and the
same protocol, but are built and installed differently.

| | [Architect](architect/) | [Server](server/) |
|---|---|---|
| Intended for | Desktop use; attaching to the EA you have open | Headless batch jobs and scheduled tasks |
| Typical mode | `attach` | `spawn` |
| Bridge build | x86 (32-bit) | x64 (64-bit) |
| Installs to | `%LOCALAPPDATA%\ea-bridge` (no admin rights) | `C:\Program Files\ea-bridge` (admin; path configurable) |
| Example | [example-attach.js](architect/example-attach.js) | [example-spawn.js](server/example-spawn.js) |
| Docs | [architect/README.md](architect/README.md) | [server/README.md](server/README.md), [server/MIGRATION.md](server/MIGRATION.md) (winax → ea-bridge) |

## Quick start

1. Download the zip for your edition from
   [Releases](https://github.com/jvduuren/ea-bridge/releases) and extract it.
2. Run the installer in PowerShell (the server edition needs an elevated prompt):

   ```powershell
   .\install.ps1
   ```

3. Use it from Node.js. The install location and the typical mode differ per edition.

   **Architect edition**: attach to the EA you have open on your desktop.

   ```js
   const path = require('path');
   const installDir = path.join(process.env.LOCALAPPDATA, 'ea-bridge');
   const { EABridge } = require(path.join(installDir, 'ea-client.js'));

   const ea = new EABridge({
       exePath: path.join(installDir, 'ea-bridge.exe'),
       model:   'C:\\path\\to\\your-model.qea',
       mode:    'attach',
   });

   try {
       await ea.start();
       const rows = await ea.sqlRows('SELECT Object_ID, Name FROM t_object LIMIT 10');
       console.log(rows);          // [{ Object_ID: 1, Name: '...' }, ...]
   } finally {
       await ea.close();           // releases COM refs; your EA keeps running
   }
   ```

   **Server edition**: headless batch job, e.g. from Task Scheduler under a service account.

   ```js
   const path = require('path');
   const installDir = 'C:\\Program Files\\ea-bridge';   // or the path you passed to install.ps1 -InstallPath
   const { EABridge } = require(path.join(installDir, 'ea-client.js'));

   const ea = new EABridge({
       exePath: path.join(installDir, 'ea-bridge.exe'),
       model:   'C:\\path\\to\\your-model.qea',
       mode:    'spawn',
       callTimeoutMs: 6 * 3600 * 1000,   // long jobs such as RunHTMLReport (default is 60 s)
   });

   try {
       await ea.start();
       const n = await ea.sqlValue('SELECT COUNT(*) AS n FROM t_object');
       console.log(`${n} objects`);
   } finally {
       await ea.close();           // only kills EA if the bridge started it
   }
   ```

## Modes

| Mode | Activation | Use when |
|---|---|---|
| `attach` | Connects to a running EA via the Running Object Table | EA is already open with your model (desktop) |
| `spawn` | Headless `EA.Repository` | Scripts and server jobs, including under service accounts |
| `spawn-app` | Full `EA.App` with GUI subsystem | Only if you need `EA.App`-specific APIs; needs an interactive desktop |

In `spawn` mode `ea.app` is not available. Nearly everything is reachable
through `ea.repo`, including `ea.repo.GetProjectInterface()` for reports and
exports.

## API at a glance

```js
const d    = await ea.repo.GetDiagramByID(42);        // call a method
const name = await d.Name;                            // read a property
const info = await d.props('Name', 'Type', 'Stereotype');  // several properties, one round-trip

await ea.set(element.__handle, 'Name', 'New name');   // write a property
await element.Update();

const r    = await ea.sql('SELECT ...');               // raw EA XML result in r.xml
const rows = await ea.sqlRows('SELECT ...');           // parsed into plain objects
const n    = await ea.sqlValue('SELECT COUNT(*) AS n FROM t_object');  // single value

await element.release();                              // free a COM handle in long loops
```

After `start()`, `ea.ownership` (`'owned'` or `'none'`), `ea.eaPid`,
`ea.bridgePid`, `ea.actualMode` and `ea.attachedModel` describe what the
bridge connected to.

## How it works

```
Your Node.js script
      │  require
      ▼
ea-client.js        JSON lines over stdin/stdout
      │  child process
      ▼
ea-bridge.exe       .NET Framework COM client
      │  COM
      ▼
EA.Repository / EA.App   (Sparx Enterprise Architect)
```

The bridge is a long-lived process per `EABridge` instance: start it once,
make many calls, close it at the end. Protocol overhead is about 1 ms per call
on top of the work EA does.

## Requirements

- Windows 10/11 or Windows Server
- .NET Framework 4.8
- Sparx Enterprise Architect
- Node.js 16 or newer

## Repository layout

```
architect/   Architect edition: bridge (x86), client, installer, example, README
server/      Server edition: bridge (x64), client, installer, example, README, MIGRATION
```

Each folder holds exactly what goes into that edition's release zip, so
`install.ps1` can also be run directly from a clone.

The repository contains the compiled bridge (`ea-bridge.exe`); its C# source
is not included.

## Third-party components

ea-bridge ships `Newtonsoft.Json.dll` (Json.NET 13.0.4, MIT License). See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Disclaimer

This project is not affiliated with or endorsed by Sparx Systems.
Enterprise Architect is a trademark of Sparx Systems Pty Ltd.
