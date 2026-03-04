import "dotenv/config";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

/**
 * Albion Bandit Alert Bot
 * - Discord通知（本文）は「⚔️ 山賊：HH:MM JST 開始の可能性あり」を必ず送る
 * - GitHub Actions の schedule 遅延を考慮し、送信ウィンドウは広めに許容
 * - 手動実行(workflow_dispatch)でも同じ本文を送る（テスト用）
 */

// ===== Env =====
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = process.env.ROLE_ID || "";
const EVENT_NAME = process.env.GITHUB_EVENT_NAME || ""; // workflow側で渡す（無くても動く）

// ===== Config =====
// 山賊開始時刻（UTC固定）
const BANDIT_START_UTC_HOURS = [2, 5, 7, 9, 13, 15, 17, 19];

// 通知ウィンドウ（GitHub遅延対策）
const NOTICE_MINUTES_BEFORE = 15; // 何分前から送ってOK
const ALLOW_MINUTES_AFTER = 15; // 開始後何分まで送ってOK（遅延吸収）

// ===== Discord Client =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toJstTimeString(dateUtc) {
  // dateUtc は UTC として扱う（Date は内部的に ms を持つだけなのでOK）
  const jst = new Date(dateUtc.getTime() + 9 * 60 * 60 * 1000);
  // JSTに変換した上で、UTC系のgetterで「その時刻文字列」を作る
  const hh = pad2(jst.getUTCHours());
  const mm = pad2(jst.getUTCMinutes());
  return `${hh}:${mm} JST`;
}

function toUtcTimeString(dateUtc) {
  const hh = pad2(dateUtc.getUTCHours());
  const mm = pad2(dateUtc.getUTCMinutes());
  return `${hh}:${mm} UTC`;
}

function nextBanditStartUtc(nowUtc) {
  const y = nowUtc.getUTCFullYear();
  const m = nowUtc.getUTCMonth();
  const d = nowUtc.getUTCDate();

  for (const h of BANDIT_START_UTC_HOURS) {
    const candidate = new Date(Date.UTC(y, m, d, h, 0, 0));
    if (candidate > nowUtc) return candidate;
  }
  // 今日分が全部過ぎていたら翌日の最初へ
  return new Date(Date.UTC(y, m, d + 1, BANDIT_START_UTC_HOURS[0], 0, 0));
}

function minutesDiff(startUtc, nowUtc) {
  return (startUtc.getTime() - nowUtc.getTime()) / 60000;
}

function inNotifyWindow(nowUtc, startUtc) {
  const diffMin = minutesDiff(startUtc, nowUtc);
  // diffMin: 正→開始前 / 負→開始後
  return diffMin <= NOTICE_MINUTES_BEFORE && diffMin >= -ALLOW_MINUTES_AFTER;
}

function buildContent(startUtc) {
  // 本文は常にこれ（ユーザー指定）
  const startJst = toJstTimeString(startUtc);
  return `⚔️ 山賊：${startJst} 開始の可能性あり。時間は決まってますが、s必ず山賊があるわけではないのでログインして山賊通知があるか確認してください。`;
}

function buildEmbed(startUtc, nowUtc) {
  const startJst = toJstTimeString(startUtc);
  const startUtcStr = toUtcTimeString(startUtc);
  const diffMin = minutesDiff(startUtc, nowUtc);

  const status =
    diffMin >= 0
      ? `開始まで約 ${Math.ceil(diffMin)} 分`
      : `開始から約 ${Math.abs(Math.floor(diffMin))} 分経過`;

  return new EmbedBuilder()
    .setTitle("🔥 山賊 開始予告")
    .setDescription("時間は前後する可能性があります。")
    .addFields(
      {
        name: "開始予定",
        value: `${startJst}\n(${startUtcStr})`,
        inline: true,
      },
      { name: "状況", value: status, inline: true },
      { name: "トリガー", value: EVENT_NAME || "unknown", inline: true },
    )
    .setTimestamp(new Date());
}

async function main() {
  if (!TOKEN || !CHANNEL_ID) {
    throw new Error("Missing DISCORD_TOKEN or CHANNEL_ID");
  }

  const nowUtc = new Date();
  const startUtc = nextBanditStartUtc(nowUtc);

  // ログ（Actionsでの確認用）
  console.log("[BanditBot] EVENT_NAME =", EVENT_NAME);
  console.log("[BanditBot] nowUtc      =", toUtcTimeString(nowUtc));
  console.log(
    "[BanditBot] nextStart   =",
    toUtcTimeString(startUtc),
    "/",
    toJstTimeString(startUtc),
  );
  console.log("[BanditBot] diffMin     =", minutesDiff(startUtc, nowUtc));

  // 手動実行はテストに便利なので必ず送る
  const isManual = EVENT_NAME === "workflow_dispatch";

  // scheduleはウィンドウ内だけ送る（無駄投稿防止）
  if (!isManual && !inNotifyWindow(nowUtc, startUtc)) {
    console.log("[BanditBot] Not in notify window. Exit.");
    process.exit(0);
  }

  const channel = await client.channels.fetch(CHANNEL_ID);
  const mention = ROLE_ID ? `<@&${ROLE_ID}> ` : "";

  await channel.send({
    content: `${mention}${buildContent(startUtc)}`,
    embeds: [buildEmbed(startUtc, nowUtc)],
  });

  console.log("[BanditBot] Sent successfully.");
  process.exit(0);
}

client.once("ready", () => {
  main().catch((err) => {
    console.error("[BanditBot] Send failed:", err);
    process.exit(1);
  });
});

client.login(TOKEN);
