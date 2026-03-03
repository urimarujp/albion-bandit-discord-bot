import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

client.once("ready", async () => {
  const channel = await client.channels.fetch(CHANNEL_ID);
  await channel.send("🔥 山賊15分前！準備しろ！");
  process.exit();
});

client.login(TOKEN);
