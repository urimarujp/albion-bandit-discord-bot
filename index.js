import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
} from "discord.js";

// /***
//  * Albion Bandit Alert Bot (Production)
//  * - schedule はズレる前提で、ワークフローは */5 等で回し、コードで送信判断
//  * - 二重通知は「Discordの直近メッセージ検索」で防止（Actionsのクリーン実行対策）
//  * - 本文は「⚔️ 山賊：HH:MM JST 開始の可能性あり」を必ず含める（ユーザー要望）
//  */

// ===== Env =====
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = process.env.ROLE_ID || "";
const EVENT_NAME = process.env.GITHUB_EVENT_NAME || "";

// ===== Config =====
// 山賊開始時刻（UTC固定）
const BANDIT_START_UTC_HOURS = [2, 5, 7, 9, 13, 15, 17, 19];

// 通知ウィンドウ（GitHub遅延対策）
// 「15分前」を狙いつつ、scheduleの遅延/先行も拾うために少し広め
const NOTICE_MINUTES_BEFORE = 20; // 開始前 20分以内なら送る
const ALLOW_MINUTES_AFTER = 10; // 開始後 10分までなら送る（遅延吸収）

// 重複防止：同じ開始時刻の通知が既にあれば送らない（Discord履歴から判定）
const DUP_CHECK_MESSAGES = 50; // 直近n件をチェック（多いほど安全だがAPI回数増）
const DUP_KEY_PREFIX = "⚔️ 山賊："; // 本文の先頭キー

// ===== Discord Client =====
// メッセージ送信と履歴取得に MessageContent は不要。
// ただし「チャンネルのメッセージ履歴を取得」できる権限がBOT側に必要。
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toJstTimeString(dateUtc) {
  const jst = new Date(dateUtc.getTime() + 9 * 60 * 60 * 1000);
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
  const startJst = toJstTimeString(startUtc);
  // ✅ ここが Discord 通知の「本文」：スマホ通知で見えるのは主にここ
  return `${DUP_KEY_PREFIX}${startJst} 開始の可能性あり`;
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
    .setDescription(
      "時間は決まっていますが、必ず山賊があるとは限りません。ログインして通知が出ているか確認してください。",
    )
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

/**
 * 直近メッセージから「同じ開始時刻の通知が既にあるか」を判定
 * - 例: "⚔️ 山賊：18:00 JST 開始の可能性あり" が既にあれば重複送信しない
 */
async function alreadyNotified(channel, contentKey) {
  // partial や textベース以外もあり得るので fetch 周りはtryで安全に
  try {
    const messages = await channel.messages.fetch({
      limit: DUP_CHECK_MESSAGES,
    });
    for (const [, msg] of messages) {
      // BOT自身の投稿だけを見る（他人の同文投稿で止まらないように）
      if (!msg.author?.bot) continue;
      if ((msg.content || "").includes(contentKey)) return true;
    }
    return false;
  } catch (e) {
    // 履歴取得権限が無い等の時は「重複チェック不能」になるのでログに出して続行
    console.warn("[BanditBot] Duplicate check skipped:", e?.message || e);
    return false;
  }
}

async function main() {
  if (!TOKEN || !CHANNEL_ID)
    throw new Error("Missing DISCORD_TOKEN or CHANNEL_ID");

  const nowUtc = new Date();
  const startUtc = nextBanditStartUtc(nowUtc);
  const diffMin = minutesDiff(startUtc, nowUtc);

  console.log("[BanditBot] EVENT_NAME =", EVENT_NAME);
  console.log("[BanditBot] nowUtc      =", toUtcTimeString(nowUtc));
  console.log(
    "[BanditBot] nextStart   =",
    toUtcTimeString(startUtc),
    "/",
    toJstTimeString(startUtc),
  );
  console.log("[BanditBot] diffMin     =", diffMin);
  console.log(
    "[BanditBot] window      =",
    `before<=${NOTICE_MINUTES_BEFORE} after<=${ALLOW_MINUTES_AFTER}`,
  );

  const isManual = EVENT_NAME === "workflow_dispatch";

  // scheduleはウィンドウ内だけ送る（無駄投稿防止）
  if (!isManual && !inNotifyWindow(nowUtc, startUtc)) {
    console.log("[BanditBot] Not in notify window. Exit.");
    process.exit(0);
  }

  const channel = await client.channels.fetch(CHANNEL_ID);

  // チャンネルがテキスト系かチェック
  if (!channel || !("send" in channel)) {
    throw new Error("Target channel is not a sendable channel.");
  }

  // 権限チェック（送信できないケースを分かりやすく）
  // ※guildチャンネルの場合のみ有効。DMなどはnullになることがある。
  if (channel.guild) {
    const me = channel.guild.members.me;
    if (me) {
      const perms = channel.permissionsFor(me);
      if (!perms?.has(PermissionsBitField.Flags.SendMessages)) {
        throw new Error("Missing permission: SendMessages");
      }
      // Embed送信権限もチェック
      if (!perms?.has(PermissionsBitField.Flags.EmbedLinks)) {
        throw new Error("Missing permission: EmbedLinks");
      }
      // 重複チェックで履歴読むなら ReadMessageHistory が必要
      // 無い場合は重複チェックだけスキップして送信はできる
    }
  }

  const mention = ROLE_ID ? `<@&${ROLE_ID}> ` : "";
  const content = buildContent(startUtc);

  // ✅ 二重通知防止（同じ開始時刻の文言が既にあるなら送らない）
  const dupKey = content; // contentそのものをキーにする
  const dup = await alreadyNotified(channel, dupKey);
  if (dup && !isManual) {
    console.log(
      "[BanditBot] Already notified (found in recent messages). Exit.",
    );
    process.exit(0);
  }

  await channel.send({
    content: `${mention}${content}`,
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
