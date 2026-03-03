import "dotenv/config";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import fs from "fs";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

// 任意：ロールメンション（入れないなら空でOK）
const ROLE_ID = process.env.ROLE_ID || "";

// 任意：テスト用（trueなら常に送信）
const FORCE_NOTIFY = (process.env.FORCE_NOTIFY || "").toLowerCase() === "true";

// 山賊開始時刻（UTC固定）
const BANDIT_START_UTC_HOURS = [2, 5, 7, 9, 13, 15, 17, 19];

// 通知設定
const NOTICE_MINUTES = 15;
const LATE_TOLERANCE_MINUTES = 5; // GitHub Actionsの遅延対策（開始後5分まで許容）

// 簡易ロック（ローカル/手動連打対策。Actionsでは永続化されないので完全二重防止にはならない）
const LOCK_FILE = "./last_notice.json";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toJstString(dateUtc) {
  const jst = new Date(dateUtc.getTime() + 9 * 60 * 60 * 1000);
  return `${pad2(jst.getUTCHours())}:${pad2(jst.getUTCMinutes())} JST`;
}

function toUtcString(dateUtc) {
  return `${pad2(dateUtc.getUTCHours())}:${pad2(dateUtc.getUTCMinutes())} UTC`;
}

function nextBanditStartUtc(nowUtc) {
  const y = nowUtc.getUTCFullYear();
  const m = nowUtc.getUTCMonth();
  const d = nowUtc.getUTCDate();

  // 今日の候補から「次」を探す
  for (const h of BANDIT_START_UTC_HOURS) {
    const candidate = new Date(Date.UTC(y, m, d, h, 0, 0));
    if (candidate > nowUtc) return candidate;
  }
  // なければ翌日最初
  return new Date(Date.UTC(y, m, d + 1, BANDIT_START_UTC_HOURS[0], 0, 0));
}

function minutesUntil(startUtc, nowUtc) {
  return (startUtc.getTime() - nowUtc.getTime()) / 60000;
}

function shouldNotify(nowUtc, startUtc) {
  const diffMin = minutesUntil(startUtc, nowUtc);
  // 15分前〜開始後5分まで許容（schedule遅延対策）
  return diffMin <= NOTICE_MINUTES && diffMin >= -LATE_TOLERANCE_MINUTES;
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

function buildEmbed(startUtc, nowUtc) {
  const diffMin = minutesUntil(startUtc, nowUtc);
  const remainText =
    diffMin >= 0
      ? `開始まで約 ${Math.ceil(diffMin)} 分`
      : `開始から約 ${Math.abs(Math.floor(diffMin))} 分経過`;

  return new EmbedBuilder()
    .setTitle("🔥 山賊 15分前通知")
    .setDescription("準備して集合！")
    .addFields(
      {
        name: "開始時刻",
        value: `${toUtcString(startUtc)} / ${toJstString(startUtc)}`,
        inline: true,
      },
      { name: "状況", value: remainText, inline: true }
    )
    .setTimestamp(new Date());
}

client.once("ready", async () => {
  try {
    if (!TOKEN || !CHANNEL_ID) {
      throw new Error("Missing DISCORD_TOKEN or CHANNEL_ID");
    }

    const nowUtc = new Date();
    const startUtc = nextBanditStartUtc(nowUtc);
    const diffMin = minutesUntil(startUtc, nowUtc);

    console.log("[BanditBot] FORCE_NOTIFY =", FORCE_NOTIFY);
    console.log("[BanditBot] nowUtc   =", toUtcString(nowUtc));
    console.log(
      "[BanditBot] nextStart=",
      toUtcString(startUtc),
      "/",
      toJstString(startUtc)
    );
    console.log("[BanditBot] diffMin  =", diffMin);

    if (!FORCE_NOTIFY && !shouldNotify(nowUtc, startUtc)) {
      console.log("[BanditBot] Not in notify window. Exit.");
      process.exit(0);
    }

    // ロック（同じ開始時刻での連投を抑止）
    const lock = readLock();
    if (!FORCE_NOTIFY && lock.lastStartIso === startUtc.toISOString()) {
      console.log("[BanditBot] Already notified for this start time. Exit.");
      process.exit(0);
    }

    const channel = await client.channels.fetch(CHANNEL_ID);
    const embed = buildEmbed(startUtc, nowUtc);
    const mention = ROLE_ID ? `<@&${ROLE_ID}> ` : "";

    await channel.send({
      content: `${mention}山賊まであと${NOTICE_MINUTES}分！`,
      embeds: [embed],
    });

    writeLock(startUtc.toISOString());
    console.log("[BanditBot] Sent successfully.");
    process.exit(0);
  } catch (err) {
    console.error("[BanditBot] Send failed:", err);
    process.exit(1);
  }
});

client.login(TOKEN);
