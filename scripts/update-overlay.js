import admin from "firebase-admin";

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_BROADCASTER_LOGIN,
  FIREBASE_SERVICE_ACCOUNT_BASE64,
  FIREBASE_PROJECT_ID,
} = process.env;

function requireEnv(name, value) {
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}
requireEnv("TWITCH_CLIENT_ID", TWITCH_CLIENT_ID);
requireEnv("TWITCH_CLIENT_SECRET", TWITCH_CLIENT_SECRET);
requireEnv("TWITCH_BROADCASTER_LOGIN", TWITCH_BROADCASTER_LOGIN);
requireEnv("FIREBASE_SERVICE_ACCOUNT_BASE64", FIREBASE_SERVICE_ACCOUNT_BASE64);
requireEnv("FIREBASE_PROJECT_ID", FIREBASE_PROJECT_ID);

const serviceAccount = JSON.parse(
  Buffer.from(FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf-8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: FIREBASE_PROJECT_ID,
});
const db = admin.firestore();

// ---------- Twitch ----------

async function getTwitchToken() {
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Twitchトークン取得に失敗しました: " + JSON.stringify(data));
  }
  return data.access_token;
}

async function getBroadcasterId(token) {
  const res = await fetch(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(TWITCH_BROADCASTER_LOGIN)}`,
    { headers: { "Client-Id": TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.data?.[0]?.id || null;
}

async function getCurrentChannelInfo(token, broadcasterId) {
  const res = await fetch(
    `https://api.twitch.tv/helix/channels?broadcaster_id=${broadcasterId}`,
    { headers: { "Client-Id": TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.data?.[0] || null; // { game_id, game_name, title, ... }
}

// ---------- Steam ----------

function normalize(name) {
  return name
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]/g, "");
}

const STEAM_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
};

async function fetchJsonSafe(url, label) {
  const res = await fetch(url, { headers: STEAM_HEADERS });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${label}: JSONとして解析できませんでした (status=${res.status}). 先頭200文字: ${text.slice(0, 200)}`
    );
  }
}

async function findSteamAppId(gameName, gameId) {
  // 既にマッチング済みならキャッシュを使う
  const cacheRef = db.collection("steam_mappings").doc(gameId);
  const cached = await cacheRef.get();
  if (cached.exists) return cached.data().steam_appid;

  // Steamストア内検索API（ストアの検索窓と同じ仕組み。APIキー不要）
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(
    gameName
  )}&l=japanese&cc=jp`;
  const data = await fetchJsonSafe(url, "Steamストア内検索");
  const items = data.items || [];

  const target = normalize(gameName);
  let match = items.find((it) => normalize(it.name) === target);
  let confidence = "exact";
  if (!match && items.length > 0) {
    match = items[0]; // 完全一致がなければ検索結果の最上位を採用
    confidence = "fuzzy";
  }

  const steamAppId = match ? match.id : null;
  await cacheRef.set({
    twitch_game_name: gameName,
    steam_appid: steamAppId,
    matched_name: match?.name || null,
    confidence,
    matched_at: admin.firestore.FieldValue.serverTimestamp(),
  });
  return steamAppId;
}

async function getSteamDetails(appId) {
  if (!appId) return null;
  const data = await fetchJsonSafe(
    `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=jp&l=japanese`,
    "Steam詳細情報取得"
  );
  const entry = data[appId];
  if (!entry?.success) return null;
  const d = entry.data;

  return {
    title: d.name,
    cover_image: d.header_image,
    genres: (d.genres || []).map((g) => g.description),
    description: d.short_description,
    price: d.is_free
      ? { is_free: true }
      : d.price_overview
      ? {
          is_free: false,
          initial_formatted: d.price_overview.initial_formatted,
          final_formatted: d.price_overview.final_formatted,
          discount_percent: d.price_overview.discount_percent,
        }
      : null,
  };
}

// ---------- 説明文の短縮 ----------
// お金をかけずに、句読点の途中で切らず自然な区切りで止める。
// 1. 「。！？」で終わる位置があればそこまで
// 2. なければ「、」の位置までで区切る
// 3. それも無ければ文字数で打ち切って「…」を付ける
function truncateToSentence(text, maxLen) {
  const stripped = text.replace(/<[^>]*>/g, "");
  if (stripped.length <= maxLen) return stripped;

  const slice = stripped.slice(0, maxLen);

  const sentenceEnd = Math.max(
    slice.lastIndexOf("。"),
    slice.lastIndexOf("！"),
    slice.lastIndexOf("？")
  );
  if (sentenceEnd > 10) return slice.slice(0, sentenceEnd + 1);

  const commaEnd = slice.lastIndexOf("、");
  if (commaEnd > 10) return slice.slice(0, commaEnd + 1) + "…";

  return slice + "…";
}

async function getOrCreateSummary(appId, description) {
  if (!appId || !description) return description || null;
  const ref = db.collection("description_summaries").doc(String(appId));
  const cached = await ref.get();
  if (cached.exists) return cached.data().summary;

  // カード内(2行・幅約300px)に収まる目安として48文字程度で区切る
  const summary = truncateToSentence(description, 48);
  await ref.set({
    summary,
    source_description: description,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
  });
  return summary;
}

// ---------- main ----------

async function main() {
  const token = await getTwitchToken();
  const broadcasterId = await getBroadcasterId(token);
  if (!broadcasterId) {
    throw new Error(
      "配信者IDが取得できませんでした。TWITCH_BROADCASTER_LOGIN（ユーザー名）を確認してください"
    );
  }

  const channel = await getCurrentChannelInfo(token, broadcasterId);
  if (!channel || !channel.game_name) {
    console.log("現在のカテゴリ情報が取得できませんでした（配信未設定の可能性）");
    return;
  }

  console.log(`Twitchカテゴリ: ${channel.game_name} (game_id=${channel.game_id})`);

  const steamAppId = channel.game_id
    ? await findSteamAppId(channel.game_name, channel.game_id)
    : null;
  const details = await getSteamDetails(steamAppId);
  const descriptionSummary = details
    ? await getOrCreateSummary(steamAppId, details.description)
    : null;

  await db
    .collection("overlay")
    .doc("current")
    .set({
      twitch_game_name: channel.game_name,
      twitch_game_id: channel.game_id || null,
      steam_appid: steamAppId,
      found_on_steam: !!details,
      title: details?.title || channel.game_name,
      cover_image: details?.cover_image || null,
      genres: details?.genres || [],
      description: descriptionSummary,
      price: details?.price || null,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });

  console.log(
    `更新完了: ${channel.game_name} → Steam AppID: ${steamAppId || "なし（マッチせず）"}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
