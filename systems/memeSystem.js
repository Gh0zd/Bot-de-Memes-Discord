const { ChannelType, MessageFlags } = require("discord.js");
const database = require("../database/memeDatabase");
const {
    MediaUnavailableError,
    UploadLimitError,
    extractSocialUrl,
    findAndDownloadSocialMedia
} = require("./socialMedia");
const {
    cleanTrackedLinksInText,
    formatLinksAsMarkdown
} = require("../utils/socialLinkCleaner");
const { logError, logWarning } = require("../utils/logger");

const DEFAULT_MEME_REACTIONS = ["👍", "👎", "⚠️", "♻️"];
const WEBHOOK_NAME = "Meme Link Relay";
const webhookPromises = new Map();
const webhookCache = new Map();

// Per-user cooldown for social relay (ms). Prevents spam downloads on busy meme channels.
const RELAY_COOLDOWN_MS = Number(process.env.SOCIAL_RELAY_COOLDOWN_MS) || 15000;
const relayCooldowns = new Map();

function isOnRelayCooldown(userId) {
    const until = relayCooldowns.get(userId) || 0;
    if (Date.now() < until) return true;
    return false;
}

function markRelayCooldown(userId) {
    relayCooldowns.set(userId, Date.now() + RELAY_COOLDOWN_MS);
    // Opportunistic cleanup to avoid unbounded growth on large servers
    if (relayCooldowns.size > 500) {
        const now = Date.now();
        for (const [id, expiry] of relayCooldowns) {
            if (expiry <= now) relayCooldowns.delete(id);
        }
    }
}

async function addConfiguredReaction(message) {
    const settings = database.getStarboardSettings(message.guild.id);
    if (
        !settings.autoReactionEnabled ||
        settings.sourceChannelId !== message.channel.id
    ) {
        return;
    }

    const reactions = [...new Set([...DEFAULT_MEME_REACTIONS, settings.emoji])];
    for (const emoji of reactions) {
        try {
            await message.react(emoji);
            // Small delay to reduce Discord reaction rate-limit pressure
            await new Promise(resolve => setTimeout(resolve, 250));
        } catch (error) {
            // Unknown emoji — skip quietly
            if (error?.code === 10014) continue;
            logError(
                "Meme System",
                `Could not add reaction ${emoji} to message ${message.id}:`,
                error
            );
        }
    }
}

function isSupportedWebhookChannel(channel) {
    return channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.GuildAnnouncement;
}

async function getRelayWebhook(client, channel) {
    const cached = webhookCache.get(channel.id);
    if (cached) return cached;

    const pending = webhookPromises.get(channel.id);
    if (pending) return pending;

    const webhookPromise = (async () => {
        const savedWebhook = database.getWebhook(channel.id);
        if (savedWebhook) {
            try {
                const webhook = await client.fetchWebhook(savedWebhook.id, savedWebhook.token);
                webhookCache.set(channel.id, webhook);
                return webhook;
            } catch (error) {
                if (error.code !== 10015 && error.status !== 404) throw error;
                database.removeWebhook(channel.id);
            }
        }

        const existingWebhooks = await channel.fetchWebhooks();
        const existingWebhook = existingWebhooks.find(webhook =>
            webhook.owner?.id === client.user.id && webhook.token
        );

        let webhook = existingWebhook;
        if (!webhook) {
            webhook = await channel.createWebhook({
                name: WEBHOOK_NAME,
                avatar: client.user.displayAvatarURL()
            });
        }

        database.saveWebhook(channel.id, webhook.id, webhook.token);
        webhookCache.set(channel.id, webhook);
        return webhook;
    })();

    webhookPromises.set(channel.id, webhookPromise);
    try {
        return await webhookPromise;
    } finally {
        webhookPromises.delete(channel.id);
    }
}

async function replyWithError(message, content) {
    try {
        await message.reply({ content, allowedMentions: { repliedUser: false } });
    } catch (error) {
        logError("Meme System", `Could not send an error notice for message ${message.id}:`, error);
    }
}

function formatMegabytes(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB (${bytes} bytes)`;
}

async function relaySocialMessage(client, message) {
    const starboardSettings = database.getStarboardSettings(message.guild.id);
    if (starboardSettings.sourceChannelId !== message.channel.id) return null;

    const cleanedMessage = cleanTrackedLinksInText(message.content);
    const relayContent = cleanedMessage.content;
    if (!extractSocialUrl(relayContent)) return null;

    if (!isSupportedWebhookChannel(message.channel)) {
        logError(
            "Meme System",
            `Cannot relay social media from channel ${message.channel.id}: channel type does not support webhooks.`
        );
        return null;
    }

    // Skip if the message already includes video/image files — nothing to download.
    const hasMediaAttachment = message.attachments.some(att => {
        const type = (att.contentType || "").toLowerCase();
        return type.startsWith("video/") || type.startsWith("image/");
    });
    if (hasMediaAttachment) return null;

    if (isOnRelayCooldown(message.author.id)) {
        await replyWithError(
            message,
            `⏳ Espera unos segundos antes de reenviar otro enlace (anti-spam).`
        );
        return null;
    }
    markRelayCooldown(message.author.id);

    let media;
    try {
        media = await findAndDownloadSocialMedia(relayContent, message.guild);
    } catch (error) {
        if (error instanceof UploadLimitError) {
            const notice = `⚠️ No se pudo subir el archivo porque pesa ${formatMegabytes(error.size)} y el límite de este servidor es ${formatMegabytes(error.limit)}.`;
            await replyWithError(message, notice);
            return null;
        }

        logError("Meme System", `Social media download failed for message ${message.id}:`, error);
        if (error instanceof MediaUnavailableError) {
            await replyWithError(
                message,
                "No se pudo descargar el video de esta plataforma. Puede ser privado, requerir inicio de sesión o no estar disponible para yt-dlp. El mensaje original se conservó."
            );
            return null;
        }
        await replyWithError(
            message,
            "No se pudo descargar el contenido multimedia. El mensaje original se conservó; revisa la consola para ver el error."
        );
        return null;
    }

    if (!media) return null;
    if (relayContent.length > 2000) {
        await replyWithError(
            message,
            "No se pudo reenviar este contenido porque el texto supera el límite de Discord. El mensaje original se conservó."
        );
        return null;
    }

    let forwardedMessage;
    try {
        const webhook = await getRelayWebhook(client, message.channel);
        forwardedMessage = await webhook.send({
            content: formatLinksAsMarkdown(relayContent),
            username: (message.author.globalName || message.author.username).slice(0, 80),
            avatarURL: message.author.displayAvatarURL({ size: 256 }),
            files: [{
                attachment: media.buffer,
                name: media.filename
            }],
            flags: MessageFlags.SuppressEmbeds,
            allowedMentions: { parse: [] },
            wait: true
        });
    } catch (error) {
        logError("Meme System", `Webhook upload failed for message ${message.id}:`, error);
        await replyWithError(
            message,
            "No se pudo subir el archivo al canal. El mensaje original se conservó; revisa la consola para ver el error."
        );
        return null;
    }

    try {
        await message.delete();
    } catch (error) {
        if (error.code === 50013) {
            logWarning(
                "Meme System",
                `Webhook relay succeeded, but the bot cannot delete source message ${message.id}. Grant Manage Messages in channel ${message.channel.id}.`
            );
            await replyWithError(
                message,
                "El contenido se reenvió, pero no pude borrar el mensaje original. Dale al bot el permiso **Administrar mensajes** en este canal."
            );
        } else if (error.code !== 10008) {
            logError("Meme System", `Could not delete relayed source message ${message.id}:`, error);
        }
    }
    return forwardedMessage;
}

async function handleMessage(client, message) {
    if (!message.guild || message.author.bot) return;

    const settings = database.getGuildSettings(message.guild.id);
    const starboardSettings = database.getStarboardSettings(message.guild.id);
    let reactionTarget = message;

    if (
        settings.socialRelayEnabled &&
        starboardSettings.sourceChannelId === message.channel.id
    ) {
        const forwardedMessage = await relaySocialMessage(client, message);
        if (forwardedMessage) reactionTarget = forwardedMessage;
    }

    await addConfiguredReaction(reactionTarget);
}

module.exports = {
    handleMessage,
    relaySocialMessage
};
