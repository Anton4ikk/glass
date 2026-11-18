const sqliteRepository = require('./sqlite.repository');
const { LOCAL_UID } = require('../../config/localUser');

const presetRepositoryAdapter = {
    getPresets: () => sqliteRepository.getPresets(LOCAL_UID),
    getPresetTemplates: () => sqliteRepository.getPresetTemplates(),
    create: (options) => sqliteRepository.create({ uid: LOCAL_UID, ...options }),
    update: (id, options) => sqliteRepository.update(id, options, LOCAL_UID),
    delete: (id) => sqliteRepository.delete(id, LOCAL_UID),
};

module.exports = presetRepositoryAdapter;
