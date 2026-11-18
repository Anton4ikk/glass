const sqliteRepository = require('./sqlite.repository');
const { LOCAL_UID } = require('../../common/config/localUser');

const settingsRepositoryAdapter = {
    getPresets: () => sqliteRepository.getPresets(LOCAL_UID),
    getPresetTemplates: () => sqliteRepository.getPresetTemplates(),
    createPreset: (options) => sqliteRepository.createPreset({ uid: LOCAL_UID, ...options }),
    updatePreset: (id, options) => sqliteRepository.updatePreset(id, options, LOCAL_UID),
    deletePreset: (id) => sqliteRepository.deletePreset(id, LOCAL_UID),

    getSttLanguage: () => sqliteRepository.getSttLanguage(LOCAL_UID),
    setSttLanguage: (language) => sqliteRepository.setSttLanguage(LOCAL_UID, language),
    getAskThinking: () => sqliteRepository.getAskThinking(LOCAL_UID),
    setAskThinking: (enabled) => sqliteRepository.setAskThinking(LOCAL_UID, enabled),
    getAboutMe: () => sqliteRepository.getAboutMe(LOCAL_UID),
    setAboutMe: (text) => sqliteRepository.setAboutMe(LOCAL_UID, text),
};

module.exports = settingsRepositoryAdapter;
