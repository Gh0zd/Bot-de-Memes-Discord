const LEVELS = {
    info: "INFO",
    warn: "WARN",
    error: "ERROR",
    debug: "DEBUG"
};

function timestamp() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function format(level, context, message) {
    return `[${timestamp()}] [${LEVELS[level] || level}] [${context}] ${message}`;
}

function logError(context, message, error) {
    console.error(format("error", context, message));
    if (error !== undefined && error !== null) {
        if (error instanceof Error) {
            console.error(error.stack || error.message);
        } else {
            console.error(error);
        }
    }
}

function logInfo(context, message) {
    console.info(format("info", context, message));
}

function logWarning(context, message) {
    console.warn(format("warn", context, message));
}

function logDebug(context, message) {
    if (process.env.DEBUG === "1" || process.env.DEBUG === "true") {
        console.debug(format("debug", context, message));
    }
}

module.exports = {
    logError,
    logInfo,
    logWarning,
    logDebug
};
