const path = require("node:path");
const { readdirSync, statSync } = require("node:fs");
const { Events, REST, Routes, SlashCommandBuilder } = require("discord.js");
const settings = require("../settings.json");
const { logError, logInfo } = require("../utils/logger");

const COMMANDS_DIRECTORY = path.join(__dirname, "..", "slashCommands");
const CLIENT_READY_EVENT = Events.ClientReady || "ready";
const OPTION_METHODS = {
    String: "addStringOption",
    User: "addUserOption",
    Role: "addRoleOption",
    Channel: "addChannelOption",
    Integer: "addIntegerOption",
    Attachment: "addAttachmentOption",
    StringChoices: "addStringOption"
};

function normalizeCommandName(name) {
    return String(name).trim().toLowerCase().replace(/\s+/g, "_");
}

function addOptions(commandBuilder, options = []) {
    for (const option of options) {
        const method = OPTION_METHODS[option.type];
        if (!method || !option.name || !option.description) {
            throw new TypeError(`Invalid slash command option: ${JSON.stringify(option)}`);
        }

        commandBuilder[method](builder => {
            builder
                .setName(normalizeCommandName(option.name))
                .setDescription(String(option.description))
                .setRequired(option.required === true);

            if (option.type === "StringChoices") {
                if (!Array.isArray(option.choices) || option.choices.length === 0) {
                    throw new TypeError(
                        `String option "${option.name}" must provide at least one choice.`
                    );
                }
                builder.addChoices(...option.choices);
            }

            return builder;
        });
    }

    return commandBuilder;
}

function getGroupConfiguration(folderName) {
    return (settings.slashCommandDirs || []).find(
        entry => entry.folderName === folderName
    );
}

function getGroupName(configuration) {
    const configuredName = configuration.CmdName || configuration.commandName;
    return typeof configuredName === "string"
        ? normalizeCommandName(configuredName)
        : "";
}

function getGroupDescription(configuration) {
    return configuration.CmdDescription ||
        configuration.commandDescription ||
        configuration.commandDecription;
}

function getCommandFiles(directory) {
    return readdirSync(directory)
        .filter(fileName => fileName.endsWith(".js"))
        .sort();
}

function registerSlashCommand(client, commandKey, command) {
    if (client.slashCommands.has(commandKey)) {
        throw new Error(`Duplicate slash command handler "${commandKey}".`);
    }
    client.slashCommands.set(commandKey, command);
}

function loadGroupedCommands(client, directory, folderName, configuration, commands) {
    const groupName = getGroupName(configuration);
    const groupDescription = getGroupDescription(configuration);
    if (!groupName || !groupDescription) {
        throw new TypeError(`Slash command group "${folderName}" needs a name and description.`);
    }

    const commandBuilder = new SlashCommandBuilder()
        .setName(groupName)
        .setDescription(String(groupDescription));

    for (const fileName of getCommandFiles(directory)) {
        const command = require(path.join(directory, fileName));
        if (typeof command.name !== "string" || typeof command.description !== "string") {
            throw new TypeError(
                `Slash command "${fileName}" must export a name and description.`
            );
        }

        const subcommandName = normalizeCommandName(command.name);
        commandBuilder.addSubcommand(subcommand => {
            subcommand
                .setName(subcommandName)
                .setDescription(command.description);
            addOptions(subcommand, command.options);
            return subcommand;
        });
        registerSlashCommand(client, `${groupName}${subcommandName}`, command);
    }

    commands.push(commandBuilder.toJSON());
}

function loadStandaloneCommand(client, filePath, commands) {
    const command = require(filePath);
    if (typeof command.name !== "string" || typeof command.description !== "string") {
        throw new TypeError(
            `Slash command "${path.basename(filePath)}" must export a name and description.`
        );
    }

    const commandName = normalizeCommandName(command.name);
    const commandBuilder = new SlashCommandBuilder()
        .setName(commandName)
        .setDescription(command.description);
    addOptions(commandBuilder, command.options);
    commands.push(commandBuilder.toJSON());
    registerSlashCommand(client, `normal${commandName}`, command);
}

function loadCommandDirectory(client, directory, commands) {
    const entries = readdirSync(directory)
        .sort()
        .map(name => ({
            name,
            path: path.join(directory, name),
            isDirectory: statSync(path.join(directory, name)).isDirectory()
        }));

    for (const entry of entries) {
        if (entry.isDirectory) {
            const configuration = getGroupConfiguration(entry.name);
            if (configuration) {
                loadGroupedCommands(
                    client,
                    entry.path,
                    entry.name,
                    configuration,
                    commands
                );
            } else {
                loadCommandDirectory(client, entry.path, commands);
            }
        } else if (entry.name.endsWith(".js")) {
            loadStandaloneCommand(client, entry.path, commands);
        }
    }
}

function loadCommandDefinitions(client) {
    const commandDefinitions = [];
    loadCommandDirectory(client, COMMANDS_DIRECTORY, commandDefinitions);
    return commandDefinitions;
}

async function deployGuildCommands(client, rest, commands, guild) {
    try {
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, guild.id),
            { body: commands }
        );
        logInfo(
            "Slash commands",
            `Published ${commands.length} commands for "${guild.name}".`
        );
    } catch (error) {
        logError(
            "Slash commands",
            `Could not publish commands for guild "${guild.name}" (${guild.id}).`,
            error
        );
    }
}

async function deployCommands(client, rest, commands) {
    if (settings.loadSlashsGlobal === true) {
        const guildResults = await Promise.allSettled(
            [...client.guilds.cache.values()].map(guild =>
                rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), {
                    body: []
                })
            )
        );
        guildResults.forEach((result, index) => {
            if (result.status === "rejected") {
                const guild = [...client.guilds.cache.values()][index];
                logError(
                    "Slash commands",
                    `Could not clear guild commands for "${guild.name}" (${guild.id}).`,
                    result.reason
                );
            }
        });

        await rest.put(Routes.applicationCommands(client.user.id), {
            body: commands
        });
        logInfo(
            "Slash commands",
            `Published ${commands.length} global commands.`
        );
        return;
    }

    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    for (const guild of client.guilds.cache.values()) {
        await deployGuildCommands(client, rest, commands, guild);
    }
}

module.exports = function loadSlashCommands(client) {
    try {
        const commands = loadCommandDefinitions(client);
        const rest = new REST({ version: "10" }).setToken(client.token || settings.token);

        client.once(CLIENT_READY_EVENT, async () => {
            try {
                await deployCommands(client, rest, commands);
            } catch (error) {
                logError("Slash commands", "Failed to publish slash commands.", error);
            }
        });

        client.on(Events.GuildCreate, async guild => {
            if (settings.loadSlashsGlobal === true) return;
            await deployGuildCommands(client, rest, commands, guild);
        });

        logInfo("Slash commands", `Loaded ${commands.length} command definitions.`);
    } catch (error) {
        logError("Slash commands", "Failed to load slash command definitions.", error);
        throw error;
    }
};
