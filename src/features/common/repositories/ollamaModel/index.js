const sqliteRepository = require('./sqlite.repository');

function getRepository() {
    return sqliteRepository;
}

module.exports = {
    getAllModels: (...args) => getRepository().getAllModels(...args),
    getModel: (...args) => getRepository().getModel(...args),
    upsertModel: (...args) => getRepository().upsertModel(...args),
    updateInstallStatus: (...args) => getRepository().updateInstallStatus(...args),
    initializeDefaultModels: (...args) => getRepository().initializeDefaultModels(...args),
    deleteModel: (...args) => getRepository().deleteModel(...args),
    getInstalledModels: (...args) => getRepository().getInstalledModels(...args),
    getInstallingModels: (...args) => getRepository().getInstallingModels(...args),
    pruneMissingModels: (...args) => getRepository().pruneMissingModels(...args)
};