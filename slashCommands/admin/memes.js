const { MessageFlags } = require("discord.js");
const { isOwnerOrAdmin, createPanel } = require("../../utils/memePanel");

module.exports = {
    name: "memes",
    description: "Abre el panel de memes y mensajes destacados",
    options: [],
    run: async (client, interaction) => {
        if (!interaction.inGuild()) {
            return interaction.reply({
                content: "Este comando solo se puede usar dentro de un servidor.",
                flags: MessageFlags.Ephemeral
            });
        }

        if (!isOwnerOrAdmin(interaction)) {
            return interaction.reply({
                content: "Solo el owner del servidor o usuarios con Administrador o Administrar servidor pueden usar este panel.",
                flags: MessageFlags.Ephemeral
            });
        }

        return interaction.reply({
            ...createPanel(interaction.guild, "memes"),
            flags: MessageFlags.Ephemeral
        });
    }
};
