const { isOwnerOrAdmin, createPanel } = require("../../utils/memePanel");

module.exports = {
    name: "memes",
    aliases: ["meme"],
    run: async (client, message) => {
        if (!message.guild) {
            return message.reply("Este comando solo se puede usar dentro de un servidor.");
        }

        const memberPermissions = message.member?.permissions;
        if (!isOwnerOrAdmin({
            guild: message.guild,
            user: message.author,
            memberPermissions
        })) {
            return message.reply(
                "Solo el owner del servidor o usuarios con Administrador o Administrar servidor pueden usar este panel."
            );
        }

        return message.reply({
            ...createPanel(message.guild, "memes"),
            allowedMentions: { repliedUser: false }
        });
    }
};
