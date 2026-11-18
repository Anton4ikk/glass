const sqliteClient = require('../../common/services/sqliteClient');
const { normalizeAboutMe } = require('../../common/prompts/aboutMe');

function getPresets(uid) {
    const db = sqliteClient.getDb();
    const query = `
        SELECT * FROM prompt_presets 
        WHERE uid = ? OR is_default = 1 
        ORDER BY is_default DESC, title ASC
    `;
    
    try {
        return db.prepare(query).all(uid) || [];
    } catch (err) {
        console.error('SQLite: Failed to get presets:', err);
        throw err;
    }
}

function getPresetTemplates() {
    const db = sqliteClient.getDb();
    const query = `
        SELECT * FROM prompt_presets 
        WHERE is_default = 1 
        ORDER BY title ASC
    `;
    
    try {
        return db.prepare(query).all() || [];
    } catch (err) {
        console.error('SQLite: Failed to get preset templates:', err);
        throw err;
    }
}

function createPreset({ uid, title, prompt }) {
    const db = sqliteClient.getDb();
    const id = require('crypto').randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const query = `
        INSERT INTO prompt_presets (id, uid, title, prompt, is_default, created_at, sync_state)
        VALUES (?, ?, ?, ?, 0, ?, 'dirty')
    `;
    
    try {
        db.prepare(query).run(id, uid, title, prompt, now);
        return { id };
    } catch (err) {
        console.error('SQLite: Failed to create preset:', err);
        throw err;
    }
}

function updatePreset(id, { title, prompt }, uid) {
    const db = sqliteClient.getDb();
    const now = Math.floor(Date.now() / 1000);
    const query = `
        UPDATE prompt_presets 
        SET title = ?, prompt = ?, sync_state = 'dirty', updated_at = ?
        WHERE id = ? AND uid = ? AND is_default = 0
    `;
    
    try {
        const result = db.prepare(query).run(title, prompt, now, id, uid);
        if (result.changes === 0) {
            throw new Error('Preset not found, is default, or permission denied');
        }
        return { changes: result.changes };
    } catch (err) {
        console.error('SQLite: Failed to update preset:', err);
        throw err;
    }
}

function deletePreset(id, uid) {
    const db = sqliteClient.getDb();
    const query = `
        DELETE FROM prompt_presets 
        WHERE id = ? AND uid = ? AND is_default = 0
    `;
    
    try {
        const result = db.prepare(query).run(id, uid);
        if (result.changes === 0) {
            throw new Error('Preset not found, is default, or permission denied');
        }
        return { changes: result.changes };
    } catch (err) {
        console.error('SQLite: Failed to delete preset:', err);
        throw err;
    }
}

// Language forced on the STT engine. Whisper's 'auto' detection is unreliable
// on the short chunks Glass feeds it and drifts to English mid-conversation,
// so the language is an explicit user choice rather than a guess.
const SUPPORTED_STT_LANGUAGES = ['en', 'ru'];
const DEFAULT_STT_LANGUAGE = 'en';

function normalizeSttLanguage(language) {
    return SUPPORTED_STT_LANGUAGES.includes(language) ? language : DEFAULT_STT_LANGUAGE;
}

function getSttLanguage(uid) {
    const db = sqliteClient.getDb();
    const targetUid = uid || sqliteClient.defaultUserId;

    try {
        const row = db.prepare('SELECT stt_language FROM users WHERE uid = ?').get(targetUid);
        return normalizeSttLanguage(row?.stt_language);
    } catch (error) {
        console.error('SQLite: Error getting stt_language setting:', error);
        return DEFAULT_STT_LANGUAGE;
    }
}

function setSttLanguage(uid, language) {
    const db = sqliteClient.getDb();
    const targetUid = uid || sqliteClient.defaultUserId;
    const safeLanguage = normalizeSttLanguage(language);

    try {
        const result = db.prepare('UPDATE users SET stt_language = ? WHERE uid = ?').run(safeLanguage, targetUid);

        // If no rows were updated, the user might not exist, so create them
        if (result.changes === 0) {
            const now = Math.floor(Date.now() / 1000);
            const stmt = db.prepare('INSERT OR REPLACE INTO users (uid, display_name, email, created_at, stt_language) VALUES (?, ?, ?, ?, ?)');
            stmt.run(targetUid, 'User', 'user@example.com', now, safeLanguage);
        }

        return { success: true, language: safeLanguage };
    } catch (error) {
        console.error('SQLite: Error setting stt_language:', error);
        throw error;
    }
}

// Whether Ask lets reasoning models (gemma4, qwen3, ...) think before answering.
// Off by default: on gemma4:e4b thinking moves the first word from ~5 s to ~30 s.
function getAskThinking(uid) {
    const db = sqliteClient.getDb();
    const targetUid = uid || sqliteClient.defaultUserId;

    try {
        const row = db.prepare('SELECT ask_thinking FROM users WHERE uid = ?').get(targetUid);
        return row?.ask_thinking === 1;
    } catch (error) {
        console.error('SQLite: Error getting ask_thinking setting:', error);
        return false;
    }
}

function setAskThinking(uid, enabled) {
    const db = sqliteClient.getDb();
    const targetUid = uid || sqliteClient.defaultUserId;
    const value = enabled ? 1 : 0;

    try {
        const result = db.prepare('UPDATE users SET ask_thinking = ? WHERE uid = ?').run(value, targetUid);

        // If no rows were updated, the user might not exist, so create them
        if (result.changes === 0) {
            const now = Math.floor(Date.now() / 1000);
            const stmt = db.prepare('INSERT OR REPLACE INTO users (uid, display_name, email, created_at, ask_thinking) VALUES (?, ?, ?, ?, ?)');
            stmt.run(targetUid, 'User', 'user@example.com', now, value);
        }

        return { success: true, enabled: value === 1 };
    } catch (error) {
        console.error('SQLite: Error setting ask_thinking:', error);
        throw error;
    }
}

function getAboutMe(uid) {
    const db = sqliteClient.getDb();
    const targetUid = uid || sqliteClient.defaultUserId;

    try {
        const row = db.prepare('SELECT about_me FROM users WHERE uid = ?').get(targetUid);
        return normalizeAboutMe(row?.about_me);
    } catch (error) {
        console.error('SQLite: Error getting about_me:', error);
        return '';
    }
}

function setAboutMe(uid, text) {
    const db = sqliteClient.getDb();
    const targetUid = uid || sqliteClient.defaultUserId;
    const value = normalizeAboutMe(text);

    try {
        const result = db.prepare('UPDATE users SET about_me = ? WHERE uid = ?').run(value, targetUid);

        // If no rows were updated, the user might not exist, so create them
        if (result.changes === 0) {
            const now = Math.floor(Date.now() / 1000);
            const stmt = db.prepare('INSERT OR REPLACE INTO users (uid, display_name, email, created_at, about_me) VALUES (?, ?, ?, ?, ?)');
            stmt.run(targetUid, 'User', 'user@example.com', now, value);
        }

        return { success: true, aboutMe: value };
    } catch (error) {
        console.error('SQLite: Error setting about_me:', error);
        throw error;
    }
}

module.exports = {
    getPresets,
    getPresetTemplates,
    createPreset,
    updatePreset,
    deletePreset,
    getSttLanguage,
    setSttLanguage,
    getAskThinking,
    setAskThinking,
    getAboutMe,
    setAboutMe,
    SUPPORTED_STT_LANGUAGES,
    DEFAULT_STT_LANGUAGE
};