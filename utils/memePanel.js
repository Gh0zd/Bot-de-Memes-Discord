const fs = require("node:fs");
const path = require("node:path");
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    PermissionsBitField,
    StringSelectMenuBuilder
} = require("discord.js");
const database = require("../database/memeDatabase");

const STARBOARD_EMOJIS = ["⭐", "🔥", "❤️", "😂"];
const MEME_REACTIONS = ["👍", "👎", "⚠️", "♻️"];
const CATEGORIES = [
    { label: "Resumen", value: "overview", emoji: "🏠", description: "Estado general y accesos rápidos" },
    { label: "Memes", value: "memes", emoji: "😂", description: "Canal y reacciones automáticas" },
    { label: "Enlaces sociales", value: "social", emoji: "🔗", description: "Activar o pausar el reenvío" },
    { label: "Destacados", value: "starboard", emoji: "🌟", description: "Canal, votos y emoji de destacados" }
];
const TEST_IMAGE = path.join(__dirname, "..", "assets", "starboard-preview.jpg");

function isOwnerOrAdmin(interaction) {
    if (interaction.guild?.ownerId === interaction.user.id) return true;
    const permissions = interaction.memberPermissions;
    return Boolean(
        permissions?.has(PermissionsBitField.Flags.Administrator) ||
        permissions?.has(PermissionsBitField.Flags.ManageGuild)
    );
}

function getSelectedChannelId(message) {
    for (const row of message.components) {
        for (const component of row.components) {
            const isChannelSelect = component.customId?.startsWith("memes:select-channel:");
            const selectedOption = isChannelSelect
                ? component.options?.find(option => option.default)
                : null;
            if (selectedOption) return selectedOption.value;
            const selectMatch = component.customId?.match(
                /^memes:select-channel:(?:memes|starboard):\d+:([0-9]+|none)$/
            );
            if (selectMatch && selectMatch[1] !== "none") return selectMatch[1];
        }
    }
    for (const row of message.components) {
        for (const component of row.components) {
            const match = component.customId?.match(/^memes:starboard:(?:source|destination):(\d+)$/);
            if (match) return match[1];
        }
    }
    return null;
}

function getPanelCategory(message) {
    for (const row of message.components) {
        for (const component of row.components) {
            const match = component.customId?.match(/^memes:category:(overview|memes|social|starboard)$/);
            if (match) return match[1];
        }
    }
    return "overview";
}

function getChannelPage(message) {
    for (const row of message.components) {
        for (const component of row.components) {
            const match = component.customId?.match(
                /^memes:select-channel:(?:memes|starboard):(\d+)(?::[0-9]+|:none)?$/
            );
            if (match) return Number(match[1]);
        }
    }
    return 0;
}

function createCategoryRow(category) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`memes:category:${category}`)
            .setPlaceholder("Selecciona qué quieres configurar")
            .addOptions(CATEGORIES.map(option => ({
                label: option.label,
                value: option.value,
                emoji: option.emoji,
                description: option.description,
                default: category === option.value
            })))
    );
}

function getTextChannels(guild) {
    return [...guild.channels.cache.values()]
        .filter(channel =>
            channel.type === ChannelType.GuildText ||
            channel.type === ChannelType.GuildAnnouncement
        )
        .sort((left, right) => left.name.localeCompare(right.name));
}

function createChannelSelect(channels, page, selectedChannelId, category, starboard) {
    const pageCount = Math.max(1, Math.ceil(channels.length / 25));
    const channelOptions = channels.slice(page * 25, (page + 1) * 25);
    const select = new StringSelectMenuBuilder()
        .setCustomId(`memes:select-channel:${category}:${page}:${selectedChannelId || "none"}`)
        .setPlaceholder(category === "memes"
            ? "Elige el canal donde se publican los memes"
            : "Elige dónde se publicarán los destacados")
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(channelOptions.length === 0)
        .addOptions(channelOptions.length
            ? channelOptions.map(channel => ({
                label: channel.name.slice(0, 100),
                value: channel.id,
                description: channel.id === starboard?.sourceChannelId
                    ? "Canal de memes actual"
                    : channel.id === starboard?.destinationChannelId
                        ? "Canal de destacados actual"
                        : `#${channel.name}`.slice(0, 100),
                default: channel.id === selectedChannelId
            }))
            : [{ label: "No hay canales de texto", value: "none" }]);
    const rows = [new ActionRowBuilder().addComponents(select)];

    if (pageCount > 1) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`memes:channels:${category}:previous:${Math.max(0, page - 1)}`)
                .setLabel("Canales anteriores")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId(`memes:channels:${category}:next:${Math.min(pageCount - 1, page + 1)}`)
                .setLabel("Más canales")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page >= pageCount - 1)
        ));
    }

    return { rows, pageCount };
}

function createPanel(guild, category = "overview", selectedChannelId = null, requestedPage = 0) {
    const settings = database.getGuildSettings(guild.id);
    const starboard = database.getStarboardSettings(guild.id);
    const channels = getTextChannels(guild);
    const pageCount = Math.max(1, Math.ceil(channels.length / 25));
    const page = Math.min(Math.max(requestedPage, 0), pageCount - 1);
    if (!selectedChannelId && category === "memes") {
        selectedChannelId = starboard.sourceChannelId;
    } else if (!selectedChannelId && category === "starboard") {
        selectedChannelId = starboard.destinationChannelId;
    }
    const selectedChannel = selectedChannelId ? guild.channels.cache.get(selectedChannelId) : null;
    const autoReactionIsActive = Boolean(
        starboard.autoReactionEnabled &&
        starboard.sourceChannelId &&
        starboard.emoji
    );
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("🎛️ Panel de memes")
        .setDescription("Configura cada función por separado usando el menú de categorías. Los cambios se guardan automáticamente.");
    const components = [createCategoryRow(category)];

    if (category === "overview") {
        embed
            .setDescription("Resumen de la configuración actual. Usa el menú para entrar en cada categoría o los botones de abajo para acciones rápidas.")
            .addFields(
            {
                name: "😂 Canal de memes",
                value: autoReactionIsActive
                    ? `Reacciones ${MEME_REACTIONS.join(" ")} ${starboard.emoji} en <#${starboard.sourceChannelId}>`
                    : `Automáticas **${starboard.autoReactionEnabled ? "activadas" : "pausadas"}**. Asigna un canal en la categoría Memes.`,
                inline: false
            },
            {
                name: "🔗 Enlaces sociales",
                value: settings.socialRelayEnabled ? "✅ Activado" : "⏸️ Desactivado",
                inline: true
            },
            {
                name: "🌟 Destacados",
                value: starboard.enabled
                    ? "✅ Activado"
                    : starboard.sourceChannelId && starboard.destinationChannelId
                        ? "⏸️ Desactivado"
                        : "⏸️ Asigna primero los canales en Memes y Destacados",
                inline: true
            },
            {
                name: "Detalles de destacados",
                value: [
                    `Canal origen: ${starboard.sourceChannelId ? `<#${starboard.sourceChannelId}>` : "*sin configurar*"}`,
                    `Canal destino: ${starboard.destinationChannelId ? `<#${starboard.destinationChannelId}>` : "*sin configurar*"}`,
                    `Mínimo: **${starboard.threshold}** votos con ${starboard.emoji}`
                ].join("\n"),
                inline: false
            }
        );
        embed.setFooter({ text: "Elige una categoría para ver o cambiar sus opciones." });

        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("memes:reactions:toggle")
                .setLabel(starboard.autoReactionEnabled ? "Pausar reacciones" : "Activar reacciones")
                .setEmoji(starboard.autoReactionEnabled ? "⏸️" : "▶️")
                .setStyle(starboard.autoReactionEnabled ? ButtonStyle.Secondary : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId("memes:social:toggle")
                .setLabel(settings.socialRelayEnabled ? "Pausar enlaces" : "Activar enlaces")
                .setEmoji("🔗")
                .setStyle(settings.socialRelayEnabled ? ButtonStyle.Secondary : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId("memes:starboard:toggle")
                .setLabel(starboard.enabled ? "Pausar destacados" : "Activar destacados")
                .setEmoji("🌟")
                .setStyle(starboard.enabled ? ButtonStyle.Secondary : ButtonStyle.Success)
                .setDisabled(
                    !starboard.enabled &&
                    (!starboard.sourceChannelId || !starboard.destinationChannelId)
                )
        ));
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("memes:reset:request")
                .setLabel("Borrar toda la configuración")
                .setEmoji("🗑️")
                .setStyle(ButtonStyle.Danger)
        ));
    } else if (category === "memes") {
        embed.setTitle("😂 Configuración del canal de memes")
            .setDescription([
                !starboard.autoReactionEnabled
                    ? `Las reacciones están pausadas. Al activarlas, el bot agregará ${MEME_REACTIONS.join(" ")} y **${starboard.emoji}** al canal de memes.`
                    : starboard.sourceChannelId
                        ? `El bot agrega ${MEME_REACTIONS.join(" ")} y **${starboard.emoji}** a cada mensaje nuevo de <#${starboard.sourceChannelId}>.`
                        : `Elige el canal de memes para que el bot agregue ${MEME_REACTIONS.join(" ")} y **${starboard.emoji}** a cada mensaje nuevo.`,
                `El emoji ${starboard.emoji} también cuenta como voto para destacados. Si lo cambias en esa categoría, los mensajes nuevos usarán el emoji actualizado.`,
                selectedChannel
                    ? `Canal actual: <#${selectedChannel.id}>. Si eliges otro, se guardará automáticamente.`
                    : "Elige un canal de texto abajo; se guardará automáticamente."
            ].join("\n\n"))
            .addFields({
                name: "Reacciones que se agregarán",
                value: MEME_REACTIONS.join("  "),
                inline: true
            }, {
                name: "Emoji para destacados",
                value: starboard.emoji,
                inline: true
            }, {
                name: "¿Qué significa cada reacción?",
                value: [
                    "👍 Like",
                    "👎 No me gusta",
                    "⚠️ Advertencia: gemidos o audio sugerente",
                    "♻️ Meme repetido"
                ].join("\n"),
                inline: false
            }, {
                name: "Estado",
                value: starboard.autoReactionEnabled
                    ? autoReactionIsActive ? "✅ Activadas" : "✅ Activadas; falta elegir el canal de memes."
                    : "⏸️ Pausadas",
                inline: false
            });
        const channelControls = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("memes:reactions:toggle")
                .setLabel(starboard.autoReactionEnabled
                    ? "Pausar reacciones"
                    : "Activar reacciones")
                .setStyle(starboard.autoReactionEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
                .setDisabled(!starboard.autoReactionEnabled && !starboard.sourceChannelId)
        );
        const channelMenu = createChannelSelect(channels, page, selectedChannelId, category, starboard);
        components.push(...channelMenu.rows, channelControls);
        if (channelMenu.pageCount > 1) {
            embed.setFooter({ text: `Página ${page + 1} de ${channelMenu.pageCount}.` });
        }
    } else if (category === "social") {
        embed.setTitle("🔗 Reenvío de enlaces sociales")
            .setDescription("Al activarlo, los enlaces compatibles de TikTok, Instagram y X/Twitter se procesan y reenvían con el nombre y avatar de quien los publicó.")
            .addFields({
                name: "Estado",
                value: settings.socialRelayEnabled ? "✅ Activado" : "⏸️ Desactivado",
                inline: true
            }, {
                name: "Archivos",
                value: "Solo imágenes y videos compatibles; el límite se determina automáticamente por el nivel de boost.",
                inline: true
            });
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("memes:social:toggle")
                .setLabel(settings.socialRelayEnabled ? "Pausar reenvío" : "Activar reenvío")
                .setStyle(settings.socialRelayEnabled ? ButtonStyle.Secondary : ButtonStyle.Success)
        ));
    } else if (category === "starboard") {
        embed.setTitle("🌟 Mensajes destacados")
            .setDescription([
                `**Canal de destacados (donde se publican):** ${starboard.destinationChannelId ? `<#${starboard.destinationChannelId}>` : "sin asignar"}`,
                `**Mínimo:** ${starboard.threshold} votos con ${starboard.emoji}.`,
                `El canal de memes donde se agregan reacciones se configura en la categoría **Memes** (${starboard.sourceChannelId ? `<#${starboard.sourceChannelId}>` : "sin configurar"}).`,
                selectedChannel
                    ? `Canal actual: <#${selectedChannel.id}>. Si eliges otro abajo, se guardará automáticamente.`
                    : "Elige un canal abajo; se guardará automáticamente."
            ].join("\n\n"));

        const channelMenu = createChannelSelect(
            channels,
            page,
            selectedChannelId,
            category,
            starboard
        );
        const testButton = new ButtonBuilder()
            .setCustomId("memes:starboard:test")
            .setLabel("Enviar prueba al canal destacado")
            .setEmoji("🧪")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!starboard.destinationChannelId);
        components.push(...channelMenu.rows);
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("memes:starboard:toggle")
                .setLabel(starboard.enabled ? "Pausar destacados" : "Activar destacados")
                .setStyle(starboard.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
                .setDisabled(
                    !starboard.enabled &&
                    (!starboard.sourceChannelId || !starboard.destinationChannelId)
                ),
            new ButtonBuilder()
                .setCustomId("memes:starboard:threshold:-1")
                .setLabel("− 1 voto")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(starboard.threshold <= 1),
            new ButtonBuilder()
                .setCustomId("memes:starboard:threshold:1")
                .setLabel("+ 1 voto")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(starboard.threshold >= 100),
            testButton
        ));
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId("memes:starboard:emoji")
                .setPlaceholder(`Emoji de voto actual: ${starboard.emoji}`)
                .addOptions(STARBOARD_EMOJIS.map(emoji => ({
                    label: emoji,
                    value: emoji,
                    emoji,
                    default: starboard.emoji === emoji
                })))
        ));
        if (channelMenu.pageCount > 1) {
            embed.setFooter({ text: `Página ${page + 1} de ${channelMenu.pageCount}.` });
        }
    }

    return { embeds: [embed], components };
}

async function sendStarboardTest(guild) {
    const settings = database.getStarboardSettings(guild.id);
    if (!settings.destinationChannelId) {
        throw new Error("Primero configura el canal de destacados.");
    }
    if (!fs.existsSync(TEST_IMAGE)) {
        throw new Error(`No se encontró la imagen de prueba: ${TEST_IMAGE}`);
    }

    const destination = await guild.channels.fetch(settings.destinationChannelId);
    if (!destination || ![
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement
    ].includes(destination.type)) {
        throw new Error("El canal de destacados ya no existe o no es un canal de texto.");
    }
    const source = settings.sourceChannelId
        ? guild.channels.cache.get(settings.sourceChannelId)
        : null;
    const header = `🧪 **PRUEBA** · ${settings.emoji} ${settings.threshold} · ${source ? `#${source.name}` : "canal de memes sin configurar"}`;
    const embed = new EmbedBuilder()
        .setColor(Math.floor(Math.random() * 0x1000000))
        .setAuthor({
            name: "Prueba de configuración",
            iconURL: guild.client.user.displayAvatarURL({ size: 128 })
        })
        .setDescription("Esta publicación de prueba verifica que el bot pueda enviar destacados a este canal. Puedes eliminarla cuando quieras.")
        .setImage("attachment://starboard-preview.jpg")
        .setTimestamp();
    const buttons = [
        new ButtonBuilder()
            .setCustomId("memes:starboard:test-count")
            .setLabel(`${settings.emoji} ${settings.threshold}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
    ];

    if (source) {
        buttons.push(new ButtonBuilder()
            .setLabel("Abrir canal vigilado")
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/channels/${guild.id}/${source.id}`));
    }

    return destination.send({
        content: header,
        embeds: [embed],
        files: [{ attachment: TEST_IMAGE, name: "starboard-preview.jpg" }],
        components: [new ActionRowBuilder().addComponents(buttons)],
        allowedMentions: { parse: [] }
    });
}

module.exports = {
    isOwnerOrAdmin,
    getSelectedChannelId,
    getPanelCategory,
    getChannelPage,
    createPanel,
    sendStarboardTest
};
