const sqliteRepository = require('./sqlite.repository');
const { LOCAL_UID } = require('../../../common/config/localUser');

const sttRepositoryAdapter = {
    addTranscript: ({ sessionId, speaker, text }) =>
        sqliteRepository.addTranscript({ uid: LOCAL_UID, sessionId, speaker, text }),
    getAllTranscriptsBySessionId: (sessionId) => sqliteRepository.getAllTranscriptsBySessionId(sessionId),
};

module.exports = sttRepositoryAdapter;
