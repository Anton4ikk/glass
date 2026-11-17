// Models that rejected an image in this run of the app. Ask and the live
// analysis share it, so neither pays for a failing screenshot request twice.
const textOnlyModels = new Set();

module.exports = {
    isTextOnly: model => textOnlyModels.has(model),
    markTextOnly: model => textOnlyModels.add(model),
};
