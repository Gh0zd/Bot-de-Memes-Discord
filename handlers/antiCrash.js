const { logError } = require("../utils/logger");

module.exports = function registerProcessErrorHandlers() {
    process.on("unhandledRejection", (reason, promise) => {
        logError("Process", `Unhandled promise rejection (${promise}).`, reason);
    });

    process.on("uncaughtException", (error, origin) => {
        logError("Process", `Uncaught exception (${origin}).`, error);
    });

    process.on("uncaughtExceptionMonitor", (error, origin) => {
        logError("Process", `Uncaught exception monitor (${origin}).`, error);
    });
};