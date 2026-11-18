const sqliteRepository = require('./sqlite.repository');
const { LOCAL_UID } = require('../../config/localUser');

// Injects the local uid so services never pass user IDs.
const sessionRepositoryAdapter = {
    getById: (id) => sqliteRepository.getById(id),
    create: (type = 'ask') => sqliteRepository.create(LOCAL_UID, type),
    getAllByUserId: () => sqliteRepository.getAllByUserId(LOCAL_UID),
    updateTitle: (id, title) => sqliteRepository.updateTitle(id, title),
    deleteWithRelatedData: (id) => sqliteRepository.deleteWithRelatedData(id),
    end: (id) => sqliteRepository.end(id),
    updateType: (id, type) => sqliteRepository.updateType(id, type),
    touch: (id) => sqliteRepository.touch(id),
    getOrCreateActive: (requestedType = 'ask') => sqliteRepository.getOrCreateActive(LOCAL_UID, requestedType),
    endAllActiveSessions: () => sqliteRepository.endAllActiveSessions(LOCAL_UID),
};

module.exports = sessionRepositoryAdapter;
