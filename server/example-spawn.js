// example-spawn.js
// Typical server batch job pattern.
// Bridge spawns its own EA via headless EA.Repository activation,
// runs the work, cleans up at the end (safely).

const { EABridge } = require('C:\\Program Files\\ea-bridge\\ea-client');

(async () => {
    const ea = new EABridge({
        exePath: 'C:\\Program Files\\ea-bridge\\ea-bridge.exe',

        // Pro-Cloud link file (encrypted, contains credentials)
        model: 'C:\\ea-models\\production.qea',

        // Headless mode - works under non-interactive service accounts.
        // Equivalent to winax: new ActiveXObject('ea.Repository')
        mode: 'spawn',

        // Long jobs need long timeouts (default is 60s).
        callTimeoutMs: 6 * 3600 * 1000,
    });

    try {
        console.log(`[${new Date().toISOString()}] Starting bridge...`);
        await ea.start();
        console.log(`[${new Date().toISOString()}] Ready.`);
        console.log(`  Bridge PID: ${ea.bridgePid}`);
        console.log(`  EA PID:     ${ea.eaPid || '(reused, not owned)'}`);
        console.log(`  Ownership:  ${ea.ownership}`);
        console.log(`  Mode:       ${ea.actualMode}`);
        console.log(`  hasApp:     ${ea.hasApp}`);
        console.log(`  Model:      ${ea.attachedModel}`);
        console.log();

        // ---------- YOUR JOB GOES HERE ----------

        // Example 1: Bulk read via SQL
        const t0 = Date.now();
        const r = await ea.sql(`
            SELECT COUNT(*) AS n
            FROM t_object
            WHERE Object_Type = 'Component'
        `);
        const count = r.xml.match(/<n>(\d+)<\/n>/)?.[1];
        console.log(`SQL: ${count} components (${Date.now() - t0} ms)`);

        // Example 2: Project interface (via Repository, works in all modes)
        /*
        const proj = await ea.repo.GetProjectInterface();
        const success = await proj.RunHTMLReport(
            '{package-guid}',
            'C:\\output\\html',
            '<default>',
            '.html',
            ''
        );
        console.log('Report success:', success);
        */

        // Example 3: Element-level operations
        /*
        const element = await ea.repo.GetElementByGuid('{element-guid}');
        const info = await element.props('Name', 'Type', 'Notes');
        console.log('Element info:', info);
        await element.release();
        */

        // ----------------------------------------

        console.log(`[${new Date().toISOString()}] Job complete.`);

    } catch (err) {
        console.error(`[${new Date().toISOString()}] FATAL:`, err.message);
        process.exitCode = 1;
    } finally {
        // ALWAYS clean up. Safe by design - the bridge only kills EA
        // if it actually spawned it (ownership === 'owned').
        await ea.close();
        console.log(`[${new Date().toISOString()}] Cleanup done.`);
    }
})();
