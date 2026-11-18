const sqliteRepository = require('./sqlite.repository');
const { LOCAL_UID } = require('../../common/config/localUser');

const askRepositoryAdapter = {
    addAiMessage: ({ sessionId, role, content, model }) =>
        sqliteRepository.addAiMessage({ uid: LOCAL_UID, sessionId, role, content, model }),
    getAllAiMessagesBySessionId: (sessionId) => sqliteRepository.getAllAiMessagesBySessionId(sessionId),
};

module.exports = askRepositoryAdapter;
