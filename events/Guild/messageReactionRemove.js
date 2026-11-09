const { queueStarboardUpdate } = require("../../systems/starboard");

module.exports = async (client, reaction, user) => {
    try {
        if (user.bot) return;
        await queueStarboardUpdate(reaction, user, true);
    } catch (error) {
        console.error("[Starboard] messageReactionRemove failed:", error);
    }
};
