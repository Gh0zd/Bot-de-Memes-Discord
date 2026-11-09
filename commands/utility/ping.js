module.exports = {
    name: "ping",
    run: async (client, message) => message.reply({
        content: `Pong! My Ping is **${client.ws.ping}ms**`
    })
};
