require("dotenv").config();

const { Client, Collection, GatewayIntentBits, Partials, ActivityType } = require("discord.js");
const settings = require("./settings.json");
const { logError, logInfo } = require("./utils/logger");

const HANDLER_DIRECTORY = "./handlers";
const CORE_HANDLERS = ["antiCrash", "events", "slashCommands"];

function resolveToken() {
    const fromEnv = process.env.DISCORD_TOKEN?.trim();
    if (fromEnv) return fromEnv;

    const fromSettings = typeof settings.token === "string" ? settings.token.trim() : "";
    if (fromSettings) {
        logInfo(
            "Startup",
            "Using token from settings.json. Prefer DISCORD_TOKEN in a .env file for security."
        );
        return fromSettings;
    }

    return "";
}

function createClient() {
    const client = new Client({
        shards: "auto",
        partials: [Partials.Message, Partials.Channel, Partials.Reaction],
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.MessageContent
        ]
    });

    client.slashCommands = new Collection();
    if (settings.messageContentCommands?.status === true) {
        client.commands = new Collection();
        client.aliases = new Collection();
    }

    return client;
}

async function loadHandlers(client) {
    const handlers = settings.messageContentCommands?.status === true
        ? [...CORE_HANDLERS.slice(0, 1), "commands", ...CORE_HANDLERS.slice(1)]
        : CORE_HANDLERS;

    for (const handlerName of handlers) {
        const handler = require(`${HANDLER_DIRECTORY}/${handlerName}`);
        if (typeof handler !== "function") {
            throw new TypeError(`Handler "${handlerName}" must export a function.`);
        }
        await handler(client);
        logInfo("Startup", `Loaded handler "${handlerName}".`);
    }
}

function applyPresence(client) {
    const presence = settings.presence;
    if (!presence) return;

    const activities = (presence.activities || []).map(activity => {
        const type = typeof activity.type === "number"
            ? activity.type
            : ActivityType[activity.type] ?? ActivityType.Watching;
        return {
            name: activity.name || "memes",
            type
        };
    });

    client.user.setPresence({
        status: presence.status || "online",
        activities
    });
}

async function startBot() {
    const token = resolveToken();
    if (!token) {
        throw new Error(
            "No Discord bot token found. Set DISCORD_TOKEN in a .env file (recommended) or settings.json."
        );
    }

    const client = createClient();
    await loadHandlers(client);

    const readyEvent = require("discord.js").Events?.ClientReady || "ready";
    client.once(readyEvent, () => {
        applyPresence(client);
    });

    await client.login(token);
    return client;
}

startBot().catch(error => {
    logError("Startup", "The bot could not be started.", error);
    process.exitCode = 1;
});
