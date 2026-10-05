// ea-client.js (v1.3.0)
// Generic EA bridge client with three modes, ownership tracking, and SQL helpers.

const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const previewMap = new WeakMap();

const VALID_MODES = ['attach', 'spawn', 'spawn-app'];

class EABridge {
    constructor(opts) {
        if (!opts || !opts.exePath) throw new Error('exePath is required');
        if (!opts.model)            throw new Error('model is required');

        this.exePath = opts.exePath;
        this.model = opts.model;
        this.mode = opts.mode || 'spawn';
        this.waitSeconds = opts.waitSeconds ?? 0;
        this.callTimeoutMs = opts.callTimeoutMs ?? 60000;

        if (!VALID_MODES.includes(this.mode)) {
            throw new Error(
                `Invalid mode '${this.mode}'. Use one of: ${VALID_MODES.join(', ')}`
            );
        }

        this.proc = null;
        this.rl = null;
        this.queue = [];
        this.readyPromise = null;
        this.exitPromise = null;
        this.closed = false;
        this.attachedModel = null;
        this.bridgePid = null;
        this.eaPid = null;
        this.actualMode = null;
        this.ownership = null;
        this.hasApp = false;

        this._repoProxy = null;
        this._appProxy = null;
    }

    start() {
        if (this.proc) return this.readyPromise;

        const args = ['--model', this.model, '--mode', this.mode];
        if (this.waitSeconds > 0) args.push('--wait', String(this.waitSeconds));

        this.proc = spawn(this.exePath, args, { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
        this.rl = readline.createInterface({ input: this.proc.stdout });

        this.exitPromise = new Promise(resolve => {
            this.proc.once('exit', code => {
                this.closed = true;
                resolve(code);
                while (this.queue.length) {
                    const r = this.queue.shift();
                    clearTimeout(r.timer);
                    r.reject(new Error(`Bridge exited with code ${code}`));
                }
            });
        });

        this.readyPromise = new Promise((resolve, reject) => {
            this.rl.once('line', line => {
                let msg;
                try { msg = JSON.parse(line); }
                catch (e) { return reject(new Error('Bad ready message: ' + line)); }
                if (!msg.ok) {
                    const err = new Error(msg.error || 'Bridge failed to start');
                    Object.assign(err, msg);
                    return reject(err);
                }
                this.attachedModel = msg.file || '';
                this.bridgePid = msg.pid || null;
                this.eaPid = msg.eaPid || null;
                this.actualMode = msg.mode || this.mode;
                this.ownership = msg.ownership || null;
                this.hasApp = !!msg.hasApp;
                this.rl.on('line', l => this._onLine(l));
                resolve();
            });
            this.proc.on('error', reject);
            this.proc.stderr.on('data', chunk => {
                process.stderr.write(`[ea-bridge | ${path.basename(this.model)}] ` + chunk.toString());
            });
        });

        return this.readyPromise.then(() => this._warmup());
    }

    async _warmup() {
        try { await this.ping(); } catch (_) { }
        return this;
    }

    async close(timeoutMs = 8000) {
        if (this.closed || !this.proc) return;
        try { this.proc.stdin.write(JSON.stringify({ cmd: 'exit' }) + '\n'); } catch (_) {}
        const timeout = new Promise(r => setTimeout(r, timeoutMs, 'timeout'));
        const result = await Promise.race([this.exitPromise, timeout]);
        if (result === 'timeout') {
            try { this.proc.kill('SIGKILL'); } catch (_) {}
            if (this.ownership === 'owned' && this.eaPid) {
                try { process.kill(this.eaPid, 'SIGKILL'); } catch (_) {}
            }
            await Promise.race([this.exitPromise, new Promise(r => setTimeout(r, 2000))]);
        }
        try { this.rl.close(); } catch (_) {}
        try { this.proc.stdout.destroy(); } catch (_) {}
        try { this.proc.stderr.destroy(); } catch (_) {}
        try { this.proc.stdin.destroy(); } catch (_) {}
        this.closed = true;
    }

    _onLine(line) {
        if (!line.trim()) return;
        let msg;
        try { msg = JSON.parse(line); }
        catch (e) { process.stderr.write('[ea-bridge] Bad JSON: ' + line + '\n'); return; }
        if (msg.exiting) return;

        const resolver = this.queue.shift();
        if (!resolver) {
            process.stderr.write('[ea-bridge] Unmatched line: ' + line + '\n');
            return;
        }
        clearTimeout(resolver.timer);
        if (msg.ok) resolver.resolve(msg);
        else {
            const err = new Error(msg.error || 'Bridge error');
            Object.assign(err, msg);
            resolver.reject(err);
        }
    }

    call(cmd, args = {}) {
        if (this.closed) return Promise.reject(new Error('Bridge is closed'));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this.queue.findIndex(r => r.timer === timer);
                if (idx >= 0) this.queue.splice(idx, 1);
                reject(new Error(`Bridge call timed out after ${this.callTimeoutMs} ms: ${cmd}`));
            }, this.callTimeoutMs);
            this.queue.push({ resolve, reject, timer });
            try {
                this.proc.stdin.write(JSON.stringify({ cmd, ...args }) + '\n');
            } catch (e) {
                clearTimeout(timer);
                reject(e);
            }
        });
    }

    ping()       { return this.call('ping'); }
    sql(query)   { return this.call('sql', { query }); }

    /**
     * Execute SQL and return parsed rows as an array of plain objects.
     * Values are auto-detected: numbers become Number, empty elements
     * become null, everything else stays a String.
     *
     * Returns []  if the query returned no rows.
     */
    async sqlRows(query) {
        const r = await this.sql(query);
        return parseEaXml(r.xml);
    }

    /**
     * Convenience: run a SQL query, return a single scalar value.
     * Errors if the result has != 1 row or != 1 column.
     * Useful for counts and aggregates: const n = await ea.sqlValue('SELECT COUNT(*) AS n FROM t_object');
     */
    async sqlValue(query) {
        const rows = await this.sqlRows(query);
        if (rows.length === 0) return null;
        if (rows.length !== 1) {
            throw new Error(`sqlValue expected 1 row, got ${rows.length}. Use sqlRows() for multi-row queries.`);
        }
        const keys = Object.keys(rows[0]);
        if (keys.length !== 1) {
            throw new Error(`sqlValue expected 1 column, got ${keys.length}. Use sqlRows() for multi-column queries.`);
        }
        return rows[0][keys[0]];
    }

    async invoke(target, method, args = []) {
        const r = await this.call('invoke', { target, method, args: args.map(packArg) });
        return r.value;
    }
    async get(target, prop) {
        const r = await this.call('get', { target, prop });
        return r.value;
    }
    async set(target, prop, value) {
        await this.call('set', { target, prop, value: packArg(value) });
    }
    async getProps(target, props) {
        const r = await this.call('getProps', { target, props });
        return r.values;
    }
    async release(handle) {
        await this.call('release', { handle });
    }

    get repo() {
        if (!this._repoProxy) this._repoProxy = this._makeProxy('repo', 'EA.Repository');
        return this._repoProxy;
    }

    get app() {
        if (!this.hasApp) {
            throw new Error(
                "ea.app is not available in 'spawn' mode (headless Repository only). " +
                "Most APIs work through ea.repo, including ea.repo.GetProjectInterface(). " +
                "Use mode 'attach' or 'spawn-app' if you specifically need EA.App."
            );
        }
        if (!this._appProxy) this._appProxy = this._makeProxy('app', 'EA.App');
        return this._appProxy;
    }

    _makeProxy(target, typeLabel = '') {
        const bridge = this;
        const escapes = new Set([
            'then', 'catch', 'finally', '__handle', '__type',
            'release', 'props', '_target', '_isEAProxy',
            'constructor', 'prototype', 'toString', 'valueOf', 'inspect',
            'asymmetricMatch'
        ]);

        return new Proxy(function () {}, {
            get(_, prop) {
                if (prop === '_isEAProxy') return true;
                if (prop === '_target')    return target;
                if (prop === '__handle')   return typeof target === 'number' ? target : null;
                if (prop === '__type')     return typeLabel;

                if (prop === 'release') {
                    return () => typeof target === 'number'
                        ? bridge.release(target)
                        : Promise.resolve();
                }
                if (prop === 'props') {
                    return async (...names) => bridge.getProps(target, names);
                }
                if (typeof prop === 'symbol') return undefined;
                if (escapes.has(prop)) return undefined;

                const member = function (...args) {
                    return bridge.invoke(target, prop, args).then(v => wrapIfHandle(bridge, v));
                };
                member.then = (onFulfilled, onRejected) =>
                    bridge.get(target, prop)
                        .then(v => wrapIfHandle(bridge, v))
                        .then(onFulfilled, onRejected);
                return member;
            }
        });
    }
}

