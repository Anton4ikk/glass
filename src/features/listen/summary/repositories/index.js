const sqliteRepository = require('./sqlite.repository');
const { LOCAL_UID } = require('../../../common/config/localUser');

const summaryRepositoryAdapter = {
    saveSummary: ({ sessionId, tldr, text, bullet_json, action_json, model }) =>
        sqliteRepository.saveSummary({ uid: LOCAL_UID, sessionId, tldr, text, bullet_json, action_json, model }),
    getSummaryBySessionId: (sessionId) => sqliteRepository.getSummaryBySessionId(sessionId),
};

module.exports = summaryRepositoryAdapter;
