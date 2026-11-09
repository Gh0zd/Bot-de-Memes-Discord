const { logInfo } = require("../../utils/logger");

module.exports = function onClientReady(client) {
    logInfo("Discord", `Logged in as ${client.user.tag} (${client.user.id}).`);
    logInfo(
        "Discord",
        `Serving ${client.guilds.cache.size} guild(s) | ${client.ws.ping}ms latency.`
    );
};
