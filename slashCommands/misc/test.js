module.exports = {
    name: "test",
    description: "A Test Command From Discord.jsV14!",
    options: [
        {
            name: "test",
            description: "A Test Command From Discord.jsV14!",
            type: "String",
            required: true
        }
    ],
    run: async (client, interaction) =>
        interaction.reply({ content: "Discord.jsv14 is here!" })
};
