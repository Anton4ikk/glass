const sqliteRepository = require('./sqlite.repository');

function getBaseRepository() {
    return sqliteRepository;
}

const providerSettingsRepositoryAdapter = {
    async getByProvider(provider) {
        const repo = getBaseRepository();
        return await repo.getByProvider(provider);
    },

    async getAll() {
        const repo = getBaseRepository();
        return await repo.getAll();
    },

    async upsert(provider, settings) {
        const repo = getBaseRepository();
        const now = Date.now();
        
        const settingsWithMeta = {
            ...settings,
            provider,
            updated_at: now,
            created_at: settings.created_at || now
        };
        
        return await repo.upsert(provider, settingsWithMeta);
    },

    async remove(provider) {
        const repo = getBaseRepository();
        return await repo.remove(provider);
    },

    async removeAll() {
        const repo = getBaseRepository();
        return await repo.removeAll();
    },

    async getActiveProvider(type) {
        const repo = getBaseRepository();
        return await repo.getActiveProvider(type);
    },
    
    async setActiveProvider(provider, type) {
        const repo = getBaseRepository();
        return await repo.setActiveProvider(provider, type);
    },
    
    async getActiveSettings() {
        const repo = getBaseRepository();
        return await repo.getActiveSettings();
    }
};

module.exports = {
    ...providerSettingsRepositoryAdapter
}; 