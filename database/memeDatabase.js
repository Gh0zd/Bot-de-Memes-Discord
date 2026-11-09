const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const dataDirectory = path.join(process.cwd(), "data");
fs.mkdirSync(dataDirectory, { recursive: true });

const database = new Database(path.join(dataDirectory, "meme-system.sqlite"));
database.pragma("journal_mode = WAL");
database.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        social_relay_enabled INTEGER NOT NULL DEFAULT 0,
        prefix TEXT
    );

    CREATE TABLE IF NOT EXISTS channel_webhooks (
        channel_id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        webhook_token TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS starboard_settings (
        guild_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        auto_reaction_enabled INTEGER NOT NULL DEFAULT 1,
        source_channel_id TEXT,
        destination_channel_id TEXT,
        threshold INTEGER NOT NULL DEFAULT 5,
        emoji TEXT NOT NULL DEFAULT '⭐',
        PRIMARY KEY (guild_id)
    );

    CREATE TABLE IF NOT EXISTS starboard_messages (
        source_message_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        source_channel_id TEXT NOT NULL,
        destination_channel_id TEXT NOT NULL,
        destination_message_id TEXT NOT NULL,
        embed_color INTEGER NOT NULL
    );
`);

const starboardColumns = new Set(
    database.pragma("table_info(starboard_settings)").map(column => column.name)
);
const guildSettingColumns = new Set(
    database.pragma("table_info(guild_settings)").map(column => column.name)
);
if (!guildSettingColumns.has("prefix")) {
    database.exec("ALTER TABLE guild_settings ADD COLUMN prefix TEXT");
}
if (!starboardColumns.has("auto_reaction_enabled")) {
    database.exec(
        "ALTER TABLE starboard_settings ADD COLUMN auto_reaction_enabled INTEGER NOT NULL DEFAULT 1"
    );
}

const insertGuild = database.prepare(
    "INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)"
);
const selectGuild = database.prepare(
    "SELECT social_relay_enabled FROM guild_settings WHERE guild_id = ?"
);
const selectWebhook = database.prepare(
    "SELECT webhook_id, webhook_token FROM channel_webhooks WHERE channel_id = ?"
);
const upsertWebhook = database.prepare(`
    INSERT INTO channel_webhooks (channel_id, webhook_id, webhook_token)
    VALUES (?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
        webhook_id = excluded.webhook_id,
        webhook_token = excluded.webhook_token
`);
const deleteWebhook = database.prepare(
    "DELETE FROM channel_webhooks WHERE channel_id = ?"
);
const insertStarboardSettings = database.prepare(
    "INSERT OR IGNORE INTO starboard_settings (guild_id) VALUES (?)"
);
const selectStarboardSettings = database.prepare(
    "SELECT enabled, auto_reaction_enabled, source_channel_id, destination_channel_id, threshold, emoji FROM starboard_settings WHERE guild_id = ?"
);
const selectStarboardMessage = database.prepare(
    "SELECT source_message_id, guild_id, source_channel_id, destination_channel_id, destination_message_id, embed_color FROM starboard_messages WHERE source_message_id = ?"
);
const upsertStarboardMessage = database.prepare(`
    INSERT INTO starboard_messages (
        source_message_id, guild_id, source_channel_id,
        destination_channel_id, destination_message_id, embed_color
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_message_id) DO UPDATE SET
        guild_id = excluded.guild_id,
        source_channel_id = excluded.source_channel_id,
        destination_channel_id = excluded.destination_channel_id,
        destination_message_id = excluded.destination_message_id,
        embed_color = excluded.embed_color
`);

function normalizeBoolean(settingName, value) {
    if (typeof value !== "boolean") {
        throw new TypeError(`${settingName} must be a boolean.`);
    }
    return Number(value);
}

const GUILD_SETTING_DEFINITIONS = {
    socialRelayEnabled: {
        column: "social_relay_enabled",
        normalize: value => normalizeBoolean("socialRelayEnabled", value)
    }
};

const STARBOARD_SETTING_DEFINITIONS = {
    enabled: {
        column: "enabled",
        normalize: value => normalizeBoolean("enabled", value)
    },
    autoReactionEnabled: {
        column: "auto_reaction_enabled",
        normalize: value => normalizeBoolean("autoReactionEnabled", value)
    },
    sourceChannelId: {
        column: "source_channel_id",
        normalize: value => {
            if (value !== null && typeof value !== "string") {
                throw new TypeError("sourceChannelId must be a channel ID or null.");
            }
            return value;
        }
    },
    destinationChannelId: {
        column: "destination_channel_id",
        normalize: value => {
            if (value !== null && typeof value !== "string") {
                throw new TypeError("destinationChannelId must be a channel ID or null.");
            }
            return value;
        }
    },
    threshold: {
        column: "threshold",
        normalize: value => {
            if (!Number.isInteger(value) || value < 1 || value > 100) {
                throw new RangeError("threshold must be an integer from 1 to 100.");
            }
            return value;
        }
    },
    emoji: {
        column: "emoji",
        normalize: value => {
            if (typeof value !== "string" || !value.length || value.length > 64) {
                throw new TypeError("emoji must be a non-empty string.");
            }
            return value;
        }
    }
};

function updateSetting(guildId, setting, value, definitions, table, ensureGuild) {
    const definition = definitions[setting];
    if (!definition) {
        throw new Error(`Unknown ${table === "guild_settings" ? "meme system" : "starboard"} setting: ${setting}`);
    }

    const normalizedValue = definition.normalize(value);
    ensureGuild.run(guildId);
    database.prepare(
        `UPDATE ${table} SET ${definition.column} = ? WHERE guild_id = ?`
    ).run(normalizedValue, guildId);
}

function getGuildSettings(guildId) {
    insertGuild.run(guildId);
    const row = selectGuild.get(guildId);
    return {
        socialRelayEnabled: Boolean(row.social_relay_enabled)
    };
}

function setGuildSetting(guildId, setting, value) {
    updateSetting(
        guildId,
        setting,
        value,
        GUILD_SETTING_DEFINITIONS,
        "guild_settings",
        insertGuild
    );
}

function getGuildPrefix(guildId, defaultPrefix = "!") {
    insertGuild.run(guildId);
    const row = database.prepare(
        "SELECT prefix FROM guild_settings WHERE guild_id = ?"
    ).get(guildId);
    return row.prefix || defaultPrefix;
}

function setGuildPrefix(guildId, prefix) {
    if (typeof prefix !== "string" || !prefix || prefix.length > 5 || /\s/.test(prefix)) {
        throw new TypeError("Prefix must contain 1 to 5 non-whitespace characters.");
    }

    insertGuild.run(guildId);
    database.prepare("UPDATE guild_settings SET prefix = ? WHERE guild_id = ?")
        .run(prefix, guildId);
}

function getWebhook(channelId) {
    const row = selectWebhook.get(channelId);
    return row ? { id: row.webhook_id, token: row.webhook_token } : null;
}

function saveWebhook(channelId, webhookId, webhookToken) {
    upsertWebhook.run(channelId, webhookId, webhookToken);
}

function removeWebhook(channelId) {
    deleteWebhook.run(channelId);
}

function getStarboardSettings(guildId) {
    insertStarboardSettings.run(guildId);
    const row = selectStarboardSettings.get(guildId);
    return {
        enabled: Boolean(row.enabled),
        autoReactionEnabled: Boolean(row.auto_reaction_enabled),
        sourceChannelId: row.source_channel_id,
        destinationChannelId: row.destination_channel_id,
        threshold: row.threshold,
        emoji: row.emoji
    };
}

function setStarboardSetting(guildId, setting, value) {
    updateSetting(
        guildId,
        setting,
        value,
        STARBOARD_SETTING_DEFINITIONS,
        "starboard_settings",
        insertStarboardSettings
    );
}

function getStarboardMessage(sourceMessageId) {
    const row = selectStarboardMessage.get(sourceMessageId);
    return row ? {
        sourceMessageId: row.source_message_id,
        guildId: row.guild_id,
        sourceChannelId: row.source_channel_id,
        destinationChannelId: row.destination_channel_id,
        destinationMessageId: row.destination_message_id,
        embedColor: row.embed_color
    } : null;
}

function saveStarboardMessage(starboardMessage) {
    upsertStarboardMessage.run(
        starboardMessage.sourceMessageId,
        starboardMessage.guildId,
        starboardMessage.sourceChannelId,
        starboardMessage.destinationChannelId,
        starboardMessage.destinationMessageId,
        starboardMessage.embedColor
    );
}


function resetGuildConfiguration(guildId) {
    insertGuild.run(guildId);
    insertStarboardSettings.run(guildId);

    database.prepare(`
        UPDATE guild_settings
        SET social_relay_enabled = 0,
            prefix = NULL
        WHERE guild_id = ?
    `).run(guildId);

    database.prepare(`
        UPDATE starboard_settings
        SET enabled = 0,
            auto_reaction_enabled = 1,
            source_channel_id = NULL,
            destination_channel_id = NULL,
            threshold = 5,
            emoji = '⭐'
        WHERE guild_id = ?
    `).run(guildId);

    database.prepare(
        "DELETE FROM starboard_messages WHERE guild_id = ?"
    ).run(guildId);
}

module.exports = {
    getGuildSettings,
    setGuildSetting,
    getGuildPrefix,
    setGuildPrefix,
    getWebhook,
    saveWebhook,
    removeWebhook,
    getStarboardSettings,
    setStarboardSetting,
    getStarboardMessage,
    saveStarboardMessage,
    resetGuildConfiguration
};
