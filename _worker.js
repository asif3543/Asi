/**
 * ASI Animes / AnimeBox - Cloudflare Worker Core Engine
 * SINGLE SITE + APK EDITION - PRO FULL VERSION
 * Features: Adsterra/Monetag, APK, ImgBB Permanent CDN, Strict Security, 
 * Zero Memory Leaks, Smart Caching, STRICT SHORTENER LOCK (No leaks).
 */

export default {
  async fetch(request, env, ctx) {
    // 1. CORS Preflight - Fixes Admin Panel saving errors & GitHub deployment blocks
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
      status, 
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });

    const kvGet = async (key, defaultVal = null) => {
      if (env.ANIME_KV) {
        const val = await env.ANIME_KV.get(key, "json");
        return val !== null ? val : defaultVal;
      }
      return defaultVal;
    };
    
    const kvSet = async (key, val) => {
      if (env.ANIME_KV) {
        await env.ANIME_KV.put(key, JSON.stringify(val));
      }
    };

    const kvDelete = async (key) => {
      if (env.ANIME_KV) {
        await env.ANIME_KV.delete(key);
      }
    };

    const isAdmin = async () => {
      const s = (await kvGet("settings", {})) || {};
      const actualPin = s.admin_pin || "admin123";
      return adminPinHeader === actualPin;
    };

    const sendTelegramNotification = async (settings, text, photoUrl = null) => {
      if (!settings.bot_token || !settings.chat_id) {
        return { ok: false, reason: "TG Not Setup" };
      }
      try {
        const tgForm = new FormData();
        tgForm.append("chat_id", settings.chat_id);
        tgForm.append("parse_mode", "HTML");
        let res;
        if (photoUrl && photoUrl.startsWith("http")) {
          tgForm.append("photo", photoUrl);
          tgForm.append("caption", text);
          res = await fetch(`https://api.telegram.org/bot${settings.bot_token}/sendPhoto`, { method: "POST", body: tgForm });
        } else {
          tgForm.append("text", text);
          res = await fetch(`https://api.telegram.org/bot${settings.bot_token}/sendMessage`, { method: "POST", body: tgForm });
        }
        if (!res.ok) return { ok: false, reason: await res.text() };
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: String(err) };
      }
    };

    // =========================================================================
    // 🚀 PWA ENGINE: SMART CACHING
    // =========================================================================

    if (url.pathname === "/manifest.json") {
      const manifest = {
        name: "ASI Animes - Ultimate Anime Portal",
        short_name: "ASI Animes",
        description: "Watch and download high-definition anime, dramas, and movies.",
        start_url: "/",
        display: "standalone",
        background_color: "#05080c",
        theme_color: "#00ff66",
        icons: [
          { src: "https://placehold.co/192x192/05080c/00ff66.png?text=AB", sizes: "192x192", type: "image/png" },
          { src: "https://placehold.co/512x512/05080c/00ff66.png?text=AB", sizes: "512x512", type: "image/png" }
        ]
      };
      return new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Access-Control-Allow-Origin": "*" } });
    }

    if (url.pathname === "/sw.js") {
      const swScript = `
        const CACHE_NAME = 'animebox-pwa-v10';
        const STATIC_ASSETS = ['/', '/manifest.json', 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'];
        self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))); self.skipWaiting(); });
        self.addEventListener('activate', (e) => { self.clients.claim(); });
        self.addEventListener('fetch', (e) => {
          if (e.request.method !== 'GET' || e.request.url.includes('/api/') || e.request.url.match(/\\.(mp4|m3u8|ts)$/i)) return;
          e.respondWith(caches.match(e.request).then(cached => {
            return fetch(e.request).then(res => {
              if (res && res.status === 200 && e.request.url.startsWith('http')) {
                const resClone = res.clone(); caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone));
              } return res;
            }).catch(() => cached);
          }));
        });
      `;
      return new Response(swScript, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Service-Worker-Allowed": "/" } });
    }

    // =========================================================================
    // API ENDPOINTS
    // =========================================================================

    if (url.pathname === "/api/data" && method === "GET") {
      let posts = (await kvGet("posts", [])) || [];
      posts.sort((a, b) => b.updatedAt - a.updatedAt);
      const settings = (await kvGet("settings", { site_name: "ASI Animes", channel_link: "https://t.me/" })) || {};
      
      // SECURITY: Public users only see safe settings (Ads, APK)
      const safeSettings = { 
        channel_link: settings.channel_link,
        ad_head: settings.ad_head,
        ad_body: settings.ad_body,
        ad_banner: settings.ad_banner,
        apk_link: settings.apk_link
      };

      // SECURITY: Only Admin gets API Keys and Decrypt Passwords
      if (await isAdmin()) {
        const shorteners = (await kvGet("shorteners", [])) || [];
        const paid_requests = (await kvGet("paid_requests", [])) || [];
        // Send full settings to admin
        return json({ posts, settings, shorteners, paid_requests, admin: true });
      }

      return json({ posts, settings: safeSettings });
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
      await kvSet("posts", posts);

      let telegramResult = { ok: true };
      let hashGenres = newPost.genres.split(/[,.]+/).map(g => g.trim()).filter(g => g).map(g => '#' + g.replace(/\s+/g, '')).join(' ');
      const escHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const tgMsg = "Name: <b>" + escHtml(newPost.name) + "</b> ❞\n\nCategory:\n<b>" + escHtml(newPost.category) + "</b> ❞\n\nGenre: " + escHtml(hashGenres) + "\nRelease: " + escHtml(newPost.release || '-') + "\n\n🔥 ╰┈➤ ♡𝙰𝙽𝙸𝙼𝙴 𝙱𝚈_𝙰𝚂𝙸✨\n⚓➠★★: @ASIgroup\n\n📖 " + escHtml(newPost.story);
      
      telegramResult = await sendTelegramNotification(settings, tgMsg, newPost.image_url);

      return json({ success: true, post: newPost, telegram: telegramResult });
    }

    if (url.pathname.startsWith("/api/posts/") && method === "DELETE") {
      if (!(await isAdmin())) return json({ error: "Unauthorized" }, 401);
      const id = url.pathname.split("/").pop();
      let posts = (await kvGet("posts", [])) || [];
      posts = posts.filter(p => p.id !== id);
      await kvSet("posts", posts);
      await kvDelete(`ep_${id}`); // Clean KV Memory Properly
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
        id: body.id || "ep_" + Date.now(),
        post_id: body.post_id,
        season: body.season || "",
        label: body.label || "01",
        quality: body.quality || "HD",
        play_link: body.play_link || "",
        download_link: body.download_link || ""
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
      const now = new Date();
      const validUsers = users.filter(u => new Date(u.expires_at) > now);
      if (users.length !== validUsers.length) {
        await kvSet("premium_users", validUsers);
      }
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

    // STRICT SHORTENER LOGIC - NEVER EXPOSE ORIGINAL LINK
    if (url.pathname === "/api/get-link") {
      const epId = url.searchParams.get("ep_id"); 
      const postId = url.searchParams.get("post_id");
      const userKey = url.searchParams.get("key");
      const deviceId = url.searchParams.get("device_id");
      
      const episodes = (await kvGet(`ep_${postId}`, [])) || []; 
      const ep = episodes.find(e => e.id === epId);
      if (!ep) return json({ error: "Episode not found" }, 404);
      const targetUrl = ep.download_link || ep.play_link; 
      if (!targetUrl) return json({ error: "Empty link" }, 400);
      
      // VIP CHECK (Only VIP gets direct link)
      let isPremium = false;
      const premiumUsers = (await kvGet("premium_users", [])) || [];
      if (userKey) {
        const user = premiumUsers.find(u => u.key === userKey || u.email === userKey);
        if (user && new Date(user.expires_at) > new Date()) {
          isPremium = true;
          if (deviceId) {
            if (!user.device_id) { user.device_id = deviceId; await kvSet("premium_users", premiumUsers); }
            else if (user.device_id !== deviceId) isPremium = false; 
          }
        }
      }

      if (isPremium) return json({ direct: true, url: targetUrl, premium: true });

      const shorteners = (await kvGet("shorteners", [])) || [];
      let activeShorteners = shorteners;
      if (activeShorteners.length === 0) {
        const s = (await kvGet("settings", {})) || {};
        if (s.shorteners && s.shorteners.length > 0) activeShorteners = s.shorteners;
      }
      
      if (activeShorteners.length > 0) {
        const activeSh = activeShorteners[Math.floor(Math.random() * activeShorteners.length)];

        const extractShortUrl = (raw) => {
          if (!raw) return null;
          const t = raw.trim();
          if (t.startsWith("http")) return t;
          try {
            const j = JSON.parse(t);
            const cand = j.shortenedUrl || j.short_url || j.shortUrl || j.url || j.link || j.data || j.result;
            if (typeof cand === "string" && cand.startsWith("http")) return cand;
          } catch (e) {}
          const m = t.match(/https?:\/\/[^\s"']+/);
          return m ? m[0] : null;
        };

        try {
          const rawDomain = activeSh.dashboard_url || activeSh.domain || "";
          const domain = rawDomain.replace(/^(https?:\/\/)?(www\.)?/, "").replace(/\/$/, "").split("/")[0];
          const apiKey = activeSh.api_key || activeSh.apiKey;
          const enc = encodeURIComponent(targetUrl);

          const apiDomain = domain.startsWith("api.") ? domain : "api." + domain;
          
          // Timeout to prevent 504 Gateway Timeout on Cloudflare
          const fetchPromise = fetch(`https://${apiDomain}/api?api=${apiKey}&url=${enc}&format=text`, {
            method: 'GET',
            headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
          });
          
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 4000));
          const r = await Promise.race([fetchPromise, timeoutPromise]);
          
          if (r.ok) {
            const txt = await r.text();
            const shortLink = extractShortUrl(txt);
            if (shortLink) {
              return json({ direct: false, url: shortLink, shortener: domain });
            }
          }
        } catch (err) {
           // Ignore to throw strict error below
        }
        
        // STRICT LOCK: If Shortener API is down or fails, DO NOT give direct link. Give Error.
        return json({ error: "Shortener server is busy. Please try clicking download again." }, 500);
      }
      
      // If Admin has deleted ALL shorteners, then obviously they want it direct
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
      
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + parseInt(body.days || 30));

      const newUser = {
        id: "usr_" + Date.now(),
        email: body.email.toLowerCase().trim(),
        key: body.key.trim(),
        expires_at: expiry.toISOString(),
        device_id: null
      };

      users = users.filter(u => u.email !== newUser.email && u.key !== newUser.key);
      users.unshift(newUser);
      await kvSet("premium_users", users);

      // Async telegram notify so it doesn't block response
      const settings = (await kvGet("settings", {})) || {};
      const tgMsg = `💎 <b>New VIP Pass Activated!</b>\n\n📧 <b>Email:</b> ${newUser.email}\n🔑 <b>Key:</b> ${newUser.key}\n⏳ <b>Expires:</b> ${expiry.toLocaleString()}`;
      
      // Workaround for ctx.waitUntil issue if needed, but Cloudflare supports it here normally.
      ctx.waitUntil(sendTelegramNotification(settings, tgMsg));

      return json({ success: true, user: newUser });
    }

    if (url.pathname === "/api/settings" && method === "POST") {
      if (!(await isAdmin())) return json({ error: "Unauthorized" }, 401);
      const body = await request.json();
      const oldSettings = (await kvGet("settings", {})) || {};
      const mergedSettings = { ...oldSettings };
      
      if (body.settings) {
        for (const [key, value] of Object.entries(body.settings)) {
          if (value !== undefined) mergedSettings[key] = value;
        }
        await kvSet("settings", mergedSettings);
      }
      if (body.shorteners !== undefined) {
        await kvSet("shorteners", body.shorteners);
        mergedSettings.shorteners = body.shorteners;
      }
      if (body.paid_requests !== undefined) {
        await kvSet("paid_requests", body.paid_requests);
      }
      return json({ success: true });
    }

    // SERVER-SIDE HTML RENDER
    const siteSettings = (await kvGet("settings", {})) || {};
    return new Response(renderFullAppHTML(siteSettings), {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
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
  
  <title>ASI Animes | Watch Hindi Sub & Hindi Dub Anime Online</title>
  <meta name="description" content="Best website to download and watch Hindi dub anime, English sub anime, and latest series for free.">
  <meta name="theme-color" content="#00ff66">
  <meta name="apple-mobile-web-app-capable" content="yes">
  
  <link rel="manifest" href="/manifest.json">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  
  <!-- Server Injected Ads (Head) - Monetag / AdSense Script -->
  ${adHead}

  <style>
    :root {
      --bg: #05080c;
      --card: #0d121c;
      --card-hover: #141b29;
      --primary: #00ff66;
      --accent: #00f2fe;
      --text: #f0fdf4;
      --text-muted: #94a3b8;
      --border: rgba(0, 255, 102, 0.15);
      --gradient: linear-gradient(135deg, #00ff66 0%, #00f2fe 100%);
      --glow: rgba(0, 255, 102, 0.2);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; -webkit-tap-highlight-color: transparent; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; overflow-x: hidden; padding-bottom: 75px; }

    header { position: sticky; top: 0; z-index: 100; background: rgba(5, 8, 12, 0.9); backdrop-filter: blur(16px); border-bottom: 1px solid var(--border); padding: 12px 18px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .brand { font-size: 22px; font-weight: 900; background: var(--gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; cursor: pointer; letter-spacing: 1px; }
    .search-box { flex: 1; max-width: 380px; position: relative; }
    .search-box input { width: 100%; padding: 8px 14px 8px 36px; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border); border-radius: 20px; color: #fff; font-size: 13px; outline: none; }
    .search-box input:focus { border-color: var(--primary); box-shadow: 0 0 10px var(--glow); }
    .search-box i { position: absolute; left: 12px; top: 10px; color: var(--text-muted); font-size: 13px; }
    
    .btn-head { background: var(--gradient); color: #000; font-weight: 800; border: none; padding: 7px 14px; border-radius: 18px; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 6px; }

    .filter-chips { display: flex; gap: 8px; overflow-x: auto; padding: 10px 18px; scrollbar-width: none; border-bottom: 1px solid rgba(0,255,102,0.05); }
    .filter-chips::-webkit-scrollbar { display: none; }
    .chip { background: var(--card); border: 1px solid var(--border); color: #fff; padding: 6px 14px; border-radius: 20px; font-size: 11px; font-weight: 700; white-space: nowrap; cursor: pointer; transition:0.2s; }
    .chip.active, .chip:hover { background: var(--primary); color: #000; border-color: var(--primary); }

    .slider { display: flex; gap: 15px; overflow-x: auto; padding: 12px 18px; scroll-snap-type: x mandatory; scrollbar-width: none; }
    .slider::-webkit-scrollbar { display: none; }
    .slide-card { flex: 0 0 280px; height: 160px; border-radius: 14px; overflow: hidden; position: relative; border: 1px solid var(--border); cursor: pointer; scroll-snap-align: start; }
    .slide-card img { width: 100%; height: 100%; object-fit: cover; }
    .slide-overlay { position: absolute; inset: 0; background: linear-gradient(to top, #05080c 20%, transparent 80%); display: flex; flex-direction: column; justify-content: flex-end; padding: 12px; }
    .slide-title { font-size: 14px; font-weight: bold; }
    .slide-tag { font-size: 10px; color: var(--primary); font-weight: 800; text-transform: uppercase; }

    .section-head { padding: 8px 18px; font-size: 16px; font-weight: 800; display: flex; justify-content: space-between; align-items: center; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 14px; padding: 0 18px 20px 18px; }
    .card { background: var(--card); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); cursor: pointer; transition: 0.2s; position: relative; display: flex; flex-direction: column; }
    .card:active { transform: scale(0.97); }
    .poster-wrap { width: 100%; aspect-ratio: 2/3; background: #0c1410; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center; text-align: center; }
    .poster-wrap img { width: 100%; height: 100%; object-fit: cover; }
    .no-img-text { padding: 10px; font-size: 12px; font-weight: bold; color: var(--primary); text-transform: uppercase; }
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

    .player-box { width: 100%; aspect-ratio: 16/9; background: #000; border-radius: 12px; overflow: visible; border: 1px solid var(--border); margin-bottom: 10px; display: none; transition:0.3s; position: relative; }
    .player-box.theater { aspect-ratio: 16/10; max-height: 70vh; }
    .player-box.full { position: fixed; inset: 0; z-index: 9999; aspect-ratio: auto; width: 100vw; height: 100vh; border-radius: 0; }
    .player-box.floating-pip { position: fixed; bottom: 80px; right: 12px; width: 200px; aspect-ratio: 16/9; z-index: 500; box-shadow: 0 6px 24px rgba(0,0,0,0.7); border-radius: 8px; }
    .player-menu-btn { position: absolute; top: 8px; right: 8px; z-index: 20; background: rgba(0,0,0,0.55); border: none; color: #fff; width: 32px; height: 32px; border-radius: 50%; font-size: 15px; cursor: pointer; align-items: center; justify-content: center; }
    .player-menu { position: absolute; top: 44px; right: 8px; z-index: 21; background: rgba(15,20,15,0.97); border: 1px solid var(--border); border-radius: 10px; padding: 6px; display: none; min-width: 150px; }
    .player-menu.open { display: block; }
    .player-menu-item { padding: 9px 12px; font-size: 12px; color: #fff; cursor: pointer; border-radius: 6px; display: flex; align-items: center; gap: 8px; }
    .player-menu-item:hover { background: rgba(0,255,102,0.12); color: var(--primary); }
    .player-box iframe { width: 100%; height: 100%; border: none; border-radius: 12px; }
    
    .player-controls { display: flex; gap: 8px; overflow-x: auto; margin-bottom: 16px; scrollbar-width: none; }
    .player-controls::-webkit-scrollbar { display: none; }
    .pctrl-btn { background: var(--card); border: 1px solid var(--border); color: #fff; padding: 8px 14px; border-radius: 20px; font-size: 11px; font-weight: 800; white-space: nowrap; cursor: pointer; }
    .pctrl-btn.primary { background: var(--gradient); color: #000; }
    .pctrl-btn:hover { background: var(--primary); color: #000; }

    .ep-list { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin-top: 14px; }
    .ep-btn { background: rgba(0,255,102,0.06); border: 1px solid var(--border); color: #fff; padding: 8px 12px; border-radius: 6px; font-size: 12px; font-weight: bold; cursor: pointer; margin: 4px; }
    .ep-btn:hover, .ep-btn.active { background: var(--primary); color: #000; }

    .app-bar { position: fixed; bottom: 0; left: 0; right: 0; height: 60px; background: rgba(13, 18, 28, 0.95); backdrop-filter: blur(15px); border-top: 1px solid var(--border); display: flex; justify-content: space-around; align-items: center; z-index: 100; }
    .nav-item { display: flex; flex-direction: column; align-items: center; gap: 4px; color: var(--text-muted); font-size: 10px; font-weight: 700; text-decoration: none; cursor: pointer; }
    .nav-item i { font-size: 18px; }
    .nav-item.active { color: var(--primary); }

    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 1001; display: none; justify-content: center; align-items: center; padding: 18px; }
    .modal-card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 22px; width: 100%; max-width: 480px; max-height: 85vh; overflow-y: auto; position: relative; }
    .modal-card h3 { margin-bottom: 12px; color: var(--primary); font-size: 18px; }
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; font-size: 11px; font-weight: bold; color: var(--text-muted); margin-bottom: 4px; }
    .form-control { width: 100%; padding: 9px 12px; background: rgba(0,0,0,0.4); border: 1px solid var(--border); border-radius: 8px; color: #fff; font-size: 12px; outline: none; }
    .form-control:focus { border-color: var(--primary); }
    .btn-action { width: 100%; padding: 11px; background: var(--gradient); color: #000; font-weight: 800; border: none; border-radius: 8px; cursor: pointer; margin-top: 6px; }

    .toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #111e16; border: 1px solid var(--primary); color: #fff; padding: 8px 18px; border-radius: 30px; font-size: 12px; font-weight: bold; z-index: 2000; display: none; }
    
    /* Ads Styling */
    .ad-banner-container { text-align: center; margin: 15px auto; max-width: 100%; overflow: hidden; display: flex; justify-content: center; }
  </style>
</head>
<body>

  <!-- Server Injected Ads (Body) - Adsterra Popunder etc. -->
  ${adBody}

  <div class="toast" id="toast"></div>

  <header>
    <div class="brand" onclick="goHome()">ASI Animes</div>
    <div class="search-box">
      <i class="fa-solid fa-magnifying-glass"></i>
      <input type="text" id="searchInp" placeholder="Search anime, dramas, movie..." oninput="applyFilters()">
    </div>
    <button class="btn-head" onclick="openAdmin()"><i class="fa-solid fa-gear"></i> Admin</button>
  </header>

  <div class="filter-chips" id="catChips"></div>
  <div class="filter-chips" id="genreChips" style="display:none; padding-top:10px; border-bottom:1px solid rgba(0,255,102,0.1);"></div>

  <div id="catalogView">
    <div class="slider" id="featuredSlider"></div>
    
    <!-- Banner Ad Space (Catalog) -->
    ${adBanner ? `<div class="ad-banner-container">${adBanner}</div>` : ''}

    <div class="section-head">
      <span id="gridTitle">🔥 Latest Updates</span>
    </div>
    <div class="grid" id="mainGrid"></div>
  </div>

  <div class="detail-view" id="detailView">
    <button class="back-btn" onclick="goHome()"><i class="fa-solid fa-arrow-left"></i> Back to Catalog</button>
    <div class="detail-meta-box" id="detailMeta"></div>
    
    <!-- Banner Ad Space (Player Top) -->
    ${adBanner ? `<div class="ad-banner-container">${adBanner}</div>` : ''}

    <div class="player-box" id="playerBox">
      <button class="player-menu-btn" id="playerMenuBtn" onclick="togglePlayerMenu()" style="display:none;">
        <i class="fa-solid fa-ellipsis-vertical"></i>
      </button>
      <div class="player-menu" id="playerMenu">
        <div class="player-menu-item" onclick="toggleTheater(); togglePlayerMenu();"><i class="fa-solid fa-film"></i> Small / Big</div>
        <div class="player-menu-item" onclick="togglePiP(); togglePlayerMenu();"><i class="fa-solid fa-tv"></i> PiP Popup</div>
        <div class="player-menu-item" onclick="toggleFullscreen(); togglePlayerMenu();"><i class="fa-solid fa-expand"></i> Fullscreen</div>
      </div>
    </div>
    <div class="player-controls" id="playerControls" style="display:none;">
      <button class="pctrl-btn" onclick="prevEp()">⬅️ Back</button>
      <button class="pctrl-btn primary" onclick="nextEp()">Next Episode ➡️</button>
    </div>
    <div class="ep-list" id="epListContainer"></div>
  </div>

  <div class="app-bar">
    <div class="nav-item active" onclick="goHome()"><i class="fa-solid fa-house"></i>Home</div>
    <div class="nav-item" onclick="openVIPModal()"><i class="fa-solid fa-gem"></i>VIP Pass</div>
    <div class="nav-item" onclick="openDecryptModal()"><i class="fa-solid fa-key"></i>Unlock Key</div>
    <div class="nav-item" onclick="openAZModal()"><i class="fa-solid fa-arrow-down-a-z"></i>A-Z</div>
    <a id="tgLink" href="#" target="_blank" class="nav-item"><i class="fa-brands fa-telegram"></i>Telegram</a>
    
    <!-- Dynamic APK Download Button -->
    ${apkLink ? `<a href="${apkLink}" target="_blank" class="nav-item" style="color:var(--accent);"><i class="fa-brands fa-android"></i>App</a>` : ''}
  </div>

  <div class="modal-overlay" id="genreModal">
    <div class="modal-card">
      <span onclick="closeModal('genreModal')" style="position:absolute; right:15px; top:12px; cursor:pointer; font-size:18px;">✕</span>
      <h3><i class="fa-solid fa-masks-theater"></i> Browse by Genre</h3>
      <div id="genreModalList" style="display:flex; flex-wrap:wrap; gap:6px; margin-top:10px;"></div>
    </div>
  </div>

  <div class="modal-overlay" id="adminModal">
    <div class="modal-card">
      <span onclick="closeModal('adminModal')" style="position:absolute; right:15px; top:12px; cursor:pointer; font-size:18px;">✕</span>
      <h3>Admin Control Center</h3>
      
      <div id="adminLock">
        <div class="form-group">
          <label>Admin PIN Passcode</label>
          <input type="password" id="adminPinInp" class="form-control" placeholder="Default PIN: admin123">
        </div>
        <button class="btn-action" onclick="verifyAdmin()">Unlock Control Center</button>
      </div>

      <div id="adminBody" style="display:none;">
        <div style="display:flex; gap:4px; margin-bottom:14px; overflow-x:auto; flex-wrap:wrap;">
          <button class="ep-btn active" onclick="setAdminTab('post')">Add Post</button>
          <button class="ep-btn" onclick="setAdminTab('ep')">Episodes</button>
          <button class="ep-btn" style="background:#b380ff;" onclick="setAdminTab('ads')">Ads & App</button>
          <button class="ep-btn" onclick="setAdminTab('del')">Delete Posts</button>
          <button class="ep-btn" onclick="setAdminTab('short')">Shorteners</button>
          <button class="ep-btn" onclick="setAdminTab('vip')">VIP Passes</button>
          <button class="ep-btn" onclick="setAdminTab('paid')">Decrypt Keys</button>
          <button class="ep-btn" onclick="setAdminTab('cfg')">Settings</button>
        </div>

        <div id="tabPost">
          <div class="form-group" style="background: rgba(0,255,102,0.04); padding:10px; border-radius:8px; border:1px dashed var(--border);">
            <label style="color:var(--primary);"><i class="fa-solid fa-wand-magic-sparkles"></i> Auto Post Fill Parser</label>
            <textarea id="autoDetectInp" class="form-control" style="height:80px; font-size:11px;" placeholder="Paste raw text details (Name: Naruto, Season: 1, Story: ...)" oninput="handleAutoDetect()"></textarea>
          </div>
          <div class="form-group">
            <label>Poster Image (ImgBB Permanent Cloud Upload)</label>
            <div style="display:flex; gap:6px;">
              <input type="file" id="pImgFile" class="form-control" accept="image/*">
              <button type="button" class="pctrl-btn primary" onclick="uploadImgBB()">Upload API</button>
            </div>
            <input type="text" id="pImgUrl" class="form-control" placeholder="Direct Image URL (Or paste external link)" style="margin-top:6px;" required>
          </div>
          <div class="form-group">
            <label>Post/Anime Name</label>
            <input type="text" id="pName" class="form-control" required placeholder="e.g. Solo Leveling">
          </div>
          <div class="form-group">
            <label>Category Group</label>
            <input type="text" id="pCategory" class="form-control" placeholder="e.g. Hindi Subbed Anime" required>
          </div>
          <div class="form-group">
            <label>Genres (comma se separate karo)</label>
            <input type="text" id="pGenre" class="form-control" placeholder="Action, Dark Fantasy, Adventure">
          </div>
          <div class="form-group">
            <label>Release Year</label>
            <input type="text" id="pRelease" class="form-control" placeholder="2025">
          </div>
          <div class="form-group">
            <label>Short Story/Synopsis</label>
            <textarea id="pStory" class="form-control" style="height:60px;"></textarea>
          </div>
          <button class="btn-action" onclick="savePost()">Publish Post</button>
        </div>

        <div id="tabEp" style="display:none;">
          <div class="form-group">
            <label>Target Anime Post</label>
            <select id="epPostSelect" class="form-control" onchange="loadAdminEpisodes()"></select>
          </div>
          <div class="form-group">
            <label>Season Number (anime ke liye) ya Movie Name</label>
            <input type="text" id="epSeason" class="form-control" placeholder="e.g. 01  ya  Demon Slayer: Mugen Train">
          </div>
          <div class="form-group">
            <label>Episode Label</label>
            <input type="text" id="epNum" class="form-control" placeholder="e.g. 01, Full Pack">
          </div>
          <div class="form-group">
            <label>Quality Resolution</label>
            <select id="epQuality" class="form-control">
              <option value="SD">SD</option>
              <option value="HD" selected>HD</option>
              <option value="FHD">FHD</option>
            </select>
          </div>
          <div class="form-group">
            <label>Player Embed Link (Streamwish/Filemoon/MP4)</label>
            <input type="text" id="epPlayLink" class="form-control" placeholder="https://streamwish.to/e/...">
          </div>
          <div class="form-group">
            <label>Download Target Link</label>
            <input type="text" id="epDlLink" class="form-control" placeholder="https://drive.google.com/...">
          </div>
          <button class="btn-action" onclick="saveEpisode()">Save Episode</button>
          <div id="epAdminList" style="margin-top:12px; max-height:200px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; padding:5px;"></div>
        </div>

        <div id="tabAds" style="display:none;">
          <p style="font-size:11px; color:var(--text-muted); margin-bottom:10px;">Paste Ad codes here (Adsterra, Monetag, AdSense). Injected directly from Server to Bypass Ad-Blockers.</p>
          <div class="form-group"><label>Header Code (Head Scripts / Anti Adblock)</label><textarea id="cfgAdHead" class="form-control" style="height:60px;" placeholder="<script>...</script>"></textarea></div>
          <div class="form-group"><label>Body Code (Popunders / Direct Scripts)</label><textarea id="cfgAdBody" class="form-control" style="height:60px;" placeholder="<script>...</script>"></textarea></div>
          <div class="form-group"><label>Banner Ad Code (iframe/ins tags for Catalog/Player)</label><textarea id="cfgAdBanner" class="form-control" style="height:60px;" placeholder="<iframe>...</iframe>"></textarea></div>
          <div class="form-group"><label>App / APK Download Link (Mediafire/Drive)</label><input type="text" id="cfgApkLink" class="form-control" placeholder="Leave empty to hide APK button"></div>
          <button class="btn-action" onclick="saveAdsSettings()">Save Ads & App Links</button>
        </div>

        <div id="tabVip" style="display:none;">
          <div class="form-group">
            <label>Customer Gmail Address</label>
            <input type="email" id="vipEmail" class="form-control" placeholder="user@gmail.com">
          </div>
          <div class="form-group">
            <label>Set Access Key Passcode</label>
            <input type="text" id="vipKey" class="form-control" placeholder="PASS99">
          </div>
          <div class="form-group">
            <label>Select Duration</label>
            <select id="vipDays" class="form-control">
              <option value="1">1 Day Pass</option>
              <option value="7">7 Days Pass</option>
              <option value="30" selected>30 Days (1 Month)</option>
              <option value="365">1 Year VIP</option>
            </select>
          </div>
          <button class="btn-action" onclick="saveVipUser()">Activate VIP Pass</button>
          
          <h4 style="margin-top:15px; color:#ff4d4d;">Delete VIP Users</h4>
          <div id="vipList" style="max-height:200px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; padding:5px;"></div>
        </div>
        
        <div id="tabDel" style="display:none;">
          <h4 style="color:#ff4d4d; margin-bottom:10px;">Delete Anime Posts (Memory Clean Enabled)</h4>
          <div id="deleteList" style="max-height:300px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; padding:5px;"></div>
        </div>
        
        <div id="tabShort" style="display:none;">
          <p style="font-size:11px; color:var(--text-muted); margin-bottom:10px;">STRICT MODE: Users must solve shortener. Original link is hidden.</p>
          <div class="form-group"><label>Shortener Domain</label><input type="text" id="cfgShDom" class="form-control" placeholder="gplinks.com ya api.gplinks.com"></div>
          <div class="form-group"><label>API Key</label><input type="text" id="cfgShKey" class="form-control"></div>
          <button class="btn-action" onclick="addShortener()">Add Shortener</button>
          <div id="shortList" style="margin-top:12px; max-height:200px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; padding:5px;"></div>
        </div>
        
        <div id="tabPaid" style="display:none;">
          <div class="form-group"><label>Decrypt Password</label><input type="text" id="paidPass" class="form-control"></div>
          <div class="form-group"><label>Original Link</label><input type="text" id="paidUrl" class="form-control"></div>
          <button class="btn-action" onclick="addPaidRequest()">Add Decrypt Key</button>
          <div id="paidList" style="margin-top:12px; max-height:200px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; padding:5px;"></div>
        </div>

        <div id="tabCfg" style="display:none;">
          <p style="font-size:11px; color:var(--text-muted); margin-bottom:10px;">Security ke liye fields khali dikhti hain. Blank chhod kar save karoge to purana wala value SAFE rahega. Purana hatana ho to Clear dabao.</p>
          <div class="form-group">
            <label>Telegram Bot Token</label>
            <div style="display:flex; gap:6px;">
              <input type="text" id="cfgBotToken" class="form-control" placeholder="123456:ABC-DEF..." autocomplete="off">
              <button type="button" class="pctrl-btn" style="flex:0 0 auto;" onclick="clearSettingField('bot_token')">🗑 Clear</button>
            </div>
          </div>
          <div class="form-group">
            <label>Telegram Private Channel ID</label>
            <div style="display:flex; gap:6px;">
              <input type="text" id="cfgChatId" class="form-control" placeholder="-100xxxxxxxxxx" autocomplete="off">
              <button type="button" class="pctrl-btn" style="flex:0 0 auto;" onclick="clearSettingField('chat_id')">🗑 Clear</button>
            </div>
          </div>
          <div class="form-group">
            <label>Telegram Public Link</label>
            <div style="display:flex; gap:6px;">
              <input type="text" id="cfgTg" class="form-control" placeholder="https://t.me/yourchannel">
              <button type="button" class="pctrl-btn" style="flex:0 0 auto;" onclick="clearSettingField('channel_link')">🗑 Clear</button>
            </div>
          </div>
          <div class="form-group">
            <label>Admin Access PIN</label>
            <div style="display:flex; gap:6px;">
              <input type="text" id="cfgPin" class="form-control" placeholder="admin123" autocomplete="off">
              <button type="button" class="pctrl-btn" style="flex:0 0 auto;" onclick="clearSettingField('admin_pin')">🗑 Reset</button>
            </div>
          </div>
          <button class="btn-action" onclick="saveSettings()">Save Global Config</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let appData = { posts: [], settings: {}, shorteners: [], paid_requests: [] };
    let currentPost = null;
    let currentCategory = 'ALL';
    let currentGenre = 'ALL';
    let sessionPin = ""; 
    let currentEpisodeList = [];
    let currentEpIndex = -1;

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js');
      });
    }

    window.onload = async () => {
      await loadData();
    };

    async function loadData() {
      try {
        const res = await fetch('/api/data');
        appData = await res.json();
        renderSlider(appData.posts.slice(0, 5));
        renderCatFilters(appData.posts);
        applyFilters();
        document.getElementById('tgLink').href = appData.settings?.channel_link || '#';
      } catch (e) {
        showToast('Offline Mode / Network Error');
      }
    }

    async function adminFetch(url, options = {}) {
      options.headers = {
        'Content-Type': 'application/json',
        'X-Admin-Pin': sessionPin
      };
      return fetch(url, options);
    }

    function parseGenreList(genresStr) {
      if (!genresStr) return [];
      return genresStr.split(/[,.]+/).map(g => g.trim()).filter(Boolean);
    }

    function renderCatFilters(posts) {
      const cats = [...new Set(posts.map(p => p.category).filter(Boolean))];
      const bar = document.getElementById('catChips');
      bar.innerHTML = \`<div class="chip" style="background:var(--accent); color:#000; border-color:var(--accent);" onclick="openGenreModal()"><i class="fa-solid fa-masks-theater"></i> Genres</div>\` +
        \`<div class="chip active" onclick="filterByCat('ALL')">All Categories</div>\` + 
        cats.map(c => \`<div class="chip" onclick="filterByCat('\${c}')">\${c}</div>\`).join('');
      renderGenreFilters(posts);
    }

    function filterByCat(cat) {
      currentCategory = cat;
      currentGenre = 'ALL';
      
      const chips = document.getElementById('catChips').querySelectorAll('.chip');
      chips.forEach(c => c.classList.remove('active'));
      event.target.classList.add('active');
      
      renderGenreFilters(appData.posts);
      applyFilters();
    }

    function renderGenreFilters(posts) {
      const gBar = document.getElementById('genreChips');
      if (currentCategory === 'ALL') {
        gBar.style.display = 'none';
        return;
      }
      
      const catPosts = posts.filter(p => p.category === currentCategory);
      const gSet = new Set();
      catPosts.forEach(p => parseGenreList(p.genres).forEach(g => gSet.add(g)));
      
      const genres = Array.from(gSet);
      if (genres.length === 0) {
        gBar.style.display = 'none';
        return;
      }
      
      gBar.style.display = 'flex';
      gBar.innerHTML = \`<div class="chip active" onclick="filterByGenre('ALL')">All Genres</div>\` + 
        genres.map(g => \`<div class="chip" onclick="filterByGenre('\${g}')">\${g}</div>\`).join('');
    }

    function filterByGenre(gen) {
      currentGenre = gen;
      const chips = document.getElementById('genreChips').querySelectorAll('.chip');
      chips.forEach(c => c.classList.remove('active'));
      event.target.classList.add('active');
      applyFilters();
    }

    function openGenreModal() {
      const gSet = new Set();
      appData.posts.forEach(p => parseGenreList(p.genres).forEach(g => gSet.add(g)));
      const list = document.getElementById('genreModalList');
      const genres = Array.from(gSet).sort();
      if (genres.length === 0) {
        list.innerHTML = '<p style="color:var(--text-muted); font-size:12px;">No genres available yet.</p>';
      } else {
        list.innerHTML = genres.map(g => \`<div class="chip" onclick="selectGlobalGenre('\${g}')" style="margin:4px;">\${g}</div>\`).join('');
      }
      document.getElementById('genreModal').style.display = 'flex';
    }

    function selectGlobalGenre(g) {
      closeModal('genreModal');
      currentCategory = 'ALL';
      currentGenre = g;
      renderCatFilters(appData.posts); 
      document.getElementById('gridTitle').innerText = '🎭 Genre: ' + g;
      applyFilters();
    }

    function applyFilters() {
      let filtered = appData.posts;
      const q = document.getElementById('searchInp').value.toLowerCase().trim();
      
      if (currentCategory !== 'ALL') {
        filtered = filtered.filter(p => p.category === currentCategory);
      }
      if (currentGenre !== 'ALL') {
        filtered = filtered.filter(p => parseGenreList(p.genres).includes(currentGenre));
      }
      if (q) {
        filtered = filtered.filter(p => 
          (p.name && p.name.toLowerCase().includes(q)) || 
          (p.genres && p.genres.toLowerCase().includes(q)) || 
          (p.category && p.category.toLowerCase().includes(q))
        );
      }
      
      renderGrid(filtered);
    }

    function renderGrid(posts) {
      const grid = document.getElementById('mainGrid');
      if (!posts || posts.length === 0) {
        grid.innerHTML = '<p style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:30px;">No anime found.</p>';
        return;
      }
      grid.innerHTML = posts.map(p => \`
        <div class="card" onclick="openDetail('\${p.id}')">
          <div class="poster-wrap">
            \${p.image_url ? \`<img src="\${p.image_url}" loading="lazy" alt="\${p.name}">\` : \`<div class="no-img-text">\${p.name}</div>\`}
            <span class="category-badge">\${p.category || 'Anime'}</span>
          </div>
          <div class="card-meta">
            <div class="card-title">\${p.name}</div>
            <div class="card-sub">\${p.genres || p.season || ''}</div>
          </div>
        </div>
      \`).join('');
    }

    function renderSlider(posts) {
      const slider = document.getElementById('featuredSlider');
      if (posts.length === 0) { slider.style.display = 'none'; return; }
      slider.style.display = 'flex';
      slider.innerHTML = posts.map(p => \`
        <div class="slide-card" onclick="openDetail('\${p.id}')">
          \${p.image_url ? \`<img src="\${p.image_url}">\` : ''}
          <div class="slide-overlay">
            <div class="slide-tag">\${p.category || 'Featured'}</div>
            <div class="slide-title">\${p.name}</div>
          </div>
        </div>
      \`).join('');
    }

    async function openDetail(postId) {
      currentPost = appData.posts.find(p => p.id === postId);
      if (!currentPost) return;

      document.getElementById('catalogView').style.display = 'none';
      document.getElementById('catChips').style.display = 'none';
      document.getElementById('genreChips').style.display = 'none';
      document.getElementById('detailView').classList.add('active');

      document.getElementById('detailMeta').innerHTML = \`
        \${currentPost.image_url ? \`<img src="\${currentPost.image_url}">\` : ''}
        <div class="detail-info">
          <h2>\${currentPost.name}</h2>
          <p><strong>Category:</strong> \${currentPost.category}</p>
          <p><strong>Genre:</strong> \${currentPost.genres || 'N/A'}</p>
          <p><strong>Release:</strong> \${currentPost.release || 'N/A'}</p>
          <p><strong>Story:</strong> \${currentPost.story || 'N/A'}</p>
        </div>
      \`;

      const epRes = await fetch(\`/api/episodes?post_id=\${postId}\`);
      const epData = await epRes.json();
      const list = document.getElementById('epListContainer');

      if (!epData.episodes || epData.episodes.length === 0) {
        list.innerHTML = '<h4>Episodes</h4><p style="color:var(--text-muted); font-size:12px;">No episodes uploaded yet.</p>';
        currentEpisodeList = [];
        return;
      }

      currentEpisodeList = epData.episodes;
      const QUALITY_ORDER = ["FHD", "HD", "SD"];
      const seasonGroups = {};
      const seasonOrder = [];
      epData.episodes.forEach(e => {
        const key = e.season && e.season.trim() ? e.season.trim() : '__none__';
        if (!seasonGroups[key]) { seasonGroups[key] = {}; seasonOrder.push(key); }
        const q = e.quality || 'HD';
        if (!seasonGroups[key][q]) seasonGroups[key][q] = [];
        seasonGroups[key][q].push(e);
      });

      let html = '<h4>Episodes List</h4>';
      seasonOrder.forEach(seasonKey => {
        if (seasonKey !== '__none__') {
          html += \`<div style="margin:14px 0 6px; font-weight:800; color:var(--primary); font-size:13px;"><i class="fa-solid fa-layer-group"></i> Season \${seasonKey}</div>\`;
        }
        const qualsPresent = Object.keys(seasonGroups[seasonKey]);
        const orderedQuals = QUALITY_ORDER.filter(q => qualsPresent.includes(q))
          .concat(qualsPresent.filter(q => !QUALITY_ORDER.includes(q)));

        orderedQuals.forEach(q => {
          html += \`<div style="margin:8px 0 4px; font-weight:700; color:var(--accent); font-size:11px; letter-spacing:1px;">\${q}</div>\`;
          html += '<div style="margin-bottom:4px;">' + seasonGroups[seasonKey][q].map(e => \`
            <button class="ep-btn" data-epid="\${e.id}" onclick="playStream('\${e.play_link}', '\${e.id}')">
              EP\${e.label}
            </button>
            <button class="ep-btn" style="background:#00b359;" onclick="downloadEp('\${e.id}')">
              <i class="fa-solid fa-download"></i>
            </button>
          \`).join('') + '</div>';
        });
      });
      list.innerHTML = html;

      if (epData.episodes[0].play_link) {
        playStream(epData.episodes[0].play_link, epData.episodes[0].id);
      }
    }

    function highlightActiveEpisode(epId) {
      document.querySelectorAll('#epListContainer .ep-btn').forEach(b => b.classList.remove('active'));
      const btn = document.querySelector(\`#epListContainer .ep-btn[data-epid="\${epId}"]\`);
      if (btn) btn.classList.add('active');
    }

    function playStream(url, epId) {
      const box = document.getElementById('playerBox');
      if (url) {
        box.style.display = 'block';
        const oldFrame = box.querySelector('iframe');
        if (oldFrame) oldFrame.remove();
        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.setAttribute('allowfullscreen', '');
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation');
        box.appendChild(iframe);
        document.getElementById('playerMenuBtn').style.display = 'flex';
        document.getElementById('playerControls').style.display = 'flex';
        box.scrollIntoView({ behavior: 'smooth' });
      }
      currentEpIndex = currentEpisodeList.findIndex(e => e.id === epId);
      highlightActiveEpisode(epId);
    }

    function togglePlayerMenu() {
      document.getElementById('playerMenu').classList.toggle('open');
    }

    function prevEp() {
      if (currentEpIndex > 0) {
        const e = currentEpisodeList[currentEpIndex - 1];
        playStream(e.play_link, e.id);
      } else {
        showToast('Ye pehla episode hai');
      }
    }

    function nextEp() {
      if (currentEpIndex !== -1 && currentEpIndex < currentEpisodeList.length - 1) {
        const e = currentEpisodeList[currentEpIndex + 1];
        playStream(e.play_link, e.id);
      } else {
        showToast('Ye last episode hai');
      }
    }

    function toggleTheater() {
      document.getElementById('playerBox').classList.toggle('theater');
    }

    function togglePiP() {
      const box = document.getElementById('playerBox');
      box.classList.toggle('floating-pip');
    }

    function toggleFullscreen() {
      const box = document.getElementById('playerBox');
      if (!document.fullscreenElement) {
        (box.requestFullscreen || box.webkitRequestFullscreen || box.msRequestFullscreen || function(){}).call(box);
      } else {
        (document.exitFullscreen || function(){}).call(document);
      }
    }

    async function downloadEp(epId) {
      showToast('Generating Secure Link...');
      const key = localStorage.getItem('vip_key') || '';
      const res = await fetch(\`/api/get-link?post_id=\${currentPost.id}&ep_id=\${epId}&key=\${encodeURIComponent(key)}\`);
      const data = await res.json();
      if (data.url) {
        window.open(data.url, '_blank');
      } else {
        showToast(data.error || 'Server is busy, try again');
      }
    }

    function goHome() {
      document.getElementById('catalogView').style.display = 'block';
      document.getElementById('detailView').classList.remove('active');
      const box = document.getElementById('playerBox');
      const oldFrame = box.querySelector('iframe');
      if (oldFrame) oldFrame.remove();
      box.classList.remove('theater', 'floating-pip');
      box.style.display = 'none';
      document.getElementById('playerMenuBtn').style.display = 'none';
      document.getElementById('playerMenu').classList.remove('open');

      document.getElementById('catChips').style.display = 'flex';
      if(currentCategory !== 'ALL') {
          document.getElementById('genreChips').style.display = 'flex';
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    const AUTODETECT_ALIASES = [
      ["short story", "story"], ["synopsis", "story"], ["description", "story"], ["desc", "story"], ["story", "story"],
      ["name", "name"], ["title", "name"], ["naam", "name"],
      ["category", "category"], ["cat", "category"],
      ["release date", "release"], ["release", "release"], ["date", "release"], ["year", "release"],
      ["genres", "genres"], ["genre", "genres"],
    ];

    function handleAutoDetect() {
      const text = document.getElementById("autoDetectInp").value.trim();
      if (!text) return;

      const lines = text.split('\\n');
      let currentField = null;
      let parsed = { name: "", category: "", release: "", genres: "", story: "" };
      const SEP = "\\\\s*[-:=_,.]+\\\\s*";

      lines.forEach(line => {
        let matched = false;
        for (const [alias, field] of AUTODETECT_ALIASES) {
          const aliasPattern = alias.replace(/ /g, "\\\\s+");
          const re = new RegExp("^\\\\s*" + aliasPattern + SEP + "(.*)", "i");
          const m = line.match(re);
          if (m) {
            currentField = field;
            parsed[field] = (parsed[field] ? parsed[field] + "\\n" : "") + m[1].trim();
            matched = true;
            break;
          }
        }
        if (!matched && currentField && line.trim()) {
          parsed[currentField] += "\\n" + line.trim();
        }
      });

      if (parsed.name) document.getElementById("pName").value = parsed.name.trim();
      if (parsed.category) document.getElementById("pCategory").value = parsed.category.trim();
      if (parsed.genres) document.getElementById("pGenre").value = parsed.genres.trim();
      if (parsed.release) document.getElementById("pRelease").value = parsed.release.trim();
      if (parsed.story) document.getElementById("pStory").value = parsed.story.trim();
    }

    function openAdmin() { document.getElementById('adminModal').style.display = 'flex'; }
    function closeModal(id) { document.getElementById(id).style.display = 'none'; }

    async function verifyAdmin() {
      const pin = document.getElementById('adminPinInp').value;
      if(!pin) return alert('Enter PIN!');

      sessionPin = pin;
      
      // Request Data again with PIN to unlock Admin Secrets
      const checkRes = await fetch('/api/data', { headers: { 'X-Admin-Pin': sessionPin } });
      const data = await checkRes.json();
      
      if (!data.admin) {
        sessionPin = "";
        return alert('❌ Galat PIN! Dobara try karo.');
      }
      
      // Update appData with unlocked admin data
      appData = data;

      document.getElementById('adminLock').style.display = 'none';
      document.getElementById('adminBody').style.display = 'block';
      loadAdminDataUI();
    }

    function setAdminTab(tab) {
      ['Post', 'Ep', 'Del', 'Short', 'Vip', 'Paid', 'Cfg', 'Ads'].forEach(t => {
        const el = document.getElementById('tab' + t);
        if (el) el.style.display = 'none';
      });
      const activeEl = document.getElementById('tab' + tab.charAt(0).toUpperCase() + tab.slice(1));
      if (activeEl) activeEl.style.display = 'block';
    }
    
    async function loadAdminDataUI() {
      const sel = document.getElementById('epPostSelect');
      sel.innerHTML = '<option value="">-- Select Anime --</option>' + appData.posts.map(p => \`<option value="\${p.id}">\${p.name}</option>\`).join('');
      
      const delList = document.getElementById('deleteList');
      delList.innerHTML = appData.posts.map(p => \`
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px; border-bottom:1px solid var(--border); background:rgba(0,0,0,0.2); margin-bottom:4px; border-radius:6px;">
          <span style="font-size:12px; color:#fff; word-break:break-all;">\${p.name}</span>
          <button style="background:#ff4d4d; color:#fff; border:none; padding:5px 10px; border-radius:4px; font-size:11px; font-weight:bold; cursor:pointer;" onclick="deletePost('\${p.id}')">Delete Post Data</button>
        </div>
      \`).join('');

      document.getElementById('cfgBotToken').value = ""; 
      document.getElementById('cfgChatId').value = "";
      document.getElementById('cfgTg').value = appData.settings?.channel_link || '';
      document.getElementById('cfgPin').value = ""; 
      
      document.getElementById('cfgAdHead').value = appData.settings?.ad_head || '';
      document.getElementById('cfgAdBody').value = appData.settings?.ad_body || '';
      document.getElementById('cfgAdBanner').value = appData.settings?.ad_banner || '';
      document.getElementById('cfgApkLink').value = appData.settings?.apk_link || '';

      try {
        const vipRes = await adminFetch('/api/admin/vip');
        const vipData = await vipRes.json();
        const vipList = document.getElementById('vipList');
        vipList.innerHTML = (vipData.users || []).map(u => \`
          <div style="display:flex; justify-content:space-between; align-items:center; padding:8px; border-bottom:1px solid var(--border); background:rgba(0,0,0,0.2); margin-bottom:4px; border-radius:6px;">
            <span style="font-size:12px; color:#fff; word-break:break-all;">\${u.email}</span>
            <button style="background:#ff4d4d; color:#fff; border:none; padding:5px 10px; border-radius:4px; font-size:11px; font-weight:bold; cursor:pointer;" onclick="deleteVipUser('\${encodeURIComponent(u.email)}')">Delete</button>
          </div>
        \`).join('');
      } catch(err) { console.error("VIP fetch failed"); }

      const shortList = document.getElementById('shortList');
      shortList.innerHTML = (appData.shorteners || []).map((s, i) => \`
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px; border-bottom:1px solid var(--border); background:rgba(0,0,0,0.2); margin-bottom:4px; border-radius:6px;">
          <span style="font-size:12px; color:#fff; word-break:break-all;">\${s.domain}</span>
          <button style="background:#ff4d4d; color:#fff; border:none; padding:5px 10px; border-radius:4px; font-size:11px; font-weight:bold; cursor:pointer;" onclick="deleteShortener(\${i})">Delete</button>
        </div>
      \`).join('');

      const paidList = document.getElementById('paidList');
      paidList.innerHTML = (appData.paid_requests || []).map((k, i) => \`
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px; border-bottom:1px solid var(--border); background:rgba(0,0,0,0.2); margin-bottom:4px; border-radius:6px;">
          <span style="font-size:12px; color:#fff; word-break:break-all;">\${k.password}</span>
          <button style="background:#ff4d4d; color:#fff; border:none; padding:5px 10px; border-radius:4px; font-size:11px; font-weight:bold; cursor:pointer;" onclick="deletePaidKey(\${i})">Delete</button>
        </div>
      \`).join('');
    }

    async function loadAdminEpisodes() {
      const postId = document.getElementById('epPostSelect').value;
      const epList = document.getElementById('epAdminList');
      if(!postId) { epList.innerHTML = ''; return; }
      const res = await fetch(\`/api/episodes?post_id=\${postId}\`);
      const data = await res.json();
      
      epList.innerHTML = data.episodes.map(e => \`
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px; border-bottom:1px solid var(--border); background:rgba(0,0,0,0.2); margin-bottom:4px; border-radius:6px;">
          <span style="font-size:12px; color:#fff; word-break:break-all;">\${e.season ? '[' + e.season + '] ' : ''}Ep \${e.label} - \${e.quality}</span>
          <button style="background:#ff4d4d; color:#fff; border:none; padding:5px 10px; border-radius:4px; font-size:11px; font-weight:bold; cursor:pointer;" onclick="deleteEpisode('\${e.id}', '\${postId}')">Delete</button>
        </div>
      \`).join('');
    }

    async function deletePost(id) {
      if(!confirm("Delete this post and episodes permanently? Memory will be cleaned.")) return;
      const res = await adminFetch(\`/api/posts/\${id}\`, { method: 'DELETE' });
      if(res.ok) { showToast('Post Deleted!'); await loadData(); loadAdminDataUI(); }
      else alert("Auth failed");
    }

    async function deleteEpisode(epId, postId) {
      if(!confirm("Delete this episode?")) return;
      const res = await adminFetch(\`/api/episodes/\${epId}?post_id=\${postId}\`, { method: 'DELETE' });
      if(res.ok) { showToast('Episode Deleted!'); loadAdminEpisodes(); }
      else alert("Auth failed");
    }

    async function deleteVipUser(emailParam) {
      if(!confirm("Delete this VIP User?")) return;
      const res = await adminFetch(\`/api/admin/vip/\${emailParam}\`, { method: 'DELETE' });
      if(res.ok) { showToast('VIP User Deleted!'); loadAdminDataUI(); }
      else alert("Auth failed");
    }

    async function addShortener() {
      const domain = document.getElementById('cfgShDom').value.trim();
      const api_key = document.getElementById('cfgShKey').value.trim();
      if(!domain || !api_key) return alert("Fill both fields");
      let shorteners = appData.shorteners || [];
      shorteners.push({domain, api_key});
      const res = await adminFetch('/api/settings', { method: 'POST', body: JSON.stringify({ shorteners }) });
      if(res.ok) { document.getElementById('cfgShDom').value = ''; document.getElementById('cfgShKey').value = ''; showToast('Shortener Added!'); verifyAdmin(); }
      else alert("Save failed");
    }

    async function deleteShortener(index) {
      if(!confirm("Delete this shortener?")) return;
      let shorteners = appData.shorteners || [];
      shorteners.splice(index, 1);
      const res = await adminFetch('/api/settings', { method: 'POST', body: JSON.stringify({ shorteners }) });
      if(res.ok) { showToast('Shortener Deleted!'); verifyAdmin(); }
      else alert("Auth failed");
    }

    async function addPaidRequest() {
      const password = document.getElementById('paidPass').value.trim();
      const original_link = document.getElementById('paidUrl').value.trim();
      if(!password || !original_link) return alert("Fill both fields");
      let paid_requests = appData.paid_requests || [];
      paid_requests.push({password, original_link});
      const res = await adminFetch('/api/settings', { method: 'POST', body: JSON.stringify({ paid_requests }) });
      if(res.ok) { document.getElementById('paidPass').value = ''; document.getElementById('paidUrl').value = ''; showToast('Key Added!'); verifyAdmin(); }
      else alert("Save failed");
    }

    async function deletePaidKey(index) {
      if(!confirm("Delete this key?")) return;
      let paid_requests = appData.paid_requests || [];
      paid_requests.splice(index, 1);
      const res = await adminFetch('/api/settings', { method: 'POST', body: JSON.stringify({ paid_requests }) });
      if(res.ok) { showToast('Key Deleted!'); verifyAdmin(); }
      else alert("Auth failed");
    }

    async function clearSettingField(key) {
      if (!confirm('Ye saved value delete kar do?')) return;
      const res = await adminFetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ settings: { [key]: "" } })
      });
      if (res.ok) {
        showToast('Cleared!');
        const fieldMap = { bot_token: 'cfgBotToken', chat_id: 'cfgChatId', channel_link: 'cfgTg', admin_pin: 'cfgPin' };
        if (fieldMap[key]) document.getElementById(fieldMap[key]).value = '';
        if (key === 'admin_pin') sessionPin = 'admin123';
        verifyAdmin();
      } else {
        alert('Clear failed');
      }
    }

    async function saveSettings() {
      const channel_link = document.getElementById('cfgTg').value.trim();
      const admin_pin = document.getElementById('cfgPin').value.trim();
      const bot_token = document.getElementById('cfgBotToken').value.trim();
      const chat_id = document.getElementById('cfgChatId').value.trim();

      const settings = { channel_link };
      if (admin_pin) settings.admin_pin = admin_pin;
      if (bot_token) settings.bot_token = bot_token;
      if (chat_id) settings.chat_id = chat_id;

      const res = await adminFetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ settings })
      });
      if(res.ok) {
        showToast('Settings Saved!');
        if (admin_pin) sessionPin = admin_pin;
        verifyAdmin();
      }
      else { alert('Save fail ho gaya - PIN check karo'); }
    }
    
    async function saveAdsSettings() {
      const settings = {
        ad_head: document.getElementById('cfgAdHead').value,
        ad_body: document.getElementById('cfgAdBody').value,
        ad_banner: document.getElementById('cfgAdBanner').value,
        apk_link: document.getElementById('cfgApkLink').value,
      };
      const res = await adminFetch('/api/settings', { method: 'POST', body: JSON.stringify({ settings }) });
      if (res.ok) { showToast('Ads & APK Settings Saved! Page reloading...'); setTimeout(()=> location.reload(), 1500); }
    }

    async function uploadImgBB() {
      const file = document.getElementById('pImgFile').files[0];
      if (!file) return alert("Pehle File select karo Upload karne ke liye!");
      showToast("Uploading Image to Permanent Server...");
      const fd = new FormData();
      fd.append('image', file);
      try {
        const res = await fetch("https://api.imgbb.com/1/upload?key=302521c3fa19b023e3c60523098f98d0", { method: "POST", body: fd });
        const data = await res.json();
        if(data.success) {
           document.getElementById('pImgUrl').value = data.data.url;
           showToast("Image Uploaded and Secured!");
        } else { alert("Upload failed: Check network"); }
      } catch(e) { alert("Upload error"); }
    }

    async function savePost() {
      const name = document.getElementById('pName').value.trim();
      const image_url = document.getElementById('pImgUrl').value.trim();
      const category = document.getElementById('pCategory').value.trim();
      const genres = document.getElementById('pGenre').value.trim();
      const release = document.getElementById('pRelease').value.trim();
      const story = document.getElementById('pStory').value.trim();
      
      if (!name) return alert('Anime name required!');
      
      const res = await adminFetch('/api/posts', {
        method: 'POST',
        body: JSON.stringify({ name, image_url, category, genres, release, story })
      });
      
      if(res.ok) {
          const data = await res.json();
          if (data.telegram && data.telegram.ok === false) {
            alert('⚠️ Post saved, but failed to send to Telegram.\\nReason: ' + data.telegram.reason);
          } else {
            showToast('Post Published & Sent to Telegram!');
          }
          document.getElementById('pName').value = '';
          document.getElementById('pImgUrl').value = '';
          await loadData(); loadAdminDataUI();
      } else { alert("Auth failed"); }
    }

    async function saveEpisode() {
      const post_id = document.getElementById('epPostSelect').value;
      const season = document.getElementById('epSeason').value.trim();
      const label = document.getElementById('epNum').value.trim();
      const quality = document.getElementById('epQuality').value;
      const play_link = document.getElementById('epPlayLink').value.trim();
      const download_link = document.getElementById('epDlLink').value.trim();

      if(!post_id || !label) return alert('Select Post and enter Episode Label');

      const res = await adminFetch('/api/episodes', {
        method: 'POST',
        body: JSON.stringify({ post_id, season, label, quality, play_link, download_link })
      });
      if(res.ok) {
          showToast('Episode Attached!');
          document.getElementById('epNum').value = '';
          document.getElementById('epPlayLink').value = '';
          document.getElementById('epDlLink').value = '';
          loadAdminEpisodes();
      } else alert("Auth failed");
    }

    async function saveVipUser() {
      const email = document.getElementById('vipEmail').value.trim();
      const key = document.getElementById('vipKey').value.trim();
      const days = document.getElementById('vipDays').value;

      if(!email || !key) return alert("Fill all fields");

      const res = await adminFetch('/api/premium', {
        method: 'POST',
        body: JSON.stringify({ email, key, days })
      });
      if(res.ok) {
          showToast('VIP Pass Created & TG Alert Sent!');
          document.getElementById('vipEmail').value = '';
          document.getElementById('vipKey').value = '';
          loadAdminDataUI();
      } else alert("Auth failed");
    }

    function openVIPModal() {
      const key = prompt('Enter your VIP Passcode Key:');
      if (key) {
        localStorage.setItem('vip_key', key);
        showToast('VIP Mode Active!');
      }
    }

    async function openDecryptModal() {
      const code = prompt('Enter Secret Decrypt Key:');
      if (code) {
        const res = await fetch(\`/api/decrypt-link?code=\${encodeURIComponent(code)}\`);
        const data = await res.json();
        if (data.url) window.open(data.url, '_blank');
        else alert('Invalid key or expired');
      }
    }

    function openAZModal() {
      const letter = prompt('Enter A-Z letter to filter (e.g. N, D, S):');
      if (letter) {
        const l = letter.toUpperCase();
        document.getElementById('searchInp').value = '';
        renderGrid(appData.posts.filter(p => p.name.toUpperCase().startsWith(l)));
      }
    }

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.innerText = msg;
      t.style.display = 'block';
      setTimeout(() => t.style.display = 'none', 3000);
    }
  </script>
</body>
</html>`;
}
