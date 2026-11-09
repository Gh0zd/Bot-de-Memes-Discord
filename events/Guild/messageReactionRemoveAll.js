const { updateAfterAllReactionsRemoved } = require("../../systems/starboard");

module.exports = async (client, message) => {
    try {
        await updateAfterAllReactionsRemoved(message);
    } catch (error) {
        console.error("[Starboard] messageReactionRemoveAll failed:", error);
    }
};
