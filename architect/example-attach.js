// example-attach.js
// Demonstrates attaching to a running EA instance on an architect's desktop.
// Prerequisite: EA is running with a model open.

const path = require('path');
const installDir = path.join(process.env.LOCALAPPDATA, 'ea-bridge');
const { EABridge } = require(path.join(installDir, 'ea-client.js'));

(async () => {
    const modelPath = process.argv[2] || 'C:\\path\\to\\your-model.qea';

    const ea = new EABridge({
        exePath: path.join(installDir, 'ea-bridge.exe'),
        model: modelPath,
        mode: 'attach',
        waitSeconds: 5,
    });

    console.log('Attaching to running EA...');
    try {
        await ea.start();
    } catch (err) {
        console.error('Could not attach:', err.message);
        if (err.candidatesFound) {
            console.error('EA instances found in the ROT:');
            for (const c of err.candidatesFound) {
                console.error('  -', c.file || '(no model)');
            }
        }
        process.exit(1);
    }
    console.log(`Attached. Bridge PID=${ea.bridgePid}, ownership=${ea.ownership}`);
    console.log(`Model=${ea.attachedModel}`);

    // Bulk read via SQL
    const result = await ea.sql('SELECT Package_ID, Name FROM t_package WHERE Parent_ID = 0');
    console.log('\nRoot packages query result:');
    console.log(result.xml.substring(0, 500));

    // Read a specific diagram if it exists
    try {
        const diagram = await ea.repo.GetDiagramByID(4709);
        const info = await diagram.props(
            'DiagramID', 'Name', 'Type', 'DiagramObjects.Count'
        );
        console.log('\nDiagram 4709:', info);
        await diagram.release();
    } catch (e) {
        console.log('\n(Diagram 4709 not in your model, skipping)');
    }

    // In attach mode, ownership is 'none' - close() only releases our COM ref.
    // The EA instance stays running.
    await ea.close();
    console.log('\nDone. EA is still running for you to use.');
})().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
