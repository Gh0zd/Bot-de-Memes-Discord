const { MessageFlags } = require("discord.js");
const settings = require("../../settings.json");
const { canManagePrefix, getPrefix, setPrefix } = require("../../systems/prefixSettings");

module.exports = {
    name: "prefix",
    description: "Consulta o cambia el prefijo del servidor",
    options: [
        {
            name: "value",
            description: "Nuevo prefijo (de 1 a 5 caracteres, sin espacios)",
            type: "String",
            required: false
        }
    ],
    run: async (client, interaction) => {
        if (!interaction.inGuild()) {
            return interaction.reply({
                content: "Este comando solo se puede usar dentro de un servidor.",
                flags: MessageFlags.Ephemeral
            });
        }

        if (!canManagePrefix(
            interaction.guild,
            interaction.user.id,
            interaction.memberPermissions
        )) {
            return interaction.reply({
                content: "Solo el owner del servidor o quienes tengan Administrador o Administrar servidor pueden cambiar el prefijo.",
                flags: MessageFlags.Ephemeral
            });
        }

        const currentPrefix = getPrefix(
            interaction.guildId,
            settings.messageContentCommands.prefix
        );
        const requestedPrefix = interaction.options.getString("value");
        if (!requestedPrefix) {
            return interaction.reply({
                content: `El prefijo de este servidor es \`${currentPrefix}\`. Para cambiarlo, usa \`/prefix value:<nuevo>\`.`,
                flags: MessageFlags.Ephemeral
            });
        }

        try {
            const newPrefix = setPrefix(interaction.guildId, requestedPrefix);
            return interaction.reply({
                content: `✅ Prefijo actualizado a \`${newPrefix}\`.`,
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            if (error instanceof TypeError) {
                return interaction.reply({
                    content: "El prefijo debe tener entre 1 y 5 caracteres, sin espacios.",
                    flags: MessageFlags.Ephemeral
                });
            }
            throw error;
        }
    }
};
