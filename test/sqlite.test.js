// sqliteClient is a process-wide singleton; node --test runs each file in its
// own process, and every test here reconnects it to a fresh temp database.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const sqliteClient = require('../src/features/common/services/sqliteClient');
const LATEST_SCHEMA = require('../src/features/common/config/schema');
const sessionRepo = require('../src/features/common/repositories/session/sqlite.repository');

let tmpDir;
let dbPath;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-test-'));
    dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
    sqliteClient.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function columnsOf(table) {
    return sqliteClient.getDb().prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
}

describe('sqliteClient schema sync', () => {
    test('creates every table and column from schema.js on a fresh database', async () => {
        sqliteClient.connect(dbPath);
        await sqliteClient.initTables();

        for (const [table, def] of Object.entries(LATEST_SCHEMA)) {
            assert.deepEqual(columnsOf(table), def.columns.map(c => c.name), `table ${table}`);
        }
    });

    test('seeds the default user and presets, and is idempotent', async () => {
        sqliteClient.connect(dbPath);
        await sqliteClient.initTables();
        await sqliteClient.initTables();

        const db = sqliteClient.getDb();
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prompt_presets WHERE is_default = 1').get().n, 5);
    });

    test('adds columns missing from an older database', async () => {
        const old = new Database(dbPath);
        old.exec('CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT NOT NULL, email TEXT NOT NULL)');
        old.prepare('INSERT INTO users VALUES (?, ?, ?)').run('u1', 'Old', 'old@example.com');
        old.close();

        sqliteClient.connect(dbPath);
        await sqliteClient.synchronizeSchema();

        assert.deepEqual(columnsOf('users'), LATEST_SCHEMA.users.columns.map(c => c.name));
        const row = sqliteClient.getDb().prepare('SELECT * FROM users WHERE uid = ?').get('u1');
        assert.equal(row.display_name, 'Old');
        assert.equal(row.stt_language, 'en'); // column default applied to existing rows
    });

    test('migrates per-user provider_settings to one row per provider, keeping the newest', async () => {
        const old = new Database(dbPath);
        old.exec('CREATE TABLE provider_settings (uid TEXT, provider TEXT, api_key TEXT, updated_at INTEGER, PRIMARY KEY (uid, provider))');
        const insert = old.prepare('INSERT INTO provider_settings VALUES (?, ?, ?, ?)');
        insert.run('a', 'openai', 'old-key', 100);
        insert.run('b', 'openai', 'new-key', 200);
        insert.run('a', 'gemini', 'g-key', 50);
        old.close();

        sqliteClient.connect(dbPath);
        await sqliteClient.synchronizeSchema();

        const db = sqliteClient.getDb();
        assert.ok(!columnsOf('provider_settings').includes('uid'));
        const rows = db.prepare('SELECT provider, api_key FROM provider_settings ORDER BY provider').all();
        assert.deepEqual(rows, [
            { provider: 'gemini', api_key: 'g-key' },
            { provider: 'openai', api_key: 'new-key' },
        ]);
        assert.ok(!sqliteClient.getTablesFromDb().includes('provider_settings_old'));
    });

    test('rejects unsafe identifiers', () => {
        assert.throws(() => sqliteClient._validateAndQuoteIdentifier('users; DROP TABLE x'), /Invalid database identifier/);
    });
});

describe('session sqlite repository', () => {
    beforeEach(async () => {
        sqliteClient.connect(dbPath);
        await sqliteClient.initTables();
    });

    test('getOrCreateActive reuses the active session and promotes ask -> listen', () => {
        const id = sessionRepo.getOrCreateActive('u1', 'ask');
        assert.equal(sessionRepo.getOrCreateActive('u1', 'ask'), id);

        assert.equal(sessionRepo.getOrCreateActive('u1', 'listen'), id);
        assert.equal(sessionRepo.getById(id).session_type, 'listen');

        // A listen session is never demoted back to ask.
        sessionRepo.getOrCreateActive('u1', 'ask');
        assert.equal(sessionRepo.getById(id).session_type, 'listen');
    });

    test('a new session is created after the active one ends', () => {
        const first = sessionRepo.getOrCreateActive('u1', 'ask');
        sessionRepo.end(first);
        const second = sessionRepo.getOrCreateActive('u1', 'ask');
        assert.notEqual(second, first);
    });

    test('endAllActiveSessions only ends sessions of the given user', () => {
        const mine = sessionRepo.create('u1', 'listen');
        const theirs = sessionRepo.create('u2', 'listen');

        assert.equal(sessionRepo.endAllActiveSessions('u1').changes, 1);
        assert.ok(sessionRepo.getById(mine).ended_at);
        assert.equal(sessionRepo.getById(theirs).ended_at, null);
    });

    test('deleteWithRelatedData removes the session with its transcripts', () => {
        const id = sessionRepo.create('u1', 'listen');
        const db = sqliteClient.getDb();
        db.prepare('INSERT INTO transcripts (id, session_id, speaker, text) VALUES (?, ?, ?, ?)').run('t1', id, 'me', 'hello');

        sessionRepo.deleteWithRelatedData(id);

        assert.equal(sessionRepo.getById(id), undefined);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transcripts WHERE session_id = ?').get(id).n, 0);
    });
});
