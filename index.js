import "dotenv/config";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import fs from "fs";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

// 任意：ロールメンションしたいときだけ設定（空ならメンション無し）
const ROLE_ID = process.env.ROLE_ID || "";

// 山賊開始時刻（UTC固定）
const BANDIT_START_UTC_HOURS = [2, 5, 7, 9, 13, 15, 17, 19];
const NOTICE_MINUTES = 15;

// 二重投稿防止（GitHub Actionsだと毎回クリーンなので、簡易的に「近い時間なら送らない」方式）
const LOCK_FILE = "./last_notice.json";

function toJstString(dateUtc) {
  const jst = new Date(dateUtc.getTime() + 9 * 60 * 60 * 1000);
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} JST`;
}

function toUtcString(dateUtc) {
  const hh = String(dateUtc.getUTCHours()).padStart(2, "0");
  const mm = String(dateUtc.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

function nextBanditStartUtc(nowUtc) {
  const y = nowUtc.getUTCFullYear();
  const m = nowUtc.getUTCMonth();
  const d = nowUtc.getUTCDate();

  // 今日の候補
  for (const h of BANDIT_START_UTC_HOURS) {
    const candidate = new Date(Date.UTC(y, m, d, h, 0, 0));
    if (candidate > nowUtc) return candidate;
  }
  // なければ翌日最初
  return new Date(Date.UTC(y, m, d + 1, BANDIT_START_UTC_HOURS[0], 0, 0));
}

function shouldNotify(nowUtc, startUtc) {
  const diffMs = startUtc.getTime() - nowUtc.getTime();
  const diffMin = diffMs / 60000;
  // 15分前〜直前の間に実行されたら通知
  return diffMin <= NOTICE_MINUTES && diffMin > 0;
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch {
    return { lastStartIso: "" };
  }
}

function writeLock(startIso) {
  fs.writeFileSync(
    LOCK_FILE,
    JSON.stringify({ lastStartIso: startIso }, null, 2)
  );
}

client.once("ready", async () => {
  try {
    if (!TOKEN || !CHANNEL_ID)
      throw new Error("Missing DISCORD_TOKEN or CHANNEL_ID");

    const nowUtc = new Date();
    const startUtc = nextBanditStartUtc(nowUtc);

    if (!shouldNotify(nowUtc, startUtc)) {
      console.log("Not in notify window.");
      process.exit(0);
    }

    // 二重投稿ガード（同じ開始回は1回だけ）
    const lock = readLock();
    if (lock.lastStartIso === startUtc.toISOString()) {
      console.log("Already notified for this start time.");
      process.exit(0);
    }

    const channel = await client.channels.fetch(CHANNEL_ID);

    const embed = new EmbedBuilder()
      .setTitle("🔥 山賊 15分前通知")
      .setDescription("準備して集合！")
      .addFields(
        {
          name: "開始時刻",
          value: `${toUtcString(startUtc)} / ${toJstString(startUtc)}`,
          inline: true,
        },
        { name: "通知", value: `${NOTICE_MINUTES}分前`, inline: true }
      )
      .setTimestamp(new Date());

    const mention = ROLE_ID ? `<@&${ROLE_ID}> ` : "";
    await channel.send({
      content: `${mention}山賊まであと${NOTICE_MINUTES}分！`,
      embeds: [embed],
    });

    writeLock(startUtc.toISOString());
    process.exit(0);
  } catch (err) {
    console.error("Send failed:", err);
    process.exit(1);
  }
});

client.login(TOKEN);
