// "About me": free text the user writes in Settings so Ask and the live
// summary know who "me" is (name, role, stack, what the meetings are about).

// Generous for a profile, small enough not to crowd out the transcript on a
// local model's context window.
const MAX_ABOUT_ME_LENGTH = 4000;

function normalizeAboutMe(text) {
    if (typeof text !== 'string') return '';
    return text.trim().slice(0, MAX_ABOUT_ME_LENGTH);
}

/** The system-prompt block for the user's profile, or '' when it is empty. */
function aboutMePromptSection(text) {
    const aboutMe = normalizeAboutMe(text);
    if (!aboutMe) return '';
    return `About the user (written by the user; "me" in the transcript is this person). Use it to tailor answers to their background and goals, but do not repeat it back unless asked:
<about_me>
${aboutMe}
</about_me>`;
}

module.exports = {
    MAX_ABOUT_ME_LENGTH,
    normalizeAboutMe,
    aboutMePromptSection,
};
