const settings = require("../../settings.json");
const { canManagePrefix, getPrefix, setPrefix } = require("../../systems/prefixSettings");

module.exports = {
    name: "prefix",
    aliases: ["prefijo"],
    run: async (client, message, args) => {
        if (!message.guild) {
            return message.reply("Este comando solo se puede usar dentro de un servidor.");
        }

        if (!canManagePrefix(message.guild, message.author.id, message.member?.permissions)) {
            return message.reply("Solo el owner del servidor o quienes tengan Administrador o Administrar servidor pueden cambiar el prefijo.");
        }

        const currentPrefix = getPrefix(message.guild.id, settings.messageContentCommands.prefix);
        const requestedPrefix = args[0];
        if (!requestedPrefix) {
            return message.reply(`El prefijo de este servidor es \`${currentPrefix}\`. Para cambiarlo: \`${currentPrefix}prefix <nuevo>\`.`);
        }

        try {
            const newPrefix = setPrefix(message.guild.id, requestedPrefix);
            return message.reply(`✅ Prefijo actualizado a \`${newPrefix}\`.`);
        } catch (error) {
            if (error instanceof TypeError) {
                return message.reply("El prefijo debe tener entre 1 y 5 caracteres, sin espacios.");
            }
            throw error;
        }
    }
};
