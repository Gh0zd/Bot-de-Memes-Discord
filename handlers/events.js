const path = require("node:path");
const { existsSync, readdirSync } = require("node:fs");
const { Events } = require("discord.js");
const { logError, logInfo } = require("../utils/logger");

const EVENT_DIRECTORY = path.join(__dirname, "..", "events");
const EVENT_GROUPS = [
    { directory: "RestEvents", emitter: client => client.rest, optional: true },
    { directory: "Guild", emitter: client => client },
    { directory: "Client", emitter: client => client }
];

function getEventName(fileName) {
    const eventName = path.basename(fileName, ".js");
    return eventName === "clientReady"
        ? Events.ClientReady || "ready"
        : eventName;
}

function loadEventGroup(client, group) {
    const directory = path.join(EVENT_DIRECTORY, group.directory);
    if (!existsSync(directory) && group.optional) return 0;

    let loadedCount = 0;

    for (const fileName of readdirSync(directory).filter(name => name.endsWith(".js")).sort()) {
        const eventHandler = require(path.join(directory, fileName));
        if (typeof eventHandler !== "function") {
            throw new TypeError(
                `Event "${fileName}" in "${group.directory}" must export a function.`
            );
        }

        group.emitter(client).on(
            getEventName(fileName),
            eventHandler.bind(null, client)
        );
        loadedCount += 1;
    }

    return loadedCount;
}

module.exports = function loadEvents(client) {
    try {
        const eventCount = EVENT_GROUPS.reduce(
            (total, group) => total + loadEventGroup(client, group),
            0
        );
        logInfo("Events", `Loaded ${eventCount} events.`);
    } catch (error) {
        logError("Events", "Failed to load event handlers.", error);
        throw error;
    }
};