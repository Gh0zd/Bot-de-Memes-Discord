const { logError } = require("../../utils/logger");
const settings = require("../../settings.json")
const { handleMessage } = require("../../systems/memeSystem");
const { getPrefix } = require("../../systems/prefixSettings");

function findSlashCommand(client, name) {
    for (const command of client.slashCommands.values()) {
        if (command.name?.toLowerCase() === name) return command;
    }
    return null;
}

function createPrefixInteraction(client, message, command, args) {
    const optionIndex = optionName =>
        (command.options || []).findIndex(option => option.name === optionName);
    const getArgument = optionName => {
        const index = optionIndex(optionName);
        return index >= 0 ? args[index] ?? null : null;
    };
    const respond = async response => {
        const payload = typeof response === "string" ? { content: response } : { ...response };
        delete payload.flags;
        delete payload.ephemeral;
        return message.reply(payload);
    };

    return {
        client,
        guild: message.guild,
        guildId: message.guildId,
        channel: message.channel,
        user: message.author,
        member: message.member,
        memberPermissions: message.member?.permissions,
        options: {
            getSubcommand: () => null,
            getString: getArgument,
            getInteger: name => {
                const value = getArgument(name);
                return value === null ? null : Number.parseInt(value, 10);
            },
            getNumber: name => {
                const value = getArgument(name);
                return value === null ? null : Number(value);
            },
            getBoolean: name => {
                const value = getArgument(name);
                if (value === null) return null;
                return ["true", "yes", "sí", "si", "1"].includes(value.toLowerCase());
            },
            getUser: () => message.mentions.users.first() || null,
            getMember: () => message.mentions.members?.first() || null,
            getChannel: () => message.mentions.channels.first() || null,
            getRole: () => message.mentions.roles.first() || null
        },
        inGuild: () => Boolean(message.guild),
        reply: respond,
        followUp: respond,
        editReply: respond,
        deferReply: async () => {}
    };
}

module.exports = async (client, message) => {
    try {
        if (message.partial) await message.fetch();
        if (message.author.bot) return;

        if (message.guild) {
            await handleMessage(client, message);
        }

        if (!settings.messageContentCommands.status || !client.commands) return;

        const prefix = message.guild
            ? getPrefix(message.guild.id, settings.messageContentCommands.prefix)
            : settings.messageContentCommands.prefix;
        if (!prefix || !message.content.startsWith(prefix)) return;

        const args = message.content.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
        const commandName = args.shift()?.toLowerCase();
        if (!commandName) return;

        const legacyCommand = client.commands.get(commandName) ||
            client.commands.get(client.aliases.get(commandName));
        if (legacyCommand) {
            await legacyCommand.run(client, message, args);
            return;
        }

        const slashCommand = findSlashCommand(client, commandName);
        if (slashCommand) {
            await slashCommand.run(
                client,
                createPrefixInteraction(client, message, slashCommand, args)
            );
        }
    } catch (error) {
        logError("Message Event", "Unhandled error while processing a message.", error);
    }
}