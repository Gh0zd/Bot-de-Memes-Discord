const { ChannelType, MessageFlags } = require("discord.js");
const {
    isOwnerOrAdmin,
    getSelectedChannelId,
    getPanelCategory,
    getChannelPage,
    createPanel,
    sendStarboardTest
} = require("../../utils/memePanel");
const database = require("../../database/memeDatabase");

async function rejectUnauthorized(interaction) {
    const response = {
        content: "Solo el owner del servidor o usuarios con Administrador o Administrar servidor pueden usar este panel.",
        flags: MessageFlags.Ephemeral
    };
    if (interaction.replied || interaction.deferred) {
        await interaction.followUp(response);
    } else {
        await interaction.reply(response);
    }
}

async function handlePanelComponent(client, interaction) {
    if (!interaction.customId.startsWith("memes:")) return false;
    const isTestButton = interaction.isButton() &&
        interaction.customId === "memes:starboard:test";
    if (!interaction.inGuild()) {
        await interaction.reply({
            content: "Este panel solo funciona dentro de un servidor.",
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    if (isTestButton) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } else {
        await interaction.deferUpdate();
    }

    if (!isOwnerOrAdmin(interaction)) {
        await rejectUnauthorized(interaction);
        return true;
    }

    const guildId = interaction.guildId;
    if (isTestButton) {
        try {
            const testMessage = await sendStarboardTest(interaction.guild);
            await interaction.editReply({
                content: `✅ Prueba enviada a <#${testMessage.channelId}>. [Abrir mensaje de prueba](${testMessage.url})`
            });
        } catch (error) {
            console.error(`[Meme Dashboard] Starboard test failed in guild ${guildId}:`, error);
            await interaction.editReply({
                content: `❌ No se pudo enviar la prueba: ${error.message}`
            });
        }
        return true;
    }

    let category = getPanelCategory(interaction.message);
    let selectedChannelId = getSelectedChannelId(interaction.message);
    let page = getChannelPage(interaction.message);

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("memes:category:")) {
        category = interaction.values[0];
        page = 0;
        const starboard = database.getStarboardSettings(guildId);
        selectedChannelId = category === "memes"
            ? starboard.sourceChannelId
            : category === "starboard"
                ? starboard.destinationChannelId
                : null;
    } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith("memes:select-channel:")) {
        const channelSelect = interaction.customId.match(
            /^memes:select-channel:(memes|starboard):(\d+)(?::[0-9]+|:none)?$/
        );
        if (!channelSelect) {
            await interaction.followUp({
                content: "No se pudo identificar la categoría del canal seleccionado. Vuelve a abrir `/memes`.",
                flags: MessageFlags.Ephemeral
            });
            return true;
        }
        [, category, page] = channelSelect;
        page = Number(page);
        selectedChannelId = interaction.values[0];
        const selectedChannel = interaction.guild.channels.cache.get(selectedChannelId);
        if (!selectedChannel || ![
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement
        ].includes(selectedChannel.type)) {
            await interaction.followUp({
                content: "Ese canal ya no está disponible. Actualiza el panel y elige otro.",
                flags: MessageFlags.Ephemeral
            });
            return true;
        }
        database.setStarboardSetting(
            guildId,
            category === "memes" ? "sourceChannelId" : "destinationChannelId",
            selectedChannelId
        );
    } else if (interaction.isStringSelectMenu() && interaction.customId === "memes:starboard:emoji") {
        database.setStarboardSetting(guildId, "emoji", interaction.values[0]);
        category = "starboard";
    } else if (interaction.isButton()) {
        const channelAction = interaction.customId.match(
            /^memes:starboard:(source|destination):(\d+)$/
        );
        const pageAction = interaction.customId.match(
            /^memes:channels:(memes|starboard):(?:previous|next):(\d+)$/
        );
        const thresholdAction = interaction.customId.match(
            /^memes:starboard:threshold:(-?1)$/
        );

        if (interaction.customId === "memes:reactions:toggle") {
            const current = database.getStarboardSettings(guildId);
            database.setStarboardSetting(
                guildId,
                "autoReactionEnabled",
                !current.autoReactionEnabled
            );
            category = "memes";
        } else if (interaction.customId === "memes:social:toggle") {
            const current = database.getGuildSettings(guildId);
            database.setGuildSetting(guildId, "socialRelayEnabled", !current.socialRelayEnabled);
            category = "social";
        } else if (channelAction) {
            const [, setting, channelId] = channelAction;
            database.setStarboardSetting(
                guildId,
                setting === "source" ? "sourceChannelId" : "destinationChannelId",
                channelId
            );
            selectedChannelId = channelId;
            category = getPanelCategory(interaction.message);
        } else if (pageAction) {
            [, category, page] = pageAction;
            page = Number(page);
        } else if (interaction.customId === "memes:starboard:toggle") {
            const current = database.getStarboardSettings(guildId);
            database.setStarboardSetting(guildId, "enabled", !current.enabled);
            category = "starboard";
        } else if (thresholdAction) {
            const current = database.getStarboardSettings(guildId);
            database.setStarboardSetting(
                guildId,
                "threshold",
                Math.min(100, Math.max(1, current.threshold + Number(thresholdAction[1])))
            );
            category = "starboard";
        } else if (interaction.customId === "memes:reset:request") {
            const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
            const confirmEmbed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle("⚠️ ¿Borrar toda la configuración?")
                .setDescription([
                    "Esto restablecerá:",
                    "• Canal de memes y reacciones automáticas",
                    "• Reenvío de enlaces sociales",
                    "• Destacados (canal, umbral y emoji)",
                    "• Mensajes destacados guardados en la base de datos",
                    "",
                    "**No se puede deshacer.** Los webhooks del canal no se eliminan automáticamente."
                ].join("\n"));
            await interaction.editReply({
                embeds: [confirmEmbed],
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId("memes:reset:confirm")
                            .setLabel("Sí, borrar todo")
                            .setEmoji("🗑️")
                            .setStyle(ButtonStyle.Danger),
                        new ButtonBuilder()
                            .setCustomId("memes:reset:cancel")
                            .setLabel("Cancelar")
                            .setStyle(ButtonStyle.Secondary)
                    )
                ]
            });
            return true;
        } else if (interaction.customId === "memes:reset:confirm") {
            database.resetGuildConfiguration(guildId);
            category = "overview";
            selectedChannelId = null;
            page = 0;
        } else if (interaction.customId === "memes:reset:cancel") {
            category = "overview";
        }

        // Keep overview when using quick toggles from the summary panel
        if (
            getPanelCategory(interaction.message) === "overview" &&
            ["memes:reactions:toggle", "memes:social:toggle", "memes:starboard:toggle"].includes(
                interaction.customId
            )
        ) {
            category = "overview";
        }
    }

    await interaction.editReply(createPanel(interaction.guild, category, selectedChannelId, page));
    return true;
}

module.exports = async (client, interaction) => {
    try {
        if (
            (interaction.isButton() && interaction.customId.startsWith("memes:")) ||
            (interaction.isStringSelectMenu() && interaction.customId.startsWith("memes:"))
        ) {
            await handlePanelComponent(client, interaction);
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        const subcommand = interaction.options.getSubcommand(false);
        const commandKey = subcommand
            ? interaction.commandName + subcommand
            : "normal" + interaction.commandName;
        const command = client.slashCommands.get(commandKey);
        if (command) {
            await command.run(client, interaction);
        }
    } catch (error) {
        if (error.code === 10062 || error.code === 40060) return;
        console.error("[INTERACTION EVENT ERROR]", error);
        const response = {
            content: "Ocurrió un error al procesar esta interacción. Revisa los permisos y los registros del bot.",
            flags: MessageFlags.Ephemeral
        };
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(response).catch(replyError =>
                console.error("[INTERACTION ERROR RESPONSE]", replyError)
            );
        } else {
            await interaction.reply(response).catch(replyError =>
                console.error("[INTERACTION ERROR RESPONSE]", replyError)
            );
        }
    }
};
