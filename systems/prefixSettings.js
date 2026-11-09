const { PermissionsBitField } = require("discord.js");
const database = require("../database/memeDatabase");

function canManagePrefix(guild, userId, permissions) {
    return guild?.ownerId === userId || Boolean(
        permissions?.has(PermissionsBitField.Flags.Administrator) ||
        permissions?.has(PermissionsBitField.Flags.ManageGuild)
    );
}

function getPrefix(guildId, defaultPrefix) {
    return database.getGuildPrefix(guildId, defaultPrefix);
}

function setPrefix(guildId, prefix) {
    const normalizedPrefix = prefix.trim();
    database.setGuildPrefix(guildId, normalizedPrefix);
    return normalizedPrefix;
}

module.exports = {
    canManagePrefix,
    getPrefix,
    setPrefix
};
