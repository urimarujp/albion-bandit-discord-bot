import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
} from "discord.js";

/**
 * Albion Bandit Alert Bot (Final)
 *
 * ✅ GitHub Actions schedule のズレ前提（頻繁起動 + 時間窓判定）
 * ✅ スマホ通知に出る本文(content)を最適化（改行 + 注意文）
 * ✅ 山賊ロール(ROLE_ID)がある人だけメンション
 * ✅ 二重通知防止：Discordの直近メッセージ履歴から同一開始回の投稿を検知
 */

// ===== Env =====
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = process.env.ROLE_ID || "";
const EVENT_NAME = process.env.GITHUB_EVENT_NAME || "";

// ===== Config =====
// 山賊開始時刻（UTC固定）
const BANDIT_START_UTC_HOURS = [2, 5, 7, 9, 13, 15, 17, 19];

// 通知ウィンドウ（GitHub遅延対策）
// 「15分前」を狙いつつ、ズレや遅延を吸収する
const BEFORE_MIN = 20; // 開始前 20分以内なら通知OK
const AFTER_MIN = 10; // 開始後 10分までなら通知OK（遅延吸収）

// 重複チェック（直近何件見るか）
const DUP_CHECK_LIMIT = 80;

// 本文の固定文言（スマホ通知用）
const NOTICE_LINES = [
  "時間は固定ですが、必ず山賊があるとは限りません。",
  "ログインして通知が出ているか確認してください。",
];

// ===== Discord Client =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ===== Utils =====
function pad2(n) {
  return String(n).padStart(2, "0");
}

function toJstTimeString(dateUtc) {
  const jst = new Date(dateUtc.getTime() + 9 * 60 * 60 * 1000);
  return `${pad2(jst.getUTCHours())}:${pad2(jst.getUTCMinutes())} JST`;
}

function toUtcTimeString(dateUtc) {
  return `${pad2(dateUtc.getUTCHours())}:${pad2(dateUtc.getUTCMinutes())} UTC`;
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

function diffMinutes(startUtc, nowUtc) {
  return (startUtc.getTime() - nowUtc.getTime()) / 60000;
}

function inNotifyWindow(diffMin) {
  // diffMin: 正→開始前 / 負→開始後
  return diffMin <= BEFORE_MIN && diffMin >= -AFTER_MIN;
}

// ===== Message builders =====
function buildContent(startUtc) {
  const startJst = toJstTimeString(startUtc);
  return [`⚔️ 山賊：${startJst} 開始の可能性あり`, ...NOTICE_LINES].join("\n");
}

function buildEmbed(startUtc, nowUtc) {
  const startJst = toJstTimeString(startUtc);
  const startUtcStr = toUtcTimeString(startUtc);
  const diffMin = diffMinutes(startUtc, nowUtc);

  const status =
    diffMin >= 0
      ? `開始まで約 ${Math.ceil(diffMin)} 分`
      : `開始から約 ${Math.abs(Math.floor(diffMin))} 分経過`;

  return new EmbedBuilder()
    .setTitle("🔥 山賊 開始予告")
    .setDescription(NOTICE_LINES.join("\n"))
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

// ===== Duplicate check =====
// 同じ開始時刻の通知が既にあるか（BOTの過去投稿から検知）
async function alreadyNotified(channel, key) {
  try {
    const messages = await channel.messages.fetch({ limit: DUP_CHECK_LIMIT });

    for (const [, msg] of messages) {
      // BOT自身の投稿だけ見る（他人の文章で止まらないように）
      if (!msg.author?.bot) continue;
      if ((msg.content || "").includes(key)) return true;
    }
    return false;
  } catch (e) {
    // Read Message History が無いなどの場合：重複チェックできない
    console.warn("[BanditBot] Duplicate check skipped:", e?.message || e);
    return false;
  }
}

// ===== Main =====
async function main() {
  if (!TOKEN || !CHANNEL_ID) {
    throw new Error("Missing DISCORD_TOKEN or CHANNEL_ID");
  }

  const nowUtc = new Date();
  const startUtc = nextBanditStartUtc(nowUtc);
  const diffMin = diffMinutes(startUtc, nowUtc);

  console.log("[BanditBot] EVENT_NAME =", EVENT_NAME || "unknown");
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
    `before<=${BEFORE_MIN} after<=${AFTER_MIN}`,
  );

  const isManual = EVENT_NAME === "workflow_dispatch";

  // scheduleはウィンドウ外なら送らない（無駄投稿防止）
  if (!isManual && !inNotifyWindow(diffMin)) {
    console.log("[BanditBot] Not in notify window. Exit.");
    process.exit(0);
  }

  const channel = await client.channels.fetch(CHANNEL_ID);

  // sendできるチャンネルかチェック
  if (!channel || !("send" in channel)) {
    throw new Error("Target channel is not a sendable channel.");
  }

  // 権限チェック（分かりやすいエラーにする）
  if (channel.guild) {
    const me = channel.guild.members.me;
    if (me) {
      const perms = channel.permissionsFor(me);
      if (!perms?.has(PermissionsBitField.Flags.SendMessages)) {
        throw new Error("Missing permission: SendMessages");
      }
      if (!perms?.has(PermissionsBitField.Flags.EmbedLinks)) {
        throw new Error("Missing permission: EmbedLinks");
      }
      // ReadMessageHistory が無くても送信はできる（重複チェックだけ弱くなる）
    }
  }

  const mention = ROLE_ID ? `<@&${ROLE_ID}>` : "";
  const content = buildContent(startUtc);

  // ✅ 重複防止キー：開始時刻（JST）入りの1行目をキーにする
  const key = `⚔️ 山賊：${toJstTimeString(startUtc)} 開始の可能性あり`;

  // schedule時は重複があれば送らない（手動はテストなので送ってOK）
  if (!isManual) {
    const dup = await alreadyNotified(channel, key);
    if (dup) {
      console.log(
        "[BanditBot] Already notified (found in recent messages). Exit.",
      );
      process.exit(0);
    }
  }

  await channel.send({
    content: mention ? `${mention}\n${content}` : content,
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