function packArg(v) {
    if (v == null) return null;
    if (v && v._isEAProxy && typeof v.__handle === 'number') {
        return { handle: v.__handle };
    }
    return v;
}

function wrapIfHandle(bridge, value) {
    if (value && typeof value === 'object' && typeof value.__handle === 'number') {
        const proxy = bridge._makeProxy(value.__handle, value.__type);
        if (value.preview) previewMap.set(proxy, value.preview);
        return proxy;
    }
    return value;
}

function previewOf(proxy) {
    return previewMap.get(proxy);
}

/**
 * Parse the EA SQLQuery XML response into an array of plain objects.
 *
 * Input format (from EA):
 *   <?xml version="1.0" encoding="UTF-16" ...?>
 *   <EADATA version="1.0" exporter="...">
 *     <Dataset_0>
 *       <Data>
 *         <Row>
 *           <Object_ID>123</Object_ID>
 *           <Name>Foo</Name>
 *           <Note/>
 *         </Row>
 *         ...
 *       </Data>
 *     </Dataset_0>
 *   </EADATA>
 *
 * Output: [{ Object_ID: 123, Name: 'Foo', Note: null }, ...]
 *
 * Value parsing rules (auto-detect):
 *   - Empty element (<Note/> or <Note></Note>) -> null
 *   - Pure integer / float (no leading zeros, in safe range) -> Number
 *   - Anything else -> String (with XML entities unescaped)
 *
 * Only Dataset_0 is parsed; additional datasets (rarely produced by EA)
 * are ignored.
 */
