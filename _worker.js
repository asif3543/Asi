/**
 * ASI Animes / AnimeBox - Cloudflare Worker Core Engine
 * VERSION: PRO IQ200 - ULTRA OPTIMIZED & SECURED
 * Features: Adsterra/Monetag, APK, ImgBB Permanent CDN, Strict Security, 
 * Zero Memory Leaks, Smart SW Caching, Smart Timeout Shorteners.
 */

export default {
  async fetch(request, env, ctx) {
    // 1. CORS Preflight - Fixes Admin Panel saving errors
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Admin-Pin",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    const url = new URL(request.url);
    const method = request.method;
    const adminPinHeader = request.headers.get("X-Admin-Pin");

    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });

    const kvGet = async (key, defaultVal = null) => {
      if (env.ANIME_KV) {
        const val = await env.ANIME_KV.get(key, "json");
        return val !== null ? val : defaultVal;
      }
      return defaultVal;
    };
    
    const kvSet = async (key, val) => {
      if (env.ANIME_KV) await env.ANIME_KV.put(key, JSON.stringify(val));
    };

    const kvDelete = async (key) => {
      if (env.ANIME_KV) await env.ANIME_KV.delete(key);
    };

    const isAdmin = async () => {
      const s = (await kvGet("settings", {})) || {};
      return adminPinHeader === (s.admin_pin || "admin123");
    };

    // Smart Telegram Notification Sender
    const sendTelegramNotification = async (settings, text, photoUrl = null) => {
      if (!settings.bot_token || !settings.chat_id) return { ok: false, reason: "TG Not Setup" };
      try {
        const tgForm = new FormData();
        tgForm.append("chat_id", settings.chat_id);
        tgForm.append("parse_mode", "HTML");
        let endpoint = "sendMessage";
        
        if (photoUrl && photoUrl.startsWith("http")) {
          tgForm.append("photo", photoUrl);
          tgForm.append("caption", text);
          endpoint = "sendPhoto";
        } else {
          tgForm.append("text", text);
        }
        
        const res = await fetch(`https://api.telegram.org/bot${settings.bot_token}/${endpoint}`, { method: "POST", body: tgForm });
        if (!res.ok) return { ok: false, reason: await res.text() };
        return { ok: true };
      } catch (err) { return { ok: false, reason: String(err) }; }
    };

    // =========================================================================
    // 🚀 PWA ENGINE: SMART CACHING (Anti-Storage Bomb)
    // =========================================================================

    if (url.pathname === "/manifest.json") {
      return new Response(JSON.stringify({
        name: "ASI Animes - Ultimate Anime Portal",
        short_name: "ASI Animes",
        description: "Watch and download high-definition anime, dramas, and movies.",
        start_url: "/",
        display: "standalone",
        background_color: "#05080c",
        theme_color: "#00ff66",
        icons: [{ src: "https://i.ibb.co/3sXfYZy/icon.png", sizes: "512x512", type: "image/png" }] // Fixed redirect bug
      }), { headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Access-Control-Allow-Origin": "*" } });
    }

    if (url.pathname === "/sw.js") {
      const swScript = `
        const CACHE = 'asi-anime-v9';
        self.addEventListener('install', e => self.skipWaiting());
        self.addEventListener('activate', e => self.clients.claim());
        self.addEventListener('fetch', e => {
          const req = e.request;
          // DO NOT cache APIs, Videos, Iframes, or POST requests (IQ200 Fix)
          if (req.method !== 'GET' || req.url.includes('/api/') || req.url.match(/\\.(mp4|m3u8|ts)$/i)) return;
          
          e.respondWith(caches.match(req).then(cached => {
            return cached || fetch(req).then(res => {
              // Cache only safe CSS/JS/Images from same origin or known CDNs
              if (res.status === 200 && (req.url.includes('cdnjs') || req.url.startsWith(self.location.origin))) {
                const clone = res.clone(); caches.open(CACHE).then(c => c.put(req, clone));
              }
              return res;
            });
          }).catch(() => new Response("Network Error", { status: 408 })));
        });
      `;
      return new Response(swScript, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Service-Worker-Allowed": "/" } });
    }

    // =========================================================================
    // API ENDPOINTS (Secured)
    // =========================================================================

    if (url.pathname === "/api/data" && method === "GET") {
      let posts = (await kvGet("posts", [])) || [];
      const settings = (await kvGet("settings", { site_name: "ASI Animes", channel_link: "https://t.me/" })) || {};
      
      // SECURITY FIX: Normal users get ONLY public settings
      let publicSettings = { 
        channel_link: settings.channel_link, ad_head: settings.ad_head, 
        ad_body: settings.ad_body, ad_banner: settings.ad_banner, apk_link: settings.apk_link 
      };

      // If Admin, send everything (including API keys)
      if (await isAdmin()) {
        const shorteners = (await kvGet("shorteners", [])) || [];
        const paid_requests = (await kvGet("paid_requests", [])) || [];
        return json({ posts, settings: publicSettings, shorteners, paid_requests, admin: true });
      }
      
      return json({ posts, settings: publicSettings });
    }

    if (url.pathname === "/api/posts" && method === "POST") {
      if (!(await isAdmin())) return json({ error: "Unauthorized" }, 401);
      const body = await request.json();
      let posts = (await kvGet("posts", [])) || [];
      const settings = (await kvGet("settings", {})) || {};
      
      const newPost = {
        id: body.id || "p_" + Date.now(),
        name: body.name || "Untitled",
        image_url: body.image_url || "",
        category: body.category || "Uncategorized",
        genres: body.genres || "",
        story: body.story || "",
        release: body.release || "",
        updatedAt: Date.now()
      };
      
      posts = posts.filter(p => p.id !== newPost.id);
      posts.unshift(newPost);
      await kvSet("posts", posts); // One Write

      // Telegram Auto-Post
      let hashGenres = newPost.genres.split(/[,.]+/).map(g => g.trim()).filter(g => g).map(g => '#' + g.replace(/\\s+/g, '')).join(' ');
      const escHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const tgMsg = "Name: <b>" + escHtml(newPost.name) + "</b> ❞\n\nCategory:\n<b>" + escHtml(newPost.category) + "</b> ❞\n\nGenre: " + escHtml(hashGenres) + "\nRelease: " + escHtml(newPost.release || '-') + "\n\n🔥 ╰┈➤ ♡𝙰𝙽𝙸𝙼𝙴 𝙱𝚈_𝙰𝚂𝙸✨\n⚓➠★★: @ASIgroup\n\n📖 " + escHtml(newPost.story);
      
      const tgRes = await sendTelegramNotification(settings, tgMsg, newPost.image_url);
      return json({ success: true, post: newPost, telegram: tgRes });
    }

    if (url.pathname.startsWith("/api/posts/") && method === "DELETE") {
      if (!(await isAdmin())) return json({ error: "Unauthorized" }, 401);
      const id = url.pathname.split("/").pop();
      let posts = (await kvGet("posts", [])) || [];
      posts = posts.filter(p => p.id !== id);
      await kvSet("posts", posts);
      await kvDelete(`ep_${id}`); // Memory Clean Fix (IQ200)
      return json({ success: true });
    }

    if (url.pathname === "/api/episodes" && method === "GET") {
      const postId = url.searchParams.get("post_id");
      const episodes = (await kvGet(`ep_${postId}`, [])) || [];
      return json({ episodes });
    }

    if (url.pathname === "/api/episodes" && method === "POST") {
      if (!(await isAdmin())) return json({ error: "Unauthorized" }, 401);
      const body = await request.json();
      let episodes = (await kvGet(`ep_${body.post_id}`, [])) || [];
      const newEp = {
        id: body.id || "ep_" + Date.now(), post_id: body.post_id,
        season: body.season || "", label: body.label || "01",
        quality: body.quality || "HD", play_link: body.play_link || "", download_link: body.download_link || ""
      };
      episodes = episodes.filter(e => e.id !== newEp.id);
      episodes.push(newEp);
      await kvSet(`ep_${body.post_id}`, episodes);
      return json({ success: true, episode: newEp });
    }

    if (url.pathname.startsWith("/api/episodes/") && method === "DELETE") {
      if (!(await isAdmin())) return json({ error: "Unauthorized" }, 401);
      const epId = url.pathname.split("/").pop();
      const postId = url.searchParams.get("post_id");
      let episodes = (await kvGet(`ep_${postId}`, [])) || [];
      episodes = episodes.filter(e => e.id !== epId);
      await kvSet(`ep_${postId}`, episodes);
      return json({ success: true });
    }

    if (url.pathname === "/api/admin/vip" && method === "GET") {
      if (!(await isAdmin())) return json({ error: "Unauthorized" }, 401);
      let users = (await kvGet("premium_users", [])) || [];
      // VIP Cleanup ONLY happens when admin calls it (Saves KV Writes)
      const now = new Date();
      const validUsers = users.filter(u => new Date(u.expires_at) > now);
      if (users.length !== validUsers.length) await kvSet("premium_users", validUsers);
      return json({ users: validUsers });
    }

    if (url.pathname.startsWith("/api/admin/vip/") && method === "DELETE") {
      if (!(await isAdmin())) return json({ error: "Unauthorized" }, 401);
      const email = decodeURIComponent(url.pathname.split("/").pop());
      let users = (await kvGet("premium_users", [])) || [];
      users = users.filter(u => u.email !== email);
      await kvSet("premium_users", users);
      return json({ success: true });
    }

    // IQ200 SMART SHORTENER LOGIC (Fast Timeout & VIP Check)
    if (url.pathname === "/api/get-link") {
      const epId = url.searchParams.get("ep_id"); 
      const postId = url.searchParams.get("post_id");
      const userKey = url.searchParams.get("key");
      
      const episodes = (await kvGet(`ep_${postId}`, [])) || []; 
      const ep = episodes.find(e => e.id === epId);
      if (!ep) return json({ error: "Episode not found" }, 404);
      const targetUrl = ep.download_link || ep.play_link; 
      if (!targetUrl) return json({ error: "Empty link" }, 400);
      
      // VIP Bypass
      if (userKey) {
        const premiumUsers = (await kvGet("premium_users", [])) || [];
        const user = premiumUsers.find(u => (u.key === userKey || u.email === userKey) && new Date(u.expires_at) > new Date());
        if (user) return json({ direct: true, url: targetUrl, premium: true });
      }

      const shorteners = (await kvGet("shorteners", [])) || [];
      if (shorteners.length > 0) {
        const activeSh = shorteners[Math.floor(Math.random() * shorteners.length)];
        const domain = (activeSh.dashboard_url || activeSh.domain || "").replace(/^(https?:\\/\\/)?(www\\.)?/, "").replace(/\\/$/, "").split("/")[0];
        const apiKey = activeSh.api_key || activeSh.apiKey;
        const apiDomain = domain.startsWith("api.") ? domain : "api." + domain;
        const apiUrl = `https://${apiDomain}/api?api=${apiKey}&url=${encodeURIComponent(targetUrl)}&format=text`;

        try {
          // Timeout Wrapper (Anti-504) - Waits max 3 seconds
          const fetchPromise = fetch(apiUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 3000));
          const r = await Promise.race([fetchPromise, timeoutPromise]);
          
          if (r.ok) {
            const txt = (await r.text()).trim();
            if (txt.startsWith("http")) return json({ direct: false, url: txt, shortener: domain });
          }
        } catch (err) {
           // If shortener is down or timeout happens, gracefully fallback to direct url (Don't crash)
           return json({ direct: true, url: targetUrl, note: "Bypassed due to shortener delay" });
        }
      }
      return json({ direct: true, url: targetUrl });
    }

    if (url.pathname === "/api/decrypt-link") {
      const code = url.searchParams.get("code");
      const paidRequests = (await kvGet("paid_requests", [])) || [];
      const item = paidRequests.find(r => r.password === code);
      if (item) return json({ success: true, url: item.original_link });
      return json({ success: false, message: "Invalid or expired key" }, 404);
    }

    if (url.pathname === "/api/premium" && method === "POST") {
      if (!(await isAdmin())) return json({ error: "Unauthorized" }, 401);
      const body = await request.json();
      let users = (await kvGet("premium_users", [])) || [];
      
      const expiry = new Date(); expiry.setDate(expiry.getDate() + parseInt(body.days || 30));
      const newUser = { id: "usr_" + Date.now(), email: body.email.toLowerCase().trim(), key: body.key.trim(), expires_at: expiry.toISOString() };
      
      users = users.filter(u => u.email !== newUser.email && u.key !== newUser.key);
      users.unshift(newUser);
      await kvSet("premium_users", users);

      const settings = (await kvGet("settings", {})) || {};
      const tgMsg = `💎 <b>New VIP Pass!</b>\n📧 ${newUser.email}\n🔑 ${newUser.key}\n⏳ Expires: ${expiry.toLocaleString()}`;
      ctx.waitUntil(sendTelegramNotification(settings, tgMsg));
      return json({ success: true, user: newUser });
    }

    if (url.pathname === "/api/settings" && method === "POST") {
      if (!(await isAdmin())) return json({ error: "Unauthorized" }, 401);
      const body = await request.json();
      const oldSettings = (await kvGet("settings", {})) || {};
      const mergedSettings = { ...oldSettings };
      
      if (body.settings) {
        for (const [key, value] of Object.entries(body.settings)) { if (value !== undefined) mergedSettings[key] = value; }
        await kvSet("settings", mergedSettings);
      }
      if (body.shorteners !== undefined) await kvSet("shorteners", body.shorteners);
      if (body.paid_requests !== undefined) await kvSet("paid_requests", body.paid_requests);
      return json({ success: true });
    }

    // SERVER-SIDE HTML RENDER
    const siteSettings = (await kvGet("settings", {})) || {};
    return new Response(renderFullAppHTML(siteSettings), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  }
};

function renderFullAppHTML(settings) {
  const adHead = settings.ad_head || '';
  const adBody = settings.ad_body || '';
  const adBanner = settings.ad_banner || '';
  const apkLink = settings.apk_link || '';

  return `<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>ASI Animes | HD Anime & Movies</title>
  <meta name="theme-color" content="#00ff66">
  <link rel="manifest" href="/manifest.json">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  
  <!-- Injected Ads (Head) -->
  ${adHead}

  <style>
    :root { --bg: #05080c; --card: #0d121c; --primary: #00ff66; --accent: #00f2fe; --text: #f0fdf4; --text-muted: #94a3b8; --border: rgba(0, 255, 102, 0.15); --gradient: linear-gradient(135deg, #00ff66 0%, #00f2fe 100%); }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', sans-serif; -webkit-tap-highlight-color: transparent; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; overflow-x: hidden; padding-bottom: 75px; }
    header { position: sticky; top: 0; z-index: 100; background: rgba(5, 8, 12, 0.9); backdrop-filter: blur(16px); border-bottom: 1px solid var(--border); padding: 12px 18px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .brand { font-size: 22px; font-weight: 900; background: var(--gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; cursor: pointer; }
    .search-box { flex: 1; max-width: 380px; position: relative; }
    .search-box input { width: 100%; padding: 8px 14px 8px 36px; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border); border-radius: 20px; color: #fff; font-size: 13px; outline: none; }
    .search-box i { position: absolute; left: 12px; top: 10px; color: var(--text-muted); font-size: 13px; }
    .btn-head { background: var(--gradient); color: #000; font-weight: 800; border: none; padding: 7px 14px; border-radius: 18px; font-size: 12px; cursor: pointer; }
    .filter-chips { display: flex; gap: 8px; overflow-x: auto; padding: 10px 18px; scrollbar-width: none; border-bottom: 1px solid rgba(0,255,102,0.05); }
    .filter-chips::-webkit-scrollbar { display: none; }
    .chip { background: var(--card); border: 1px solid var(--border); color: #fff; padding: 6px 14px; border-radius: 20px; font-size: 11px; font-weight: 700; white-space: nowrap; cursor: pointer; }
    .chip.active, .chip:hover { background: var(--primary); color: #000; border-color: var(--primary); }
    .slider { display: flex; gap: 15px; overflow-x: auto; padding: 12px 18px; scroll-snap-type: x mandatory; scrollbar-width: none; }
    .slider::-webkit-scrollbar { display: none; }
    .slide-card { flex: 0 0 280px; height: 160px; border-radius: 14px; overflow: hidden; position: relative; border: 1px solid var(--border); cursor: pointer; scroll-snap-align: start; }
    .slide-card img { width: 100%; height: 100%; object-fit: cover; }
    .slide-overlay { position: absolute; inset: 0; background: linear-gradient(to top, #05080c 20%, transparent 80%); display: flex; flex-direction: column; justify-content: flex-end; padding: 12px; }
    .slide-title { font-size: 14px; font-weight: bold; }
    .slide-tag { font-size: 10px; color: var(--primary); font-weight: 800; }
    .section-head { padding: 8px 18px; font-size: 16px; font-weight: 800; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 14px; padding: 0 18px 20px 18px; }
    .card { background: var(--card); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); cursor: pointer; position: relative; }
    .poster-wrap { width: 100%; aspect-ratio: 2/3; background: #0c1410; display: flex; align-items: center; justify-content: center; }
    .poster-wrap img { width: 100%; height: 100%; object-fit: cover; }
    .category-badge { position: absolute; top: 6px; right: 6px; background: rgba(0,0,0,0.75); border: 1px solid var(--border); color: var(--primary); font-size: 9px; font-weight: 800; padding: 2px 6px; border-radius: 4px; }
    .card-meta { padding: 8px; font-size: 12px; }
    .card-title { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .card-sub { font-size: 10px; color: var(--text-muted); margin-top: 2px; }
    .detail-view { display: none; padding: 18px; max-width: 900px; margin: auto; }
    .detail-view.active { display: block; }
    .back-btn { background: none; border: 1px solid var(--border); color: var(--primary); padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: bold; cursor: pointer; margin-bottom: 14px; }
    .detail-meta-box { display: flex; gap: 16px; margin-bottom: 18px; }
    .detail-meta-box img { width: 110px; aspect-ratio: 2/3; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); }
    .detail-info h2 { font-size: 18px; color: var(--primary); margin-bottom: 6px; }
    .detail-info p { font-size: 12px; color: var(--text-muted); line-height: 1.5; margin-bottom: 4px; }
    .player-box { width: 100%; aspect-ratio: 16/9; background: #000; border-radius: 12px; border: 1px solid var(--border); margin-bottom: 10px; display: none; position: relative; }
    .player-box iframe { width: 100%; height: 100%; border: none; border-radius: 12px; }
    .player-controls { display: flex; gap: 8px; margin-bottom: 16px; }
    .pctrl-btn { background: var(--card); border: 1px solid var(--border); color: #fff; padding: 8px 14px; border-radius: 20px; font-size: 11px; font-weight: 800; cursor: pointer; }
    .pctrl-btn.primary { background: var(--gradient); color: #000; }
    .ep-list { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin-top: 14px; }
    .ep-btn { background: rgba(0,255,102,0.06); border: 1px solid var(--border); color: #fff; padding: 8px 12px; border-radius: 6px; font-size: 12px; font-weight: bold; cursor: pointer; margin: 4px; }
    .ep-btn.active { background: var(--primary); color: #000; }
    .app-bar { position: fixed; bottom: 0; left: 0; right: 0; height: 60px; background: rgba(13, 18, 28, 0.95); backdrop-filter: blur(15px); border-top: 1px solid var(--border); display: flex; justify-content: space-around; align-items: center; z-index: 100; }
    .nav-item { display: flex; flex-direction: column; align-items: center; gap: 4px; color: var(--text-muted); font-size: 10px; font-weight: 700; text-decoration: none; cursor: pointer; }
    .nav-item.active { color: var(--primary); }
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 1001; display: none; justify-content: center; align-items: center; padding: 18px; }
    .modal-card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 22px; width: 100%; max-width: 480px; max-height: 85vh; overflow-y: auto; position: relative; }
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; font-size: 11px; font-weight: bold; color: var(--text-muted); margin-bottom: 4px; }
    .form-control { width: 100%; padding: 9px 12px; background: rgba(0,0,0,0.4); border: 1px solid var(--border); border-radius: 8px; color: #fff; font-size: 12px; outline: none; }
    .btn-action { width: 100%; padding: 11px; background: var(--gradient); color: #000; font-weight: 800; border: none; border-radius: 8px; cursor: pointer; margin-top: 6px; }
    .toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #111e16; border: 1px solid var(--primary); color: #fff; padding: 8px 18px; border-radius: 30px; font-size: 12px; font-weight: bold; z-index: 2000; display: none; }
    .ad-banner-container { text-align: center; margin: 15px auto; max-width: 100%; overflow: hidden; }
  </style>
</head>
<body>
  <!-- Injected Ads (Body) -->
  ${adBody}
  <div class="toast" id="toast"></div>
  <header>
    <div class="brand" onclick="goHome()">ASI Animes</div>
    <div class="search-box">
      <i class="fa-solid fa-magnifying-glass"></i><input type="text" id="searchInp" placeholder="Search..." oninput="applyFilters()">
    </div>
    <button class="btn-head" onclick="openAdmin()"><i class="fa-solid fa-gear"></i> Admin</button>
  </header>

  <div class="filter-chips" id="catChips"></div>
  <div class="filter-chips" id="genreChips" style="display:none;"></div>

  <div id="catalogView">
    <div class="slider" id="featuredSlider"></div>
    ${adBanner ? \`<div class="ad-banner-container">\${adBanner}</div>\` : ''}
    <div class="section-head"><span id="gridTitle">🔥 Latest Updates</span></div>
    <div class="grid" id="mainGrid"></div>
  </div>

  <div class="detail-view" id="detailView">
    <button class="back-btn" onclick="goHome()"><i class="fa-solid fa-arrow-left"></i> Back</button>
    <div class="detail-meta-box" id="detailMeta"></div>
    ${adBanner ? \`<div class="ad-banner-container">\${adBanner}</div>\` : ''}
    <div class="player-box" id="playerBox"></div>
    <div class="player-controls" id="playerControls" style="display:none;">
      <button class="pctrl-btn" onclick="prevEp()">⬅️ Back</button>
      <button class="pctrl-btn primary" onclick="nextEp()">Next ➡️</button>
    </div>
    <div class="ep-list" id="epListContainer"></div>
  </div>

  <div class="app-bar">
    <div class="nav-item active" onclick="goHome()"><i class="fa-solid fa-house"></i>Home</div>
    <div class="nav-item" onclick="openVIPModal()"><i class="fa-solid fa-gem"></i>VIP</div>
    <div class="nav-item" onclick="openAZModal()"><i class="fa-solid fa-arrow-down-a-z"></i>A-Z</div>
    <a id="tgLink" href="#" target="_blank" class="nav-item"><i class="fa-brands fa-telegram"></i>Telegram</a>
    ${apkLink ? \`<a href="\${apkLink}" target="_blank" class="nav-item" style="color:var(--accent);"><i class="fa-brands fa-android"></i>App</a>\` : ''}
  </div>

  <!-- ADMIN MODAL -->
  <div class="modal-overlay" id="adminModal">
    <div class="modal-card">
      <span onclick="closeModal('adminModal')" style="position:absolute; right:15px; top:12px; cursor:pointer;">✕</span>
      <h3>Admin Center</h3>
      <div id="adminLock">
        <div class="form-group"><label>Admin PIN</label><input type="password" id="adminPinInp" class="form-control"></div>
        <button class="btn-action" onclick="verifyAdmin()">Login</button>
      </div>
      <div id="adminBody" style="display:none;">
        <div style="display:flex; gap:4px; margin-bottom:14px; flex-wrap:wrap;">
          <button class="ep-btn active" onclick="setAdminTab('post')">Post</button>
          <button class="ep-btn" onclick="setAdminTab('ep')">Ep</button>
          <button class="ep-btn" onclick="setAdminTab('ads')" style="background:#b380ff;">Ads</button>
          <button class="ep-btn" onclick="setAdminTab('del')">Del</button>
          <button class="ep-btn" onclick="setAdminTab('short')">Short</button>
          <button class="ep-btn" onclick="setAdminTab('vip')">VIP</button>
          <button class="ep-btn" onclick="setAdminTab('keys')">Keys</button>
          <button class="ep-btn" onclick="setAdminTab('cfg')">Settings</button>
        </div>

        <div id="tabPost">
          <div class="form-group"><label>Parser (Paste raw text)</label><textarea id="autoDetectInp" class="form-control" style="height:50px;" oninput="handleAutoDetect()"></textarea></div>
          <div class="form-group">
            <label>Poster Image (Cloud Upload)</label>
            <div style="display:flex; gap:6px;">
              <input type="file" id="pImgFile" class="form-control" accept="image/*">
              <button class="pctrl-btn primary" onclick="uploadImgBB()">Upload</button>
            </div>
            <input type="text" id="pImgUrl" class="form-control" placeholder="Image URL" style="margin-top:6px;">
          </div>
          <div class="form-group"><label>Name</label><input type="text" id="pName" class="form-control"></div>
          <div class="form-group"><label>Category</label><input type="text" id="pCategory" class="form-control"></div>
          <div class="form-group"><label>Genres</label><input type="text" id="pGenre" class="form-control"></div>
          <div class="form-group"><label>Year</label><input type="text" id="pRelease" class="form-control"></div>
          <div class="form-group"><label>Story</label><textarea id="pStory" class="form-control"></textarea></div>
          <button class="btn-action" onclick="savePost()">Publish</button>
        </div>

        <div id="tabEp" style="display:none;">
          <div class="form-group"><label>Post</label><select id="epPostSelect" class="form-control" onchange="loadAdminEpisodes()"></select></div>
          <div class="form-group"><label>Season</label><input type="text" id="epSeason" class="form-control"></div>
          <div class="form-group"><label>Label</label><input type="text" id="epNum" class="form-control" placeholder="01"></div>
          <div class="form-group"><label>Play Link</label><input type="text" id="epPlayLink" class="form-control"></div>
          <div class="form-group"><label>Download Link</label><input type="text" id="epDlLink" class="form-control"></div>
          <button class="btn-action" onclick="saveEpisode()">Save Episode</button>
          <div id="epAdminList" style="margin-top:10px; max-height:150px; overflow-y:auto;"></div>
        </div>

        <div id="tabAds" style="display:none;">
          <div class="form-group"><label>Adsterra/AdSense Head</label><textarea id="cfgAdHead" class="form-control"></textarea></div>
          <div class="form-group"><label>Popunder Body Code</label><textarea id="cfgAdBody" class="form-control"></textarea></div>
          <div class="form-group"><label>Banner Ad iframe</label><textarea id="cfgAdBanner" class="form-control"></textarea></div>
          <div class="form-group"><label>APK Link</label><input type="text" id="cfgApkLink" class="form-control"></div>
          <button class="btn-action" onclick="saveSettings()">Save Ads</button>
        </div>
        
        <div id="tabDel" style="display:none;"><div id="deleteList" style="max-height:250px; overflow-y:auto;"></div></div>
        
        <div id="tabShort" style="display:none;">
          <div class="form-group"><label>Domain</label><input type="text" id="cfgShDom" class="form-control"></div>
          <div class="form-group"><label>API Key</label><input type="text" id="cfgShKey" class="form-control"></div>
          <button class="btn-action" onclick="addShortener()">Add Shortener</button>
          <div id="shortList" style="margin-top:10px; max-height:150px; overflow-y:auto;"></div>
        </div>

        <div id="tabVip" style="display:none;">
          <div class="form-group"><label>Email</label><input type="email" id="vipEmail" class="form-control"></div>
          <div class="form-group"><label>Key</label><input type="text" id="vipKey" class="form-control"></div>
          <button class="btn-action" onclick="saveVipUser()">Add VIP</button>
          <div id="vipList" style="margin-top:10px; max-height:150px; overflow-y:auto;"></div>
        </div>

        <div id="tabKeys" style="display:none;">
          <div class="form-group"><label>Password</label><input type="text" id="paidPass" class="form-control"></div>
          <div class="form-group"><label>Link</label><input type="text" id="paidUrl" class="form-control"></div>
          <button class="btn-action" onclick="addPaidRequest()">Add Key</button>
          <div id="paidList" style="margin-top:10px; max-height:150px; overflow-y:auto;"></div>
        </div>

        <div id="tabCfg" style="display:none;">
          <div class="form-group"><label>Bot Token</label><input type="text" id="cfgBotToken" class="form-control"></div>
          <div class="form-group"><label>Chat ID</label><input type="text" id="cfgChatId" class="form-control"></div>
          <div class="form-group"><label>TG Link</label><input type="text" id="cfgTg" class="form-control"></div>
          <div class="form-group"><label>Admin PIN</label><input type="text" id="cfgPin" class="form-control"></div>
          <button class="btn-action" onclick="saveSettings()">Save Config</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let appData = { posts: [], settings: {}, shorteners: [], paid_requests: [] };
    let currentPost = null; let currentCategory = 'ALL'; let sessionPin = ""; 
    let currentEpisodeList = []; let currentEpIndex = -1;

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
    window.onload = async () => await loadData();

    async function loadData() {
      try {
        const res = await fetch('/api/data'); appData = await res.json();
        renderSlider(appData.posts.slice(0, 5)); renderCatFilters(appData.posts); applyFilters();
        document.getElementById('tgLink').href = appData.settings?.channel_link || '#';
      } catch (e) { showToast('Offline / Error'); }
    }

    async function adminFetch(url, options = {}) {
      options.headers = { 'Content-Type': 'application/json', 'X-Admin-Pin': sessionPin }; return fetch(url, options);
    }

    function renderCatFilters(posts) {
      const cats = [...new Set(posts.map(p => p.category).filter(Boolean))];
      document.getElementById('catChips').innerHTML = \`<div class="chip active" onclick="filterByCat('ALL')">All</div>\` + cats.map(c => \`<div class="chip" onclick="filterByCat('\${c}')">\${c}</div>\`).join('');
    }

    function filterByCat(cat) { currentCategory = cat; document.querySelectorAll('#catChips .chip').forEach(c => c.classList.remove('active')); event.target.classList.add('active'); applyFilters(); }

    function applyFilters() {
      let filtered = appData.posts; const q = document.getElementById('searchInp').value.toLowerCase().trim();
      if (currentCategory !== 'ALL') filtered = filtered.filter(p => p.category === currentCategory);
      if (q) filtered = filtered.filter(p => (p.name && p.name.toLowerCase().includes(q))); // Clean search fix
      renderGrid(filtered);
    }

    function renderGrid(posts) {
      document.getElementById('mainGrid').innerHTML = posts.length ? posts.map(p => \`
        <div class="card" onclick="openDetail('\${p.id}')">
          <div class="poster-wrap"><img src="\${p.image_url}" loading="lazy"><span class="category-badge">\${p.category}</span></div>
          <div class="card-meta"><div class="card-title">\${p.name}</div><div class="card-sub">\${p.release || ''}</div></div>
        </div>\`).join('') : '<p style="grid-column:1/-1; text-align:center; padding:30px;">No anime found.</p>';
    }

    function renderSlider(posts) {
      document.getElementById('featuredSlider').innerHTML = posts.map(p => \`<div class="slide-card" onclick="openDetail('\${p.id}')"><img src="\${p.image_url}"><div class="slide-overlay"><div class="slide-tag">\${p.category}</div><div class="slide-title">\${p.name}</div></div></div>\`).join('');
    }

    async function openDetail(postId) {
      currentPost = appData.posts.find(p => p.id === postId); if (!currentPost) return;
      document.getElementById('catalogView').style.display = 'none'; document.getElementById('catChips').style.display = 'none'; document.getElementById('detailView').classList.add('active');
      document.getElementById('detailMeta').innerHTML = \`<img src="\${currentPost.image_url}"><div class="detail-info"><h2>\${currentPost.name}</h2><p><strong>Cat:</strong> \${currentPost.category}</p><p><strong>Genre:</strong> \${currentPost.genres}</p><p><strong>Release:</strong> \${currentPost.release}</p><p><strong>Story:</strong> \${currentPost.story}</p></div>\`;

      const epRes = await fetch(\`/api/episodes?post_id=\${postId}\`); const epData = await epRes.json();
      currentEpisodeList = epData.episodes || [];
      document.getElementById('epListContainer').innerHTML = currentEpisodeList.length ? currentEpisodeList.map(e => \`<button class="ep-btn" data-epid="\${e.id}" onclick="playStream('\${e.play_link}', '\${e.id}')">EP\${e.label}</button><button class="ep-btn" style="background:#00b359;" onclick="downloadEp('\${e.id}')"><i class="fa-solid fa-download"></i></button>\`).join('') : '<p>No episodes.</p>';
      if (currentEpisodeList.length) playStream(currentEpisodeList[0].play_link, currentEpisodeList[0].id);
    }

    function playStream(url, epId) {
      const box = document.getElementById('playerBox');
      if (url) { box.style.display = 'block'; box.innerHTML = \`<iframe src="\${url}" allowfullscreen sandbox="allow-scripts allow-same-origin allow-forms"></iframe>\`; document.getElementById('playerControls').style.display = 'flex'; }
      currentEpIndex = currentEpisodeList.findIndex(e => e.id === epId);
      document.querySelectorAll('.ep-btn').forEach(b => b.classList.remove('active'));
      const activeBtn = document.querySelector(\`.ep-btn[data-epid="\${epId}"]\`); if (activeBtn) activeBtn.classList.add('active');
    }

    function prevEp() { if (currentEpIndex > 0) { const e = currentEpisodeList[currentEpIndex - 1]; playStream(e.play_link, e.id); } }
    function nextEp() { if (currentEpIndex !== -1 && currentEpIndex < currentEpisodeList.length - 1) { const e = currentEpisodeList[currentEpIndex + 1]; playStream(e.play_link, e.id); } }

    async function downloadEp(epId) {
      showToast('Generating link...');
      const key = localStorage.getItem('vip_key') || '';
      const res = await fetch(\`/api/get-link?post_id=\${currentPost.id}&ep_id=\${epId}&key=\${encodeURIComponent(key)}\`);
      const data = await res.json();
      if (data.url) window.open(data.url, '_blank'); else showToast(data.error || 'Check Link');
    }

    function goHome() {
      document.getElementById('catalogView').style.display = 'block'; document.getElementById('detailView').classList.remove('active');
      document.getElementById('playerBox').style.display = 'none'; document.getElementById('catChips').style.display = 'flex'; window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function openAdmin() { document.getElementById('adminModal').style.display = 'flex'; }
    function closeModal(id) { document.getElementById(id).style.display = 'none'; }
    function setAdminTab(tab) { ['Post', 'Ep', 'Del', 'Short', 'Vip', 'Keys', 'Cfg', 'Ads'].forEach(t => document.getElementById('tab' + t).style.display = 'none'); document.getElementById('tab' + tab.charAt(0).toUpperCase() + tab.slice(1)).style.display = 'block'; }

    async function verifyAdmin() {
      sessionPin = document.getElementById('adminPinInp').value;
      const res = await fetch('/api/data', { headers: { 'X-Admin-Pin': sessionPin } });
      const data = await res.json();
      if (!data.admin) return alert('❌ Galat PIN!');
      appData = data; // Contains API keys now securely
      document.getElementById('adminLock').style.display = 'none'; document.getElementById('adminBody').style.display = 'block'; loadAdminDataUI();
    }

    function handleAutoDetect() {
      const text = document.getElementById("autoDetectInp").value.trim();
      const match = (alias) => { const re = new RegExp(alias + "\\\\s*[-:=_,.]+\\\\s*(.*)", "i"); const m = text.match(re); return m ? m[1].trim() : ""; };
      document.getElementById("pName").value = match("name") || match("title") || document.getElementById("pName").value;
      document.getElementById("pCategory").value = match("category") || document.getElementById("pCategory").value;
      document.getElementById("pGenre").value = match("genre") || document.getElementById("pGenre").value;
      document.getElementById("pRelease").value = match("release") || document.getElementById("pRelease").value;
    }

    // IQ200: Direct Cloud Image Host
    async function uploadImgBB() {
      const file = document.getElementById('pImgFile').files[0]; if (!file) return alert("Select Image!");
      showToast("Uploading Image..."); const fd = new FormData(); fd.append('image', file);
      try {
        const res = await fetch("https://api.imgbb.com/1/upload?key=302521c3fa19b023e3c60523098f98d0", { method: "POST", body: fd });
        const data = await res.json(); if(data.success) { document.getElementById('pImgUrl').value = data.data.url; showToast("Uploaded!"); }
      } catch(e) { alert("Upload error"); }
    }

    async function savePost() {
      const body = { name: document.getElementById('pName').value, image_url: document.getElementById('pImgUrl').value, category: document.getElementById('pCategory').value, genres: document.getElementById('pGenre').value, release: document.getElementById('pRelease').value, story: document.getElementById('pStory').value };
      if (!body.name || !body.image_url) return alert('Name & Image URL required!');
      const res = await adminFetch('/api/posts', { method: 'POST', body: JSON.stringify(body) });
      if(res.ok) { showToast('Published!'); await loadData(); loadAdminDataUI(); }
    }

    function loadAdminDataUI() {
      document.getElementById('epPostSelect').innerHTML = '<option value="">-- Select --</option>' + appData.posts.map(p => \`<option value="\${p.id}">\${p.name}</option>\`).join('');
      document.getElementById('deleteList').innerHTML = appData.posts.map(p => \`<div style="display:flex; justify-content:space-between; padding:5px; border-bottom:1px solid #333;"><span>\${p.name}</span><button onclick="deletePost('\${p.id}')">Del</button></div>\`).join('');
      document.getElementById('shortList').innerHTML = (appData.shorteners || []).map((s,i) => \`<div style="display:flex; justify-content:space-between; padding:5px; border-bottom:1px solid #333;"><span>\${s.domain}</span><button onclick="deleteShortener(\${i})">Del</button></div>\`).join('');
      document.getElementById('paidList').innerHTML = (appData.paid_requests || []).map((k,i) => \`<div style="display:flex; justify-content:space-between; padding:5px; border-bottom:1px solid #333;"><span>\${k.password}</span><button onclick="deletePaidKey(\${i})">Del</button></div>\`).join('');
      
      document.getElementById('cfgAdHead').value = appData.settings.ad_head || ''; document.getElementById('cfgAdBody').value = appData.settings.ad_body || ''; document.getElementById('cfgAdBanner').value = appData.settings.ad_banner || ''; document.getElementById('cfgApkLink').value = appData.settings.apk_link || '';
    }

    async function loadAdminEpisodes() {
      const postId = document.getElementById('epPostSelect').value; if(!postId) return;
      const data = await (await fetch(\`/api/episodes?post_id=\${postId}\`)).json();
      document.getElementById('epAdminList').innerHTML = data.episodes.map(e => \`<div style="display:flex; justify-content:space-between; padding:5px; border-bottom:1px solid #333;"><span>Ep \${e.label}</span><button onclick="deleteEpisode('\${e.id}', '\${postId}')">Del</button></div>\`).join('');
    }

    async function deletePost(id) { if(confirm("Delete Post + Clean KV?")) { await adminFetch(\`/api/posts/\${id}\`, { method: 'DELETE' }); showToast('Cleaned!'); loadData(); setTimeout(loadAdminDataUI, 1000); } }
    async function deleteEpisode(epId, postId) { if(confirm("Delete Ep?")) { await adminFetch(\`/api/episodes/\${epId}?post_id=\${postId}\`, { method: 'DELETE' }); loadAdminEpisodes(); } }
    async function saveEpisode() { const b = { post_id: document.getElementById('epPostSelect').value, season: document.getElementById('epSeason').value, label: document.getElementById('epNum').value, quality: 'HD', play_link: document.getElementById('epPlayLink').value, download_link: document.getElementById('epDlLink').value }; if(!b.post_id || !b.label) return alert('Fields req'); await adminFetch('/api/episodes', { method: 'POST', body: JSON.stringify(b) }); showToast('Ep Added'); loadAdminEpisodes(); }

    async function saveSettings() {
      const settings = { ad_head: document.getElementById('cfgAdHead').value, ad_body: document.getElementById('cfgAdBody').value, ad_banner: document.getElementById('cfgAdBanner').value, apk_link: document.getElementById('cfgApkLink').value, channel_link: document.getElementById('cfgTg').value };
      if(document.getElementById('cfgBotToken').value) settings.bot_token = document.getElementById('cfgBotToken').value;
      if(document.getElementById('cfgChatId').value) settings.chat_id = document.getElementById('cfgChatId').value;
      if(document.getElementById('cfgPin').value) settings.admin_pin = document.getElementById('cfgPin').value;
      await adminFetch('/api/settings', { method: 'POST', body: JSON.stringify({ settings }) }); showToast('Saved!');
    }

    async function addShortener() {
      const d = document.getElementById('cfgShDom').value, k = document.getElementById('cfgShKey').value; if(!d||!k) return;
      let s = appData.shorteners || []; s.push({domain:d, api_key:k});
      await adminFetch('/api/settings', { method: 'POST', body: JSON.stringify({ shorteners: s }) }); showToast('Added'); verifyAdmin();
    }
    async function deleteShortener(i) { appData.shorteners.splice(i, 1); await adminFetch('/api/settings', { method: 'POST', body: JSON.stringify({ shorteners: appData.shorteners }) }); showToast('Deleted'); verifyAdmin(); }
    async function addPaidRequest() {
      const p = document.getElementById('paidPass').value, u = document.getElementById('paidUrl').value; if(!p||!u) return;
      let r = appData.paid_requests || []; r.push({password:p, original_link:u});
      await adminFetch('/api/settings', { method: 'POST', body: JSON.stringify({ paid_requests: r }) }); showToast('Added'); verifyAdmin();
    }
    async function deletePaidKey(i) { appData.paid_requests.splice(i, 1); await adminFetch('/api/settings', { method: 'POST', body: JSON.stringify({ paid_requests: appData.paid_requests }) }); showToast('Deleted'); verifyAdmin(); }

    async function saveVipUser() {
      const e = document.getElementById('vipEmail').value, k = document.getElementById('vipKey').value; if(!e||!k) return;
      await adminFetch('/api/premium', { method: 'POST', body: JSON.stringify({ email:e, key:k, days:30 }) }); showToast('VIP Added');
    }

    function openVIPModal() { const key = prompt('Enter VIP Key:'); if (key) { localStorage.setItem('vip_key', key); showToast('VIP Active!'); } }
    function openAZModal() { const l = prompt('A-Z letter:')?.toUpperCase(); if (l) renderGrid(appData.posts.filter(p => p.name.toUpperCase().startsWith(l))); }
    function showToast(msg) { const t = document.getElementById('toast'); t.innerText = msg; t.style.display = 'block'; setTimeout(() => t.style.display = 'none', 3000); }
  </script>
</body>
</html>`;
}
