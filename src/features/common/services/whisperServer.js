// Keeps whisper models loaded in a whisper-server process while listening.
// whisper-cli loads the model from scratch for every utterance (1.5 GB for
// medium, twice when both speakers talk at once); one shared server per model
// loads it once and serves both STT sessions.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

// Half the cores of an 8-core M1: leaves room for the LLM, the browser and
// the video call encoder that share the machine during an interview.
const WHISPER_THREADS = 2;
const STARTUP_TIMEOUT_MS = 30000;
const READY_POLL_MS = 150;
// Kept loaded briefly after the last session closes, so Stop -> Listen and
// the 20-minute STT session renewal don't reload the model.
const IDLE_SHUTDOWN_MS = 15000;
const REQUEST_TIMEOUT_MS = 60000;

const servers = new Map(); // modelPath -> { entry, ready: Promise<entry> }

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/** whisper-server ships next to whisper-cli (Homebrew, release archives). */
function serverBinaryFor(cliPath) {
    if (!cliPath) return null;
    const candidate = path.join(path.dirname(cliPath), process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server');
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
    } catch {
        return null;
    }
}

async function waitUntilReady(entry) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (entry.exited) throw new Error(`whisper-server exited during startup: ${entry.stderrTail}`);
        try {
            const res = await fetch(`${entry.url}/`, { signal: AbortSignal.timeout(1000) });
            if (res.ok) return;
        } catch {
            // Not listening yet.
        }
        await new Promise(resolve => setTimeout(resolve, READY_POLL_MS));
    }
    throw new Error('whisper-server did not start in time');
}

function startServer(binary, modelPath) {
    const slot = { entry: null, ready: null };
    const forget = () => {
        if (servers.get(modelPath) === slot) servers.delete(modelPath);
    };
    slot.ready = (async () => {
        const port = await freePort();
        const proc = spawn(binary, ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-t', String(WHISPER_THREADS), '-nt'], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        const entry = { proc, url: `http://127.0.0.1:${port}`, refs: 0, idleTimer: null, exited: false, stderrTail: '' };
        slot.entry = entry;
        proc.stderr.on('data', data => {
            entry.stderrTail = (entry.stderrTail + data.toString()).slice(-1000);
        });
        proc.on('exit', () => {
            entry.exited = true;
            forget();
        });
        proc.on('error', error => {
            entry.exited = true;
            entry.stderrTail += error.message;
            forget();
        });
        try {
            await waitUntilReady(entry);
        } catch (error) {
            proc.kill();
            forget();
            throw error;
        }
        return entry;
    })();
    // Set synchronously: the "Me" and "Them" sessions acquire at the same moment.
    servers.set(modelPath, slot);
    return slot;
}

/**
 * Starts (or reuses) the server for a model. Throws if whisper-server is not
 * installed or does not come up; callers then fall back to whisper-cli.
 * @returns {Promise<{transcribe(wav: Buffer, language: string, signal?: AbortSignal): Promise<string>, release(): void}>}
 */
async function acquire(cliPath, modelPath) {
    const binary = serverBinaryFor(cliPath);
    if (!binary) throw new Error('whisper-server not found next to whisper-cli');

    const slot = servers.get(modelPath) || startServer(binary, modelPath);
    const entry = await slot.ready;
    entry.refs++;
    clearTimeout(entry.idleTimer);

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        entry.refs--;
        if (entry.refs <= 0) {
            entry.idleTimer = setTimeout(() => {
                if (entry.refs > 0) return;
                // Forgotten right away, so a new session starts a fresh server instead of a dying one.
                if (servers.get(modelPath) === slot) servers.delete(modelPath);
                entry.proc.kill();
            }, IDLE_SHUTDOWN_MS);
        }
    };

    return {
        release,
        /** @returns {Promise<string>} raw text, as whisper-cli prints it */
        async transcribe(wav, language, signal) {
            if (entry.exited) throw new Error('whisper-server is not running');
            const form = new FormData();
            form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
            form.append('response_format', 'json');
            form.append('language', language || 'auto');
            const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
            const res = await fetch(`${entry.url}/inference`, {
                method: 'POST',
                body: form,
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            });
            if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}`);
            const body = await res.json();
            if (body.error) throw new Error(`whisper-server: ${body.error}`);
            return body.text || '';
        },
    };
}

// Child processes outlive a crashed or force-quit parent on macOS.
function killAll() {
    for (const slot of servers.values()) slot.entry?.proc.kill();
    servers.clear();
}
process.once('exit', killAll);

module.exports = { acquire, killAll, WHISPER_THREADS };
