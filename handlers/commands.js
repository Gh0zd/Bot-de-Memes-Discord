const path = require("node:path");
const { readdirSync } = require("node:fs");
const { logError, logInfo } = require("../utils/logger");

const COMMANDS_DIRECTORY = path.join(__dirname, "..", "commands");

function getCommandFiles(directory) {
    return readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .flatMap(entry => {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) return getCommandFiles(entryPath);
            return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
        });
}

module.exports = function loadCommands(client) {
    try {
        const commandFiles = getCommandFiles(COMMANDS_DIRECTORY);

        for (const filePath of commandFiles) {
            const command = require(filePath);
            if (typeof command.name !== "string" || typeof command.run !== "function") {
                throw new TypeError(
                    `Command "${path.relative(COMMANDS_DIRECTORY, filePath)}" must export a name and a run function.`
                );
            }

            const commandName = command.name.toLowerCase();
            if (client.commands.has(commandName)) {
                throw new Error(`Duplicate command name "${commandName}".`);
            }
            client.commands.set(commandName, command);

            if (command.aliases !== undefined && !Array.isArray(command.aliases)) {
                throw new TypeError(`Command "${commandName}" aliases must be an array.`);
            }

            for (const alias of command.aliases || []) {
                if (typeof alias !== "string" || !alias.trim()) {
                    throw new TypeError(`Command "${commandName}" has an invalid alias.`);
                }
                const normalizedAlias = alias.toLowerCase();
                if (
                    client.aliases.has(normalizedAlias) ||
                    client.commands.has(normalizedAlias)
                ) {
                    throw new Error(`Duplicate command alias "${normalizedAlias}".`);
                }
                client.aliases.set(normalizedAlias, commandName);
            }
        }

        logInfo("Commands", `Loaded ${commandFiles.length} message commands.`);
    } catch (error) {
        logError("Commands", "Failed to load message commands.", error);
        throw error;
    }
};