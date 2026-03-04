// index.js
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
} from "discord.js";

/**
 * Albion Bandit Alert Bot (external cron optimized)
 *
 * ✅ 外部Cronで「開始15分前」にだけ起動する前提
 * ✅ 改行込み本文(content) + Embed
 * ✅ 山賊ロールだけメンション（ROLE_ID）
 * ✅ 二重通知対策（直近メッセージから同一キー検知）
 *
 * Secrets（GitHub Actions）:
 * - DISCORD_TOKEN
 * - CHANNEL_ID
 * - ROLE_ID
 */

// ===== Env =====
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = process.env.ROLE_ID || "";
const EVENT_NAME = process.env.GITHUB_EVENT_NAME || "unknown";

// ===== Config =====
// 山賊開始時刻（UTC固定）
const BANDIT_START_UTC_HOURS = [2, 5, 7, 9, 13, 15, 17, 19];

// Cronは「開始15分前」に起動する運用。
// 万一の遅延/早着も吸収する（この範囲内なら “この回” と判断する）
const EXPECT_BEFORE_MIN = 15;
const EARLY_ALLOW_MIN = 5; // 早く来ても -5分までは許容（=開始20分前まで）
const LATE_ALLOW_MIN = 10; // 遅れても +10分までは許容（=開始5分前まで）
const TARGET_MIN_MIN = EXPECT_BEFORE_MIN + LATE_ALLOW_MIN; // 25
const TARGET_MAX_MIN = EXPECT_BEFORE_MIN - EARLY_ALLOW_MIN; // 10
// ↑ start - now が「10〜25分」の範囲に入る開始時刻を “今回の対象” とみなす

// 重複チェック：直近何件見るか（大きいほど重い）
const DUP_CHECK_LIMIT = 80;

// 本文（スマホ通知の先頭に出やすい）
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
  // dateUtc は UTC基準の Date を想定
  const jst = new Date(dateUtc.getTime() + 9 * 60 * 60 * 1000);
  // jst を UTCメソッドで表示（+9してるのでUTC表示=JST表示になる）
  return `${pad2(jst.getUTCHours())}:${pad2(jst.getUTCMinutes())} JST`;
}

function toUtcTimeString(dateUtc) {
  return `${pad2(dateUtc.getUTCHours())}:${pad2(dateUtc.getUTCMinutes())} UTC`;
}

function diffMinutes(startUtc, nowUtc) {
  return (startUtc.getTime() - nowUtc.getTime()) / 60000;
}

// 今日/明日の全候補から「start-now が 10〜25分」のものを探す。
// 見つからなければ “次の開始” を返す（保険）
function pickTargetStartUtc(nowUtc) {
  const y = nowUtc.getUTCFullYear();
  const m = nowUtc.getUTCMonth();
  const d = nowUtc.getUTCDate();

  const candidates = [];
  for (const dayOffset of [0, 1]) {
    for (const h of BANDIT_START_UTC_HOURS) {
      candidates.push(new Date(Date.UTC(y, m, d + dayOffset, h, 0, 0)));
    }
  }

  // まず「10〜25分」の範囲に入る開始を優先
  const inRange = candidates
    .map((t) => ({ t, diff: diffMinutes(t, nowUtc) }))
    .filter((x) => x.diff >= TARGET_MAX_MIN && x.diff <= TARGET_MIN_MIN)
    .sort((a, b) => a.diff - b.diff);

  if (inRange.length > 0) return inRange[0].t;

  // 範囲に無い場合は「次の開始」（未来で最小diff）
  const next = candidates
    .map((t) => ({ t, diff: diffMinutes(t, nowUtc) }))
    .filter((x) => x.diff > 0)
    .sort((a, b) => a.diff - b.diff);

  return next.length > 0 ? next[0].t : candidates[0];
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
      { name: "トリガー", value: EVENT_NAME, inline: true },
    )
    .setTimestamp(new Date());
}

// ===== Duplicate check =====
// 直近のBOT投稿に “同一開始回キー” が含まれているか
async function alreadyNotified(channel, key) {
  try {
    const messages = await channel.messages.fetch({ limit: DUP_CHECK_LIMIT });
    for (const [, msg] of messages) {
      if (!msg.author?.bot) continue;
      if ((msg.content || "").includes(key)) return true;
    }
    return false;
  } catch (e) {
    // 権限不足（Read Message History なし）などの場合は重複チェックをスキップ
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
  const startUtc = pickTargetStartUtc(nowUtc);
  const diffMin = diffMinutes(startUtc, nowUtc);

  console.log("[BanditBot] EVENT_NAME  =", EVENT_NAME);
  console.log("[BanditBot] nowUtc      =", toUtcTimeString(nowUtc));
  console.log(
    "[BanditBot] targetStart =",
    toUtcTimeString(startUtc),
    "/",
    toJstTimeString(startUtc),
  );
  console.log("[BanditBot] diffMin     =", diffMin);
  console.log(
    "[BanditBot] targetRange =",
    `${TARGET_MAX_MIN}..${TARGET_MIN_MIN} min before start`,
  );

  // 外部Cron運用なので、ズレが大きい場合は誤爆防止で送らない（保険）
  // 例：cron設定ミスで全然違う時間に叩かれた、など
  if (diffMin < TARGET_MAX_MIN || diffMin > TARGET_MIN_MIN) {
    console.log(
      "[BanditBot] Not in expected cron window. Exit without sending.",
    );
    process.exit(0);
  }

  const channel = await client.channels.fetch(CHANNEL_ID);

  // send可能か
  if (!channel || typeof channel.send !== "function") {
    throw new Error("Target channel is not a sendable channel.");
  }

  // 権限チェック（わかりやすいエラーにする）
  if (channel.guild) {
    const me = channel.guild.members.me;
    if (me) {
      const perms = channel.permissionsFor(me);
      if (!perms?.has(PermissionsBitField.Flags.ViewChannel)) {
        throw new Error("Missing permission: ViewChannel");
      }
      if (!perms?.has(PermissionsBitField.Flags.SendMessages)) {
        throw new Error("Missing permission: SendMessages");
      }
      // Embedは任意。無いならembed無しで送れるようにするのもアリだが、
      // ここでは要件通りEmbed前提でチェックする
      if (!perms?.has(PermissionsBitField.Flags.EmbedLinks)) {
        throw new Error("Missing permission: EmbedLinks");
      }
    }
  }

  const mention = ROLE_ID ? `<@&${ROLE_ID}>` : "";
  const content = buildContent(startUtc);

  // ✅ 重複防止キー（開始時刻JSTを固定キーにする）
  const key = `⚔️ 山賊：${toJstTimeString(startUtc)} 開始の可能性あり`;

  const dup = await alreadyNotified(channel, key);
  if (dup) {
    console.log("[BanditBot] Already notified. Exit.");
    process.exit(0);
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
