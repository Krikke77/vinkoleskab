const WineLookup = (() => {
  const API = "https://api.wineapi.io";
  const KEY = "vinkoleskab.wineapi-key";
  const DEFAULT_KEY = typeof WINE_API_KEY === "string" ? WINE_API_KEY : "";
  const COUNTRY_DA = {
    Italy: "Italien",
    France: "Frankrig",
    Spain: "Spanien",
    Germany: "Tyskland",
    Portugal: "Portugal",
    Austria: "Østrig",
    Australia: "Australien",
    "South Africa": "Sydafrika",
    Denmark: "Danmark",
    Greece: "Grækenland",
    Hungary: "Ungarn",
    Israel: "Israel",
    Chile: "Chile",
    Argentina: "Argentina",
    USA: "USA",
    "United States": "USA",
    "United States of America": "USA",
  };

  function apiKey() {
    try {
      return localStorage.getItem(KEY) || DEFAULT_KEY;
    } catch {
      return DEFAULT_KEY;
    }
  }

  function setApiKey(value) {
    const next = String(value || "").trim();
    if (!next) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  }

  function danishCountry(name) {
    const text = String(name || "").trim();
    return COUNTRY_DA[text] || text;
  }

  function mapType(wine) {
    const grapes = (wine.grapes || []).map((grape) => `${grape.color || ""} ${grape.name || grape}`).join(" ");
    const text = `${wine.type || ""} ${wine.classification || ""} ${grapes}`.toLowerCase();
    if (/spark|champag|bubbl|prosecco|cava|sekt|brut/.test(text)) return "mousserende";
    if (/ros[eé]|rosato/.test(text)) return "rosé";
    if (/white|blanc|bianco|weiss|branco/.test(text)) return "hvid";
    if (/red|rouge|rosso|tinto|negro/.test(text)) return "rød";
    return "";
  }

  function regionLine(wine) {
    const country = danishCountry(wine.country || wine.region?.country || "");
    const region = typeof wine.region === "string" ? wine.region : wine.region?.name || "";
    const appellation = typeof wine.appellation === "string" ? wine.appellation : wine.appellation?.name || "";
    const parts = [country, region, appellation].map((part) => String(part || "").trim()).filter(Boolean);
    return parts.filter((part, index) => parts.findIndex((item) => item.toLowerCase() === part.toLowerCase()) === index).join(", ");
  }

  function producerName(wine) {
    if (!wine.winery) return wine.producer || "";
    return typeof wine.winery === "string" ? wine.winery : wine.winery.name || "";
  }

  function safeUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
    } catch {
      return "";
    }
    return "";
  }

  function imageOf(wine) {
    if (!wine || typeof wine !== "object") return "";
    const options = [wine.imageUrl, wine.image_url, wine.labelImageUrl, wine.labelUrl, wine.image, wine.labelImage, wine.thumbnail, wine.photoUrl];
    for (const option of options) {
      const url = safeUrl(typeof option === "string" ? option : option?.url || "");
      if (url) return url;
    }
    return "";
  }

  function plain(value) {
    return String(value ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  }

  function compactProfile(wine) {
    const prices = (Array.isArray(wine.prices) ? wine.prices : []).slice(0, 8).map((price) => ({
      merchant: String(price.merchantName || price.merchant || ""),
      price: price.price,
      currency: String(price.currency || ""),
      url: safeUrl(price.url || ""),
    })).filter((price) => price.price != null && price.price !== "");
    const grapes = (wine.grapes || []).map((grape) => String(grape.name || grape || "").trim()).filter(Boolean).slice(0, 8);
    const profile = {
      sourceId: String(wine.id || ""),
      grapes,
      rating: typeof wine.averageRating === "number" ? wine.averageRating : null,
      ratingsCount: Number.isFinite(wine.ratingsCount) ? wine.ratingsCount : null,
      description: String(wine.description || "").slice(0, 500),
      alcohol: wine.alcoholContent || wine.alcohol || "",
      imageUrl: imageOf(wine),
      prices,
      fetchedAt: new Date().toISOString(),
    };
    const empty = !profile.sourceId && !grapes.length && profile.rating == null && !profile.description && !prices.length && !profile.imageUrl;
    return empty ? null : profile;
  }

  function sanitizeProfile(profile) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
    const cleaned = compactProfile({
      id: profile.sourceId,
      grapes: (profile.grapes || []).map((name) => ({ name })),
      averageRating: profile.rating,
      ratingsCount: profile.ratingsCount,
      description: profile.description,
      alcoholContent: profile.alcohol,
      imageUrl: profile.imageUrl,
      prices: (profile.prices || []).map((price) => ({
        merchantName: price.merchant,
        price: price.price,
        currency: price.currency,
        url: price.url,
      })),
    });
    if (cleaned && profile.fetchedAt) cleaned.fetchedAt = String(profile.fetchedAt);
    return cleaned;
  }

  async function api(path, options = {}) {
    const key = apiKey();
    if (!key) {
      const error = new Error("Mangler nøgle");
      error.code = "no-key";
      throw error;
    }
    let response;
    try {
      response = await fetch(`${API}${path}`, {
        ...options,
        headers: {
          Accept: "application/json",
          "X-API-Key": key,
          ...(options.headers || {}),
        },
      });
    } catch {
      const error = new Error("Netværk");
      error.code = "network";
      throw error;
    }
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { error: text };
    }
    if (!response.ok) {
      const error = new Error(body?.error || "Opslaget fejlede");
      error.code = response.status === 401 ? "unauthorized" : response.status === 429 ? "limit" : "http";
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function explain(error) {
    if (error?.code === "no-key") return "Indsæt en WineAPI-nøgle under Data → Vinkilde. Den er gratis til privat brug.";
    if (error?.code === "unauthorized") return "Nøglen blev afvist. Tjek den under Vinkilde.";
    if (error?.code === "limit") return "Dagens grænse på 100 opslag er brugt. Prøv igen i morgen.";
    if (error?.code === "network") return "Kunne ikke nå vinkilden. Tjek internetforbindelsen.";
    return "Opslaget lykkedes ikke. Prøv igen om et øjeblik.";
  }

  async function blobToBase64(blob) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return String(dataUrl).split(",")[1] || "";
  }

  async function identifyImage(blob) {
    const image = await blobToBase64(blob);
    try {
      return await api("/identify/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
      });
    } catch (error) {
      if (error.status !== 400) throw error;
      const form = new FormData();
      form.append("image", blob, "label.jpg");
      return api("/identify/image", { method: "POST", body: form });
    }
  }

  function identifyText(query) {
    return api("/identify/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
  }

  function searchWines(query) {
    return api(`/wines/search?q=${encodeURIComponent(query)}&limit=5`);
  }

  function wineDetail(id) {
    return api(`/wines/${encodeURIComponent(id)}`);
  }

  function winePrices(id) {
    return api(`/wines/${encodeURIComponent(id)}/prices`);
  }

  function collectCandidates(payload) {
    const found = [];
    const push = (item) => {
      if (!item) return;
      const wine = item.wine && typeof item.wine === "object" ? { ...item.wine, confidence: item.confidence } : item;
      if (!wine || typeof wine !== "object") return;
      if (!wine.name && !wine.id && !producerName(wine)) return;
      const id = wine.id || `${wine.name || ""}|${producerName(wine)}|${wine.vintage || ""}`;
      if (found.some((entry) => (entry.id || `${entry.name}|${producerName(entry)}|${entry.vintage || ""}`) === id)) return;
      found.push(wine);
    };
    push(payload?.wine);
    for (const suggestion of payload?.suggestions || []) push(suggestion);
    for (const result of payload?.results || []) push(result);
    return found;
  }

  async function enrich(wine) {
    if (!wine?.id) return wine;
    const thin = !wine.grapes && !wine.description && !Array.isArray(wine.prices);
    if (!thin && Array.isArray(wine.prices)) return wine;
    try {
      const detail = await wineDetail(wine.id);
      const merged = { ...wine, ...detail, id: wine.id };
      if (!Array.isArray(merged.prices) || !merged.prices.length) {
        try {
          const prices = await winePrices(wine.id);
          merged.prices = prices?.prices || [];
        } catch {
          merged.prices = merged.prices || [];
        }
      }
      return merged;
    } catch {
      return wine;
    }
  }

  async function lookup({ image, query }) {
    const payload = image ? await identifyImage(image) : await identifyText(query);
    let candidates = collectCandidates(payload);
    if (!candidates.length && query) {
      const searched = await searchWines(query);
      candidates = collectCandidates(searched);
    }
    if (candidates[0]) candidates[0] = await enrich(candidates[0]);
    return candidates;
  }

  async function labelImageFor({ name, producer, vintage }) {
    const query = [name, producer, vintage].map((part) => String(part || "").trim()).filter(Boolean).join(" ");
    if (query.length < 2) return "";
    const wines = collectCandidates(await identifyText(query));
    const tokens = [...new Set(plain(producer).split(/[^a-z0-9]+/).filter((token) => token.length >= 4))];
    const need = Math.max(1, Math.ceil(tokens.length / 2));
    const wine = wines.find((candidate) => {
      const hay = plain(`${candidate.name || ""} ${producerName(candidate)}`);
      if (!tokens.length) return plain(name).split(/[^a-z0-9]+/).some((token) => token.length >= 4 && hay.includes(token));
      return tokens.filter((token) => hay.includes(token)).length >= need;
    });
    if (!wine) return "";
    let url = imageOf(wine);
    if (!url && wine.id) {
      try {
        url = imageOf(await wineDetail(wine.id));
      } catch (error) {
        if (error.code === "limit" || error.code === "unauthorized") throw error;
      }
    }
    return url;
  }

  async function allPhotos() {
    const database = await db();
    return new Promise((resolve, reject) => {
      const found = new Map();
      const request = database.transaction("photos", "readonly").objectStore("photos").openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          found.set(String(cursor.key), cursor.value);
          cursor.continue();
        } else resolve(found);
      };
      request.onerror = () => reject(request.error);
    });
  }

  function compress(file, maxEdge, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (blob) resolve(blob);
          else reject(new Error("Billedet kunne ikke behandles"));
        }, "image/jpeg", quality);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Billedet kunne ikke læses"));
      };
      image.src = url;
    });
  }

  function db() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("vinkoleskab-photos", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("photos");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function withStore(mode, fn) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("photos", mode);
      const store = tx.objectStore("photos");
      const request = fn(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function savePhoto(id, blob) {
    return withStore("readwrite", (store) => store.put(blob, id));
  }

  function loadPhoto(id) {
    return withStore("readonly", (store) => store.get(id));
  }

  function deletePhoto(id) {
    return withStore("readwrite", (store) => store.delete(id));
  }

  function clearPhotos() {
    return withStore("readwrite", (store) => store.clear());
  }

  return {
    apiKey,
    setApiKey,
    mapType,
    regionLine,
    producerName,
    compactProfile,
    sanitizeProfile,
    explain,
    lookup,
    enrich,
    labelImageFor,
    allPhotos,
    compress,
    savePhoto,
    loadPhoto,
    deletePhoto,
    clearPhotos,
  };
})();
