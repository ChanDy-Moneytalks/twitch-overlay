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

async function findSteamAppId(gameName, gameId) {
  // 既にマッチング済みならキャッシュを使う（Steamの全件リスト取得を毎回避けるため）
  const cacheRef = db.collection("steam_mappings").doc(gameId);
  const cached = await cacheRef.get();
  if (cached.exists) return cached.data().steam_appid;

  const res = await fetch("https://api.steampowered.com/ISteamApps/GetAppList/v2/");
  const data = await res.json();
  const apps = data.applist.apps;
  const target = normalize(gameName);

  let match = apps.find((a) => normalize(a.name) === target);
  let confidence = "exact";
  if (!match) {
    match = apps.find(
      (a) => normalize(a.name).includes(target) || target.includes(normalize(a.name))
    );
    confidence = "fuzzy";
  }

  const steamAppId = match ? match.appid : null;
  await cacheRef.set({
    twitch_game_name: gameName,
    steam_appid: steamAppId,
    confidence,
    matched_at: admin.firestore.FieldValue.serverTimestamp(),
  });
  return steamAppId;
}

async function getSteamDetails(appId) {
  if (!appId) return null;
  const res = await fetch(
    `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=jp&l=japanese`
  );
  const data = await res.json();
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
      description: details?.description || null,
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