function parseEaXml(xml) {
    if (typeof xml !== 'string' || xml.length === 0) return [];

    // Find Dataset_0 content. EA always names it Dataset_0.
    const datasetMatch = xml.match(/<Dataset_0[^>]*>([\s\S]*?)<\/Dataset_0>/);
    if (!datasetMatch) return [];

    const datasetBody = datasetMatch[1];

    // Find all <Row>...</Row> blocks. Use a non-greedy match since rows
    // don't nest inside each other in EA's SQL output.
    const rowRegex = /<Row[^>]*>([\s\S]*?)<\/Row>/g;
    const rows = [];

    let rowMatch;
    while ((rowMatch = rowRegex.exec(datasetBody)) !== null) {
        const rowBody = rowMatch[1];
        rows.push(parseRow(rowBody));
    }

    return rows;
}

function parseRow(rowBody) {
    const obj = {};

    // Match either:
    //   <FieldName>value</FieldName>
    //   <FieldName />   (self-closing, no value, => null)
    //   <FieldName></FieldName>   (empty value, => null)
    //
    // Field names in EA are typically alphanumeric + underscore.
    // The regex captures the name and optionally the content.
    const fieldRegex = /<([A-Za-z_][A-Za-z0-9_]*)(?:\s*\/>|>([\s\S]*?)<\/\1>)/g;

    let m;
    while ((m = fieldRegex.exec(rowBody)) !== null) {
        const name = m[1];
        const raw = m[2];  // undefined for self-closing tags

        if (raw === undefined || raw.length === 0) {
            obj[name] = null;
        } else {
            obj[name] = parseValue(unescapeXml(raw));
        }
    }

    return obj;
}

function parseValue(s) {
    if (s === '' || s == null) return null;

    // Leading-zero check: keep "0123" as string (could be a code/GUID prefix)
    // but allow "0" and "0.5" as numbers.
    if (/^0\d/.test(s)) return s;

    // Integer
    if (/^-?\d+$/.test(s)) {
        const n = Number(s);
        if (Number.isSafeInteger(n)) return n;
        // Too big for safe integer - keep as string to avoid precision loss
        return s;
    }

    // Float (require digit before/after decimal point to avoid weird matches)
    if (/^-?\d+\.\d+$/.test(s)) {
        const n = parseFloat(s);
        if (Number.isFinite(n)) return n;
    }

    // Everything else stays a string
    return s;
}

function unescapeXml(s) {
    if (typeof s !== 'string') return s;
    // Common XML entities (EA SQL output uses these for special chars)
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/&#x([0-9A-Fa-f]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/&amp;/g, '&');   // last to avoid double-unescaping
}

function loadConfig() {
    const candidates = [
        path.join(process.cwd(), 'config.json'),
        path.join(__dirname, 'config.json'),
    ];
    for (const file of candidates) {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    throw new Error('config.json not found.');
}

module.exports = { EABridge, loadConfig, previewOf, parseEaXml };
