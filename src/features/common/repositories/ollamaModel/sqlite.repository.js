const sqliteClient = require('../../services/sqliteClient');

/**
 * Get all Ollama models
 */
function getAllModels() {
    const db = sqliteClient.getDb();
    const query = 'SELECT * FROM ollama_models ORDER BY name';
    
    try {
        return db.prepare(query).all() || [];
    } catch (err) {
        console.error('[OllamaModel Repository] Failed to get models:', err);
        throw err;
    }
}

/**
 * Get a specific model by name
 */
function getModel(name) {
    const db = sqliteClient.getDb();
    const query = 'SELECT * FROM ollama_models WHERE name = ?';
    
    try {
        return db.prepare(query).get(name);
    } catch (err) {
        console.error('[OllamaModel Repository] Failed to get model:', err);
        throw err;
    }
}

/**
 * Create or update a model entry
 */
function upsertModel({ name, size, installed = false, installing = false }) {
    const db = sqliteClient.getDb();
    const query = `
        INSERT INTO ollama_models (name, size, installed, installing)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET 
            size = excluded.size,
            installed = excluded.installed,
            installing = excluded.installing
    `;
    
    try {
        db.prepare(query).run(name, size, installed ? 1 : 0, installing ? 1 : 0);
        return { success: true };
    } catch (err) {
        console.error('[OllamaModel Repository] Failed to upsert model:', err);
        throw err;
    }
}

/**
 * Update installation status for a model
 * Upserts, since models are discovered dynamically from Ollama and may not have a row yet
 */
function updateInstallStatus(name, installed, installing = false) {
    const db = sqliteClient.getDb();
    const query = `
        INSERT INTO ollama_models (name, size, installed, installing)
        VALUES (?, 'Unknown', ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            installed = excluded.installed,
            installing = excluded.installing
    `;

    try {
        const result = db.prepare(query).run(name, installed ? 1 : 0, installing ? 1 : 0);
        return { success: true, changes: result.changes };
    } catch (err) {
        console.error('[OllamaModel Repository] Failed to update install status:', err);
        throw err;
    }
}

/**
 * Initialize default models - now done dynamically based on installed models
 */
function initializeDefaultModels() {
    // Default models are now detected dynamically from Ollama installation
    // This function maintains compatibility but doesn't hardcode any models
    console.log('[OllamaModel Repository] Default models initialization skipped - using dynamic detection');
    return { success: true };
}

/**
 * Delete a model entry
 */
function deleteModel(name) {
    const db = sqliteClient.getDb();
    const query = 'DELETE FROM ollama_models WHERE name = ?';
    
    try {
        const result = db.prepare(query).run(name);
        return { success: true, changes: result.changes };
    } catch (err) {
        console.error('[OllamaModel Repository] Failed to delete model:', err);
        throw err;
    }
}

/**
 * Get installed models
 */
function getInstalledModels() {
    const db = sqliteClient.getDb();
    const query = 'SELECT * FROM ollama_models WHERE installed = 1 ORDER BY name';
    
    try {
        return db.prepare(query).all() || [];
    } catch (err) {
        console.error('[OllamaModel Repository] Failed to get installed models:', err);
        throw err;
    }
}

/**
 * Drop rows for models Ollama no longer reports.
 *
 * The sync loop only ever upserts models that are present, so a model removed
 * with `ollama rm` would otherwise stay here forever and keep counting towards
 * "is this provider configured?".
 *
 * Rows with installing = 1 are kept: a model still being pulled is legitimately
 * absent from Ollama's list and must not be dropped mid-download.
 *
 * Callers must not pass an empty list to mean "nothing installed" - see the
 * guard in ollamaService, where an empty list is indistinguishable from a
 * failed request.
 */
function pruneMissingModels(liveModelNames) {
    const db = sqliteClient.getDb();

    if (!Array.isArray(liveModelNames) || liveModelNames.length === 0) {
        return { success: true, changes: 0 };
    }

    const placeholders = liveModelNames.map(() => '?').join(', ');
    const query = `DELETE FROM ollama_models WHERE installing = 0 AND name NOT IN (${placeholders})`;

    try {
        const result = db.prepare(query).run(...liveModelNames);
        return { success: true, changes: result.changes };
    } catch (err) {
        console.error('[OllamaModel Repository] Failed to prune missing models:', err);
        throw err;
    }
}

/**
 * Get models currently being installed
 */
function getInstallingModels() {
    const db = sqliteClient.getDb();
    const query = 'SELECT * FROM ollama_models WHERE installing = 1 ORDER BY name';
    
    try {
        return db.prepare(query).all() || [];
    } catch (err) {
        console.error('[OllamaModel Repository] Failed to get installing models:', err);
        throw err;
    }
}

module.exports = {
    getAllModels,
    getModel,
    upsertModel,
    updateInstallStatus,
    initializeDefaultModels,
    deleteModel,
    getInstalledModels,
    getInstallingModels,
    pruneMissingModels
};