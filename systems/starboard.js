const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder
} = require("discord.js");
const database = require("../database/memeDatabase");
const { logError } = require("../utils/logger");

const activeUpdates = new Map();
const debounceTimers = new Map();
const DEBOUNCE_MS = Number(process.env.STARBOARD_DEBOUNCE_MS) || 1500;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv", ".ogv"]);

function getEmojiKey(emoji) {
    return emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
}

async function countHumanVoters(reaction) {
    const voterIds = new Set();
    let after;

    while (true) {
        const users = await reaction.users.fetch({ limit: 100, after });
        for (const user of users.values()) {
            if (!user.bot) voterIds.add(user.id);
        }

        if (users.size < 100) break;
        const nextAfter = users.lastKey();
        if (!nextAfter || nextAfter === after) break;
        after = nextAfter;
    }

    return voterIds.size;
}

function buildStarboardEmbed(message, color) {
    const authorName = message.member?.displayName || message.author.globalName || message.author.username;
    const authorAvatar = message.author.displayAvatarURL({ size: 256 });
    const embed = new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: authorName, iconURL: authorAvatar })
        .setTimestamp(message.createdAt);

    const descriptionParts = [];
    if (message.content) descriptionParts.push(message.content.slice(0, 4000));

    let imageUrl;
    for (const attachment of message.attachments.values()) {
        const filename = attachment.name || "";
        const extension = filename.includes(".")
            ? filename.slice(filename.lastIndexOf(".")).toLowerCase()
            : "";
        const contentType = (attachment.contentType || "").toLowerCase();
        if (!imageUrl && (contentType.startsWith("image/") || IMAGE_EXTENSIONS.has(extension))) {
            imageUrl = attachment.url;
        } else if (contentType.startsWith("video/") || VIDEO_EXTENSIONS.has(extension)) {
            descriptionParts.push(`[Ver video adjunto](${attachment.url})`);
        }
    }

    embed.setDescription(descriptionParts.join("\n\n").slice(0, 4096) || " ");
    if (imageUrl) embed.setImage(imageUrl);
    return embed;
}

function createStarboardComponents(emoji, count, sourceMessageUrl) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("starboard:vote-count")
                .setLabel(`${emoji} ${count}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            new ButtonBuilder()
                .setLabel("Ir al mensaje")
                .setStyle(ButtonStyle.Link)
                .setURL(sourceMessageUrl)
        )
    ];
}

async function fetchDestinationChannel(guild, channelId) {
    const channel = await guild.channels.fetch(channelId);
    if (!channel || ![
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement
    ].includes(channel.type)) {
        throw new Error(`Configured starboard channel ${channelId} is missing or is not a text channel.`);
    }
    return channel;
}

async function publishOrUpdateStarboard(message, count, settings) {
    const existing = database.getStarboardMessage(message.id);
    const destinationChannelId = existing?.destinationChannelId || settings.destinationChannelId;
    if (!destinationChannelId) {
        throw new Error(`No destination channel configured for starboard in guild ${message.guild.id}.`);
    }

    const destination = await fetchDestinationChannel(message.guild, destinationChannelId);
    const embedColor = existing?.embedColor ?? Math.floor(Math.random() * 0x1000000);
    const header = `${settings.emoji} ${count} · #${message.channel.name}`;
    const embed = buildStarboardEmbed(message, embedColor);
    const components = createStarboardComponents(settings.emoji, count, message.url);

    if (existing) {
        try {
            const featured = await destination.messages.fetch(existing.destinationMessageId);
            await featured.edit({
                content: header,
                embeds: [embed],
                components,
                allowedMentions: { parse: [] }
            });
            return;
        } catch (error) {
            if (error.code !== 10008 && error.code !== 10003) throw error;
            logError(
                "Starboard",
                `Existing highlight ${existing.destinationMessageId} is unavailable; creating a replacement.`,
                error
            );
        }
    }

    const featured = await destination.send({
        content: header,
        embeds: [embed],
        components,
        allowedMentions: { parse: [] }
    });
    database.saveStarboardMessage({
        sourceMessageId: message.id,
        guildId: message.guild.id,
        sourceChannelId: message.channel.id,
        destinationChannelId: destination.id,
        destinationMessageId: featured.id,
        embedColor
    });
}

async function updateStarboardFromReaction(reaction, user, removed = false) {
    if (user?.bot) return;

    const message = reaction.message.partial
        ? await reaction.message.fetch()
        : reaction.message;
    if (!message.guild) return;

    const settings = database.getStarboardSettings(message.guild.id);
    if (
        !settings.enabled ||
        !settings.sourceChannelId ||
        settings.sourceChannelId !== message.channel.id ||
        getEmojiKey(reaction.emoji) !== settings.emoji
    ) {
        return;
    }

    let currentReaction = reaction;
    if (reaction.partial) {
        try {
            currentReaction = await reaction.fetch();
        } catch (error) {
            if (!removed) throw error;
            currentReaction = message.reactions.cache.find(
                item => getEmojiKey(item.emoji) === settings.emoji
            );
        }
    } else {
        currentReaction = message.reactions.cache.find(
            item => getEmojiKey(item.emoji) === settings.emoji
        );
    }

    const count = currentReaction ? await countHumanVoters(currentReaction) : 0;
    if (count < settings.threshold && !database.getStarboardMessage(message.id)) {
        return;
    }

    await publishOrUpdateStarboard(message, count, settings);
}

function queueStarboardUpdate(reaction, user, removed = false) {
    const messageId = reaction.message.id;

    // Debounce rapid reaction spam: wait until votes settle before recounting users.
    const existingTimer = debounceTimers.get(messageId);
    if (existingTimer) clearTimeout(existingTimer);

    return new Promise(resolve => {
        const timer = setTimeout(() => {
            debounceTimers.delete(messageId);
            const previous = activeUpdates.get(messageId) || Promise.resolve();
            const next = previous
                .catch(error => logError("Starboard", `Previous update failed for ${messageId}:`, error))
                .then(() => updateStarboardFromReaction(reaction, user, removed))
                .catch(error => logError("Starboard", `Could not update message ${messageId}:`, error))
                .finally(() => {
                    if (activeUpdates.get(messageId) === next) activeUpdates.delete(messageId);
                });
            activeUpdates.set(messageId, next);
            resolve(next);
        }, DEBOUNCE_MS);
        debounceTimers.set(messageId, timer);
    });
}

async function updateAfterAllReactionsRemoved(message) {
    const sourceMessage = message.partial ? await message.fetch() : message;
    if (!sourceMessage.guild) return;
    const settings = database.getStarboardSettings(sourceMessage.guild.id);
    if (!settings.enabled || settings.sourceChannelId !== sourceMessage.channel.id) return;
    if (!database.getStarboardMessage(sourceMessage.id)) return;
    await publishOrUpdateStarboard(sourceMessage, 0, settings);
}

module.exports = {
    queueStarboardUpdate,
    updateAfterAllReactionsRemoved
};
