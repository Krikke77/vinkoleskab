const STORAGE_KEY = "vinkoleskab.v1";

const TYPES = [
  ["rød", "Rød"],
  ["hvid", "Hvid"],
  ["mousserende", "Mousserende"],
  ["rosé", "Rosé"],
  ["andet", "Andet"],
];

const TYPE_LABEL = Object.fromEntries(TYPES);
const TYPE_CLASS = {
  rød: "rod",
  hvid: "hvid",
  mousserende: "mousserende",
  rosé: "rose",
  andet: "andet",
};
const TYPE_SET = new Set(TYPES.map(([id]) => id));

const ui = {
  tab: "oversigt",
  query: "",
  type: "alle",
  country: "alle",
  sort: "placering",
  panel: null,
};

let state = { bottles: [], history: [] };
let cameFromStorage = false;
let drawerKey = "";
let snapshot = "";
let pendingConfirm = null;
let toastTimer = 0;
let pendingPhoto = null;
let pendingUpload = null;
let photoRemoved = false;
let lookupCandidates = [];
let lookupPreviewUrl = "";
let photoUrls = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function fold(value) {
  return String(value ?? "")
    .toLocaleLowerCase("da")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function flasker(count) {
  return count === 1 ? "1 flaske" : `${count} flasker`;
}

function countryOf(region) {
  const country = String(region || "").split(",")[0].trim();
  return country || "Ukendt";
}

function regionDetail(region) {
  return String(region || "")
    .split(",")
    .slice(1)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

function parseLocation(value) {
  const match = /^([A-Za-zÆØÅæøå]+)(\d+)$/.exec(String(value || "").trim());
  if (!match) return null;
  const n = Number(match[2]);
  if (!Number.isInteger(n) || n < 1 || n > 99) return null;
  return { letter: match[1].toLocaleUpperCase("da"), n };
}

function normalizeLocation(value) {
  const parsed = parseLocation(value);
  return parsed ? parsed.letter + parsed.n : null;
}

function compareLocation(a, b) {
  const left = parseLocation(a);
  const right = parseLocation(b);
  if (!left && !right) return String(a).localeCompare(String(b), "da");
  if (!left) return 1;
  if (!right) return -1;
  const byLetter = left.letter.localeCompare(right.letter, "da");
  return byLetter || left.n - right.n;
}

function bottleKey(bottle) {
  return [bottle.name, bottle.producer, bottle.vintage, bottle.region].join("\u0001");
}

function tone(bottle) {
  return TYPE_CLASS[bottle.hue || bottle.type] || "andet";
}

function vintageNumber(vintage) {
  const n = Number(vintage);
  return Number.isInteger(n) && n > 1800 ? n : null;
}

function parsePrice(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let text = raw.replace(/\s/g, "").replace(/kr\.?$/i, "");
  if (!text) return null;
  if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return NaN;
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 1000000) return NaN;
  return Math.round(number * 100) / 100;
}

function priceToInput(price) {
  if (price == null) return "";
  return new Intl.NumberFormat("da-DK", {
    minimumFractionDigits: Number.isInteger(price) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(price);
}

function formatPrice(price) {
  return new Intl.NumberFormat("da-DK", {
    style: "currency",
    currency: "DKK",
    minimumFractionDigits: Number.isInteger(price) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(price);
}

function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("da-DK", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

function freshState() {
  return { bottles: clone(SEED_BOTTLES), history: [] };
}

function normalizeBottle(raw) {
  if (!raw || typeof raw.name !== "string" || !raw.name.trim()) throw new Error("name");
  const location = normalizeLocation(raw.location);
  if (!location) throw new Error("location");
  const price = raw.price == null || raw.price === "" ? null : Number(raw.price);
  if (price != null && !Number.isFinite(price)) throw new Error("price");
  const bottle = {
    id: String(raw.id || `b-${location}`),
    location,
    name: raw.name.trim(),
    producer: String(raw.producer || "").trim(),
    region: String(raw.region || "").trim(),
    vintage: String(raw.vintage ?? "").trim() || "NV",
    price,
    type: TYPE_SET.has(raw.type) ? raw.type : "andet",
    notes: String(raw.notes || ""),
  };
  if (TYPE_SET.has(raw.hue)) bottle.hue = raw.hue;
  if (typeof raw.sourceId === "string" && raw.sourceId) bottle.sourceId = raw.sourceId;
  if (typeof raw.imageUrl === "string" && /^https?:\/\//i.test(raw.imageUrl)) bottle.imageUrl = raw.imageUrl;
  const profile = WineLookup.sanitizeProfile(raw.profile);
  if (profile) bottle.profile = profile;
  return bottle;
}

function normalizeHistory(raw) {
  const bottle = normalizeBottle({ ...raw, location: raw.fromLocation || raw.location || "A1" });
  return {
    id: String(raw.id || `hist-${bottle.id}`),
    name: bottle.name,
    producer: bottle.producer,
    region: bottle.region,
    vintage: bottle.vintage,
    price: bottle.price,
    type: bottle.type,
    hue: bottle.hue,
    notes: bottle.notes,
    tasting: String(raw.tasting || ""),
    fromLocation: normalizeLocation(raw.fromLocation || raw.location) || bottle.location,
    consumedAt: raw.consumedAt || new Date().toISOString(),
  };
}

function uniqueIds(items) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) item.id = `${item.id}-${seen.size}`;
    seen.add(item.id);
  }
}

function normalizeState(data) {
  const source = Array.isArray(data) ? { bottles: data, history: [] } : data;
  if (!source || !Array.isArray(source.bottles)) throw new Error("shape");
  const bottles = source.bottles.map(normalizeBottle);
  const history = Array.isArray(source.history) ? source.history.map(normalizeHistory) : [];
  const locations = bottles.map((bottle) => bottle.location);
  if (new Set(locations).size !== locations.length) throw new Error("duplicate");
  uniqueIds(bottles);
  uniqueIds(history);
  return { bottles, history };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    cameFromStorage = true;
    return normalizeState(JSON.parse(raw));
  } catch {
    cameFromStorage = false;
    return freshState();
  }
}

function applyMarketPrices() {
  if (typeof MARKET_PRICES === "undefined") return 0;
  let filled = 0;
  for (const bottle of state.bottles) {
    if (bottle.price != null) continue;
    const hit = MARKET_PRICES.find((item) => item.name === bottle.name && item.producer === bottle.producer && item.vintage === bottle.vintage);
    if (!hit) continue;
    bottle.price = hit.price;
    if (!bottle.profile) {
      bottle.profile = WineLookup.sanitizeProfile({
        description: hit.note,
        prices: [{ merchant: hit.merchant, price: hit.price, currency: "DKK", url: hit.url }],
        fetchedAt: "2026-11-14T00:00:00.000Z",
      });
    }
    filled += 1;
  }
  if (filled) persist();
  return filled;
}

function marketToast(filled) {
  if (!filled) return;
  const missing = state.bottles.filter((bottle) => bottle.price == null).length;
  const rest = missing ? ` ${missing} flasker har stadig ingen pris.` : "";
  toast(`Butikspriser er lagt på ${filled} flasker.${rest} Det er aktuelle butikspriser, ikke nødvendigvis det, du gav.`);
}

let priceLookupRunning = false;

async function refreshMissingPrices() {
  const missing = [];
  const seen = new Set();
  for (const bottle of state.bottles) {
    if (bottle.price != null) continue;
    const key = bottleKey(bottle);
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push(bottle);
  }
  if (!missing.length) {
    toast("Alle flasker har allerede en pris.");
    return;
  }
  if (!WineLookup.apiKey()) {
    toast(`${missing.length} vine mangler stadig en pris. Tilføj en WineAPI-nøgle under Vinkilde, så kan de slås op.`);
    return;
  }
  const answer = await askConfirm({
    title: "Slå manglende priser op?",
    text: `${missing.length} vine har ingen pris. Hvert opslag bruger et par af dagens 100 forespørgsler. Kronepriser skrives ind. Andre valutaer vises kun på flasken.`,
    confirmLabel: "Slå op",
  });
  if (!answer.ok || priceLookupRunning) return;
  priceLookupRunning = true;
  let updated = 0;
  try {
    for (const sample of missing) {
      toast(`Slår ${sample.name} op…`);
      let candidates;
      try {
        const query = [sample.name, sample.producer, sample.vintage].filter(Boolean).join(" ");
        candidates = await WineLookup.lookup({ query });
      } catch (error) {
        toast(WineLookup.explain(error));
        if (error.code === "limit" || error.code === "unauthorized" || error.code === "no-key") break;
        continue;
      }
      const wine = candidates?.[0];
      if (!wine) continue;
      const profile = WineLookup.compactProfile(wine);
      const kroner = (profile?.prices || [])
        .map((price) => ({ ...price, amount: moneyNumber(price.price) }))
        .find((price) => isKrone(price.currency) && Number.isFinite(price.amount));
      const key = bottleKey(sample);
      for (const bottle of state.bottles) {
        if (bottle.price != null || bottleKey(bottle) !== key) continue;
        bottle.profile = profile;
        if (wine.id) bottle.sourceId = String(wine.id);
        if (kroner) {
          bottle.price = kroner.amount;
          updated += 1;
        }
      }
      persist();
      renderAll();
    }
  } finally {
    priceLookupRunning = false;
  }
  toast(updated ? `Pris opdateret på ${updated} flasker.` : "Opslaget gav ingen nye kronepriser.");
}

function persist() {
  const saved = document.getElementById("saved");
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (saved) saved.textContent = "Gemt i browseren";
  } catch {
    if (saved) saved.textContent = "Kunne ikke gemmes";
  }
}

function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

function isFiltering() {
  return ui.type !== "alle" || ui.country !== "alle" || ui.query.trim() !== "";
}

function matches(bottle) {
  if (ui.type !== "alle" && bottle.type !== ui.type) return false;
  if (ui.country !== "alle" && countryOf(bottle.region) !== ui.country) return false;
  const query = ui.query.trim();
  if (!query) return true;
  const hay = fold([
    bottle.name,
    bottle.producer,
    bottle.region,
    bottle.vintage,
    bottle.location,
    bottle.fromLocation,
    TYPE_LABEL[bottle.type],
    bottle.notes,
    bottle.tasting,
  ].join(" "));
  return hay.includes(fold(query));
}

function shelfModel(bottles) {
  const map = new Map();
  for (const [letter, nums] of Object.entries(BASE_LAYOUT)) map.set(letter, new Set(nums));
  const loose = [];
  for (const bottle of bottles) {
    const parsed = parseLocation(bottle.location);
    if (!parsed) {
      loose.push(bottle);
      continue;
    }
    if (!map.has(parsed.letter)) map.set(parsed.letter, new Set());
    map.get(parsed.letter).add(parsed.n);
  }
  const shelves = [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "da"))
    .map(([letter, nums]) => ({ letter, slots: [...nums].sort((x, y) => x - y) }));
  return { shelves, loose };
}

function emptySlots(bottles = state.bottles) {
  const occupied = new Set(bottles.map((bottle) => bottle.location));
  const empties = [];
  for (const shelf of shelfModel(bottles).shelves) {
    for (const n of shelf.slots) {
      const code = shelf.letter + n;
      if (!occupied.has(code)) empties.push(code);
    }
  }
  return empties;
}

function countsBy(bottles, getKey) {
  const map = new Map();
  for (const bottle of bottles) {
    const key = getKey(bottle);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "da"));
}

function priceLabel(bottles) {
  const prices = bottles.map((bottle) => bottle.price).filter((price) => price != null);
  if (!prices.length) return "Ingen pris";
  const unique = [...new Set(prices)];
  if (prices.length < bottles.length) {
    return unique.length === 1 ? `${formatPrice(unique[0])} · nogle uden pris` : "Forskellige priser";
  }
  return unique.length === 1 ? formatPrice(unique[0]) : "Forskellige priser";
}

function groupBottles(bottles) {
  const map = new Map();
  for (const bottle of bottles) {
    const key = bottleKey(bottle);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(bottle);
  }
  for (const list of map.values()) list.sort((a, b) => compareLocation(a.location, b.location));
  const groups = [...map.values()];
  groups.sort((a, b) => {
    if (ui.sort === "navn") return a[0].name.localeCompare(b[0].name, "da");
    if (ui.sort === "land") {
      return countryOf(a[0].region).localeCompare(countryOf(b[0].region), "da")
        || a[0].name.localeCompare(b[0].name, "da");
    }
    if (ui.sort === "antal") return b.length - a.length || compareLocation(a[0].location, b[0].location);
    if (ui.sort === "aargang") return (vintageNumber(b[0].vintage) || -1) - (vintageNumber(a[0].vintage) || -1)
      || a[0].name.localeCompare(b[0].name, "da");
    return compareLocation(a[0].location, b[0].location);
  });
  return groups;
}

function optionList(values) {
  return [...values].sort((a, b) => a.localeCompare(b, "da"))
    .map((value) => `<option value="${esc(value)}"></option>`)
    .join("");
}

function typeOptions(selected) {
  return TYPES.map(([id, label]) => `<option value="${id}"${id === selected ? " selected" : ""}>${label}</option>`).join("");
}

function datalists() {
  const names = new Set(state.bottles.map((bottle) => bottle.name));
  const producers = new Set(state.bottles.map((bottle) => bottle.producer).filter(Boolean));
  const regions = new Set(state.bottles.map((bottle) => bottle.region).filter(Boolean));
  return `<datalist id="name-list">${optionList(names)}</datalist>
    <datalist id="producer-list">${optionList(producers)}</datalist>
    <datalist id="region-list">${optionList(regions)}</datalist>`;
}

function statsHtml() {
  const bottles = state.bottles;
  const years = bottles.map((bottle) => vintageNumber(bottle.vintage)).filter(Boolean);
  const empties = emptySlots();
  const priced = bottles.filter((bottle) => bottle.price != null);
  const sum = priced.reduce((total, bottle) => total + bottle.price, 0);
  const oldest = years.length ? Math.min(...years) : null;
  const newest = years.length ? Math.max(...years) : null;
  const nv = bottles.filter((bottle) => bottle.vintage === "NV").length;
  const countries = countsBy(bottles, (bottle) => countryOf(bottle.region));
  const wines = new Set(bottles.map(bottleKey)).size;
  return `<section class="stats" aria-label="Nøgletal">
    <article class="stat">
      <p class="stat-kicker">I køleskabet</p>
      <p class="stat-value">${bottles.length}</p>
      <p class="stat-note">${oldest ? `Ældste ${oldest} · nyeste ${newest}` : "Ingen årgang"}${nv ? ` · ${nv} NV` : ""}</p>
    </article>
    <article class="stat">
      <p class="stat-kicker">Forskellige vine</p>
      <p class="stat-value">${wines}</p>
      <p class="stat-note">${countsBy(bottles, (bottle) => bottle.producer || "Ukendt").length} producenter</p>
    </article>
    <article class="stat">
      <p class="stat-kicker">Lande</p>
      <p class="stat-value">${countries.length}</p>
      <p class="stat-note">${countries[0] ? `${countries[0][0]} fylder mest` : "Ingen område endnu"}</p>
    </article>
    <article class="stat">
      <p class="stat-kicker">Ledige pladser</p>
      <p class="stat-value">${empties.length}</p>
      <p class="stat-note">${empties.length ? empties.slice(0, 4).join(", ") : "Køleskabet er fuldt"}</p>
    </article>
    <article class="stat">
      <p class="stat-kicker">Værdi</p>
      <p class="stat-value">${priced.length ? formatPrice(sum) : "—"}</p>
      <p class="stat-note">${priced.length ? `${priced.length} med pris · ${bottles.length - priced.length} uden` : "Tilføj pris på en flaske"}</p>
    </article>
  </section>`;
}

function barRows(entries, max, kind) {
  return entries.map(([label, count]) => {
    const width = max ? Math.max(4, Math.round((count / max) * 100)) : 0;
    const pressed = kind === "country" ? ui.country === label : ui.type === label;
    const action = kind === "country" ? "filter-country" : "filter-type";
    const attr = kind === "country" ? "data-country" : "data-type";
    const barClass = kind === "type" ? TYPE_CLASS[label] || "" : "";
    return `<button type="button" class="dist-row${pressed ? " is-on" : ""}" data-action="${action}" ${attr}="${esc(label)}">
      <strong>${esc(kind === "type" ? TYPE_LABEL[label] : label)}</strong>
      <span class="bar ${barClass}"><span style="width:${width}%"></span></span>
      <span>${count}</span>
    </button>`;
  }).join("");
}

const LOGO_CACHE = "vinkoleskab.producer-logos";
const LOGO_TTL = 21 * 24 * 60 * 60 * 1000;

const PRODUCER_LOGOS = {
  "merenda sinoira": "logos/merenda.png",
  gamazo: "logos/gamazo.png",
  vietti: "logos/vietti.svg",
  "le crocine": "logos/crocine.png",
  "ca dei frati": "logos/frati.png",
  "villiera grier familien": "logos/villiera.png",
  "golan heights winery hermon": "logos/hermon.svg",
  "ilatium morini": "logos/morini.png",
  "pagos de matanegra": "logos/matanegra.png",
  "domaine roy": "logos/roy.png",
  kirsten: "logos/kirsten.png",
  "oak ridge winery": "logos/oak.png",
  "quinta de sao jose": "logos/sao-jose.png",
  "falua conde vimioso": "logos/vimioso.svg",
  izarbe: "logos/chavarri.svg",
  "tenuta monte rosola": "logos/rosola.png",
  frederiksdal: "logos/frederiksdal.svg",
};

function producerToken(name) {
  return fold(name).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function producerInitials(name) {
  const words = producerToken(name).split(" ").filter((word) => word.length > 1);
  const pick = words.length > 1 ? [words[0], words.at(-1)] : words;
  return pick.map((word) => word[0]).join("").toLocaleUpperCase("da") || "•";
}

function logoCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(LOGO_CACHE) || "{}");
    return cache && typeof cache === "object" ? cache : {};
  } catch {
    return {};
  }
}

function rememberedLogo(name) {
  const hit = logoCache()[producerToken(name)];
  if (!hit || Date.now() - Number(hit.at) > LOGO_TTL) return null;
  return typeof hit.url === "string" ? hit.url : "";
}

function rememberLogo(name, url) {
  const cache = logoCache();
  cache[producerToken(name)] = { url: String(url || ""), at: Date.now() };
  try {
    localStorage.setItem(LOGO_CACHE, JSON.stringify(cache));
  } catch {
    /* logo-cache er valgfri */
  }
}

function faviconUrl(domain) {
  const host = String(domain || "").replace(/^https?:\/\//i, "").split("/")[0];
  return host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128` : "";
}

function claimText(entity, prop) {
  const value = entity?.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value;
  return typeof value === "string" ? value : "";
}

async function wikiJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("wiki");
  return response.json();
}

async function resolveProducerLogo(name) {
  const plainName = String(name).replace(/\s*\([^)]*\)/g, " ").trim();
  const queries = [plainName, `${plainName} winery`];
  try {
    for (const query of queries) {
      const found = await wikiJson(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&uselang=en&type=item&limit=4&format=json&origin=*`);
      const hits = (found.search || []).filter((hit) => /winery|wine|vineyard|bodega|weingut|domaine|château|chateau|quinta|cantina|vintner|cellar/.test(`${hit.label || ""} ${hit.description || ""}`.toLowerCase()));
      if (!hits.length) continue;
      const data = await wikiJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${hits.map((hit) => hit.id).join("|")}&props=claims&format=json&origin=*`);
      for (const hit of hits) {
        const entity = data.entities?.[hit.id];
        const logo = claimText(entity, "P154");
        if (logo) return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(logo.replace(/ /g, "_"))}?width=160`;
        const website = claimText(entity, "P856");
        if (website) return faviconUrl(website);
      }
    }
  } catch {
    /* logo-opslag er valgfrit */
  }
  return "";
}

let logoRun = 0;

function hydrateProducerLogos() {
  const pending = [...document.querySelectorAll(".rank-logo.is-pending")];
  if (!pending.length) return;
  const run = ++logoRun;
  const names = [...new Set(pending.map((node) => node.dataset.producer).filter(Boolean))];
  for (const name of names) {
    resolveProducerLogo(name).then((url) => {
      if (run !== logoRun) return;
      rememberLogo(name, url);
      for (const node of document.querySelectorAll(".rank-logo.is-pending")) {
        if (node.dataset.producer !== name) continue;
        node.classList.remove("is-pending");
        if (!url) continue;
        const img = document.createElement("img");
        img.alt = "";
        img.referrerPolicy = "no-referrer";
        img.src = url;
        node.replaceChildren(img);
      }
    });
  }
}

function rankHtml(name, count) {
  const token = producerToken(name);
  const known = PRODUCER_LOGOS[token] || "";
  const cached = known ? null : rememberedLogo(name);
  const src = known || cached || "";
  const pending = !src && cached === null ? " is-pending" : "";
  const mark = src
    ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : `<span>${esc(producerInitials(name))}</span>`;
  const on = fold(ui.query) === fold(name) ? " is-on" : "";
  return `<button type="button" class="rank${on}" data-action="search" data-q="${esc(name)}">
    <span class="rank-logo${pending}" data-producer="${esc(name)}">${mark}</span>
    <span class="rank-name">${esc(name)}</span>
    <strong>${count}</strong>
  </button>`;
}

function distributionHtml() {
  const types = countsBy(state.bottles, (bottle) => bottle.type);
  const countries = countsBy(state.bottles, (bottle) => countryOf(bottle.region));
  const producers = countsBy(state.bottles, (bottle) => bottle.producer || "Ukendt").slice(0, 6);
  const typeMax = types[0]?.[1] || 1;
  const countryMax = countries[0]?.[1] || 1;
  return `<div class="split">
    <section class="card">
      <p class="section-kicker">Fordeling</p>
      <h2>Hvad der ligger der</h2>
      ${barRows(types, typeMax, "type")}
      <div style="height:10px"></div>
      ${barRows(countries, countryMax, "country")}
    </section>
    <section class="card">
      <p class="section-kicker">Producenter</p>
      <h2>Flest flasker</h2>
      ${producers.map(([name, count]) => rankHtml(name, count)).join("")}
    </section>
  </div>`;
}

async function refreshPhotos() {
  try {
    const stored = await WineLookup.allPhotos();
    for (const url of photoUrls.values()) URL.revokeObjectURL(url);
    photoUrls = new Map();
    for (const [id, blob] of stored) {
      if (blob instanceof Blob) photoUrls.set(id, URL.createObjectURL(blob));
    }
  } catch {
    /* billeder er valgfrie */
  }
}

function labelImage(bottle) {
  const key = bottleKey(bottle);
  const group = [bottle, ...state.bottles.filter((item) => item.id !== bottle.id && bottleKey(item) === key)];
  for (const item of group) if (photoUrls.has(item.id)) return photoUrls.get(item.id);
  const local = typeof LABEL_FILES === "undefined" ? "" : LABEL_FILES[[bottle.name, bottle.producer, bottle.vintage].join("|")];
  if (local) return local;
  for (const item of group) {
    const url = item.imageUrl || item.profile?.imageUrl;
    if (url) return url;
  }
  return "";
}

function slotHtml(code, bottle) {
  const filtering = isFiltering();
  if (!bottle) {
    const adding = ui.panel?.type === "add" && ui.panel.location === code;
    return `<button type="button" class="slot is-empty${filtering ? " is-dim" : ""}${adding ? " is-selected" : ""}" data-action="add" data-location="${esc(code)}" data-slot="${esc(code)}" aria-label="${esc(code)}, ledig plads">
      <span class="code">${esc(code)}</span>
      <span class="plus" aria-hidden="true">+</span>
      <span class="sname">Ledig</span>
    </button>`;
  }
  const dim = filtering && !matches(bottle);
  const selected = ui.panel?.type === "bottle" && ui.panel.id === bottle.id;
  const image = labelImage(bottle);
  const focus = image && typeof LABEL_FOCUS !== "undefined" ? LABEL_FOCUS[image] : "";
  const visual = image
    ? `<span class="thumb" aria-hidden="true"><span class="thumb-year">${esc(bottle.vintage)}</span><img src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer"${focus ? ` style="--label-y:${esc(focus)}"` : ""}></span>`
    : `<span class="bottle" aria-hidden="true"><span class="body"><span class="label">${esc(bottle.vintage)}</span></span><span class="neck"></span><span class="mouth"></span></span>`;
  return `<button type="button" class="slot tone-${tone(bottle)}${dim ? " is-dim" : ""}${selected ? " is-selected" : ""}" data-action="open" data-id="${esc(bottle.id)}" data-slot="${esc(code)}" title="${esc(`${bottle.name} · ${bottle.producer} · ${bottle.vintage}`)}">
    <span class="code">${esc(code)}</span>
    ${visual}
    <span class="sname">${esc(bottle.name)}</span>
  </button>`;
}

function fridgeHtml() {
  const { shelves, loose } = shelfModel(state.bottles);
  const occupied = new Map(state.bottles.map((bottle) => [bottle.location, bottle]));
  const columns = Math.max(1, ...shelves.map((shelf) => shelf.slots.length));
  const shelvesHtml = shelves.map((shelf) => {
    const filled = shelf.slots.filter((n) => occupied.has(shelf.letter + n)).length;
    return `<div class="shelf">
      <div class="shelf-label"><strong>${esc(shelf.letter)}</strong><span>${filled}/${shelf.slots.length}</span></div>
      <div class="rail" style="--n:${columns}">
        ${shelf.slots.map((n) => slotHtml(shelf.letter + n, occupied.get(shelf.letter + n))).join("")}
      </div>
    </div>`;
  }).join("");
  const looseHtml = loose.length
    ? `<div class="card" style="margin-top:12px"><h2>Andre placeringer</h2><div class="locs">${loose.map((bottle) => `<button type="button" class="loc" data-action="open" data-id="${esc(bottle.id)}">${esc(bottle.location)} · ${esc(bottle.name)}</button>`).join("")}</div></div>`
    : "";
  const empties = emptySlots();
  return `<section class="panel">
    <div class="panel-head">
      <div>
        <p class="section-kicker">Placering</p>
        <h2>Køleskabet</h2>
      </div>
      <ul class="legend">
        <li><i class="swatch"></i> Rød</li>
        <li><i class="swatch hvid"></i> Hvid</li>
        <li><i class="swatch mousserende"></i> Mousserende</li>
      </ul>
    </div>
    <div class="fridge">${shelvesHtml}</div>
    <p class="hint">${empties.length ? `${joinList(empties)} er ledig${empties.length > 1 ? "e" : ""}. Klik på pladsen for at lægge en flaske der.` : "Alle viste pladser er optaget."} Mangler en plads i oversigten, kan du oprette den med Ny flaske.</p>
    ${looseHtml}
  </section>`;
}

function featureCard(group) {
  const first = group[0];
  const image = labelImage(first);
  return `<button type="button" class="feature tone-${tone(first)}" data-action="open" data-id="${esc(first.id)}">
    <span class="feature-art${image ? " has-photo" : ""}" aria-hidden="true">
      <span class="silhouette"></span>
      ${image ? `<img src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.remove('has-photo');this.remove()">` : ""}
      <span class="feature-year">${esc(first.vintage)}</span>
    </span>
    <span class="feature-name">${esc(first.name)}</span>
    <span class="feature-by">${esc(first.producer || countryOf(first.region))}</span>
    <span class="feature-foot"><strong>${esc(priceLabel(group))}</strong><span>${esc(group.map((bottle) => bottle.location).join(" · "))}</span></span>
  </button>`;
}

function featuredHtml() {
  const groups = groupBottles(state.bottles.filter(matches));
  if (!groups.length) return "";
  const picks = [...groups]
    .sort((a, b) => (b[0].price ?? -1) - (a[0].price ?? -1))
    .slice(0, 10);
  return `<section class="featured">
    <div class="panel-head">
      <div>
        <p class="section-kicker">Udvalgt</p>
        <h2>Kælderens perler</h2>
      </div>
      <button type="button" class="btn text" data-action="tab" data-tab-target="katalog">Se alle</button>
    </div>
    <div class="carousel">${picks.map(featureCard).join("")}</div>
  </section>`;
}

function overviewHtml() {
  const shown = state.bottles.filter(matches).length;
  return `<p class="lede">Hver flaske ligger på sin plads fra oversigten. Åbn en plads for at rette, flytte eller registrere, at flasken er drukket.</p>
    ${featuredHtml()}
    ${statsHtml()}
    ${distributionHtml()}
    ${isFiltering() && shown === 0 ? `<div class="empty"><h2>Ingen flasker matcher</h2><p>Ryd filtrene for at se hele køleskabet. De dæmpede flasker bliver stående, så du stadig kan se hylderne.</p></div>` : ""}
    ${fridgeHtml()}
    ${colophonHtml()}`;
}

function wineCard(group) {
  const first = group[0];
  const types = [...new Set(group.map((bottle) => bottle.type))];
  const typeName = types.length === 1 ? TYPE_LABEL[types[0]] : "Flere typer";
  const typeClass = types.length === 1 ? TYPE_CLASS[types[0]] : "andet";
  const detail = regionDetail(first.region);
  const image = labelImage(first);
  return `<article class="wine has-art tone-${tone(first)}" data-open="1" data-id="${esc(first.id)}" tabindex="0">
    <div class="wine-art" aria-hidden="true">
      <span class="silhouette"></span>
      ${image ? `<img src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
    </div>
    <div class="wine-main">
      <h3>${esc(first.name)}</h3>
      <p class="by">${esc(first.producer || "Producent ikke angivet")}</p>
      <p class="region">${esc(countryOf(first.region))}${detail ? ` · ${esc(detail)}` : ""}</p>
    </div>
    <p class="year">${esc(first.vintage)}</p>
    <div class="meta">
      <span class="tag ${typeClass}">${esc(typeName)}</span>
      <span>${flasker(group.length)}</span>
      <span>${esc(priceLabel(group))}</span>
    </div>
    <div class="locs">
      ${group.map((bottle) => `<button type="button" class="loc" data-action="open" data-id="${esc(bottle.id)}">${esc(bottle.location)}</button>`).join("")}
    </div>
  </article>`;
}

function catalogHtml() {
  const groups = groupBottles(state.bottles.filter(matches));
  const options = [
    ["placering", "Placering"],
    ["navn", "Navn"],
    ["aargang", "Årgang"],
    ["land", "Land"],
    ["antal", "Antal"],
  ].map(([id, label]) => `<option value="${id}"${ui.sort === id ? " selected" : ""}>${label}</option>`).join("");
  const body = groups.length
    ? `<div class="ledger">${groups.map(wineCard).join("")}</div>`
    : `<div class="empty"><h2>Ingen vine matcher</h2><p>Prøv et andet ord, eller ryd filtrene.</p></div>`;
  return `<section class="panel">
    <div class="catalog-head">
      <div>
        <p class="section-kicker">Samlet efter etiket</p>
        <h2>Katalog</h2>
      </div>
      <label>Sortér <select id="sort" class="inline-select">${options}</select></label>
    </div>
    ${body}
    ${colophonHtml()}
  </section>`;
}

function historyHtml() {
  const items = state.history.filter(matches);
  if (!state.history.length) {
    return `<div class="empty"><h2>Historikken er tom</h2><p>Når du drikker en flaske, lander den her med dato og en eventuel smagsnote. Du kan lægge den tilbage, hvis det var en fejl.</p></div>`;
  }
  if (!items.length) {
    return `<div class="empty"><h2>Ingen historik matcher</h2><p>Ryd filtrene for at se alt, der er drukket.</p></div>`;
  }
  return `<section class="panel"><div class="catalog-head"><div><p class="section-kicker">Drukket</p><h2>Historik</h2></div></div>
    <div class="ledger">${items.map((item) => `<article class="wine history">
      <div>
        <h3>${esc(item.name)}</h3>
        <p class="by">${esc(item.producer || "Producent ikke angivet")}</p>
        <p class="when">${esc(formatWhen(item.consumedAt))} · fra ${esc(item.fromLocation)} · ${esc(item.vintage)}</p>
        ${item.tasting ? `<p class="tasting">${esc(item.tasting)}</p>` : ""}
      </div>
      <p class="year">${esc(TYPE_LABEL[item.type] || "")}</p>
      <div class="locs"><button type="button" class="btn ghost" data-action="restore" data-id="${esc(item.id)}">Læg tilbage</button></div>
    </article>`).join("")}</div></section>`;
}

function colophonHtml() {
  return `<p class="colophon">Ændringer gemmes i denne browser. Brug Data og eksporter en backup, hvis du skifter computer eller browser.</p>`;
}

function field(name, label, value, extra = "") {
  return `<label class="field ${extra.includes("wide") ? "wide" : ""}"><span>${label}</span><input name="${name}" ${extra} value="${esc(value)}"></label>`;
}

function scanHtml() {
  const hasKey = Boolean(WineLookup.apiKey());
  return `<section class="scan">
    <p class="drawer-kicker">Etiket</p>
    <div class="scan-actions">
      <label class="btn ghost file-btn">Tag billede<input id="label-camera" type="file" accept="image/*" capture="environment"></label>
      <label class="btn ghost file-btn">Vælg billede<input id="label-file" type="file" accept="image/*"></label>
      <button type="button" class="btn ghost" data-action="clear-photo" hidden id="clear-photo">Fjern billede</button>
    </div>
    <img id="label-preview" alt="Billede af etiketten" hidden>
    <div class="scan-actions">
      <button type="button" class="btn ghost" data-action="lookup-photo" id="lookup-photo" hidden>Hent fra billedet</button>
      <button type="button" class="btn ghost" data-action="lookup-text">Hent oplysninger</button>
    </div>
    <p id="lookup-status" class="hint">${hasKey ? "Et billede slår vinen op. Uden billede bruges navn, producent og årgang." : "Tilføj en gratis WineAPI-nøgle under Data → Vinkilde for at hente vin og priser."}</p>
    <div id="lookup-results"></div>
  </section>`;
}

function profileHtml(profile) {
  if (!profile) return "";
  const grapes = profile.grapes?.length ? profile.grapes.join(", ") : "";
  const score = profile.rating == null ? "" : `Score ${profile.rating}${profile.ratingsCount ? ` (${profile.ratingsCount})` : ""}`;
  const prices = (profile.prices || []).map((price) => {
    const href = price.url ? `<a href="${esc(price.url)}" target="_blank" rel="noopener">${esc(price.merchant || "Kilde")}</a>` : esc(price.merchant || "Kilde");
    return `<li>${esc(price.price)} ${esc(price.currency)} · ${href}</li>`;
  }).join("");
  return `<div class="hit">
    <h3>Seneste opslag</h3>
    ${profile.imageUrl ? `<img class="hit-img" src="${esc(profile.imageUrl)}" alt="Etiket fra opslaget" loading="lazy" referrerpolicy="no-referrer">` : ""}
    ${grapes ? `<p>${esc(grapes)}</p>` : ""}
    ${score ? `<p>${esc(score)}</p>` : ""}
    ${profile.description ? `<p>${esc(profile.description)}</p>` : ""}
    ${prices ? `<ul class="prices">${prices}</ul>` : "<p>Ingen priser i opslaget.</p>"}
  </div>`;
}

function bottleForm(bottle) {
  const siblings = state.bottles.filter((item) => bottleKey(item) === bottleKey(bottle));
  const empties = emptySlots().filter((code) => code !== bottle.location);
  const moveOptions = [`<option value="">Bliv på ${esc(bottle.location)}</option>`]
    .concat(empties.map((code) => `<option value="${esc(code)}">${esc(code)}</option>`))
    .join("");
  return `<form id="bottle-form">
    <div class="chips">${siblings.map((item) => `<button type="button" class="loc${item.id === bottle.id ? " is-on" : ""}" data-action="open" data-id="${esc(item.id)}">${esc(item.location)}</button>`).join("")}</div>
    ${scanHtml()}
    ${profileHtml(bottle.profile)}
    <input type="hidden" name="sourceId" value="${esc(bottle.sourceId || "")}">
    <input type="hidden" name="profileJson" value="${esc(bottle.profile ? JSON.stringify(bottle.profile) : "")}">
    <div class="form-grid">
      ${field("name", "Vin", bottle.name, 'id="field-name" list="name-list" class="wide" required')}
      ${field("producer", "Producent", bottle.producer, 'list="producer-list"')}
      ${field("vintage", "Årgang", bottle.vintage, 'placeholder="2022 eller NV"')}
      <label class="field wide"><span>Område</span><input name="region" list="region-list" value="${esc(bottle.region)}"></label>
      <label class="field"><span>Type</span><select name="type">${typeOptions(bottle.type)}</select></label>
      <label class="field"><span>Pris</span><span class="with-suffix"><input name="price" inputmode="decimal" placeholder="0" value="${esc(priceToInput(bottle.price))}"><em>kr.</em></span></label>
      <label class="field wide"><span>Note</span><textarea name="notes" placeholder="Indkøb, hylde eller noget du vil huske">${esc(bottle.notes)}</textarea></label>
      <label class="field"><span>Flyt til ledig plads</span><select name="moveTo">${moveOptions}</select></label>
      ${field("moveCustom", "Eller ny plads", "", 'placeholder="f.eks. E7" spellcheck="false"')}
    </div>
    ${siblings.length > 1 ? `<label class="check"><input type="checkbox" name="applyAll" checked><span>Gem navn, producent, område, årgang, type, pris og opslag på alle ${siblings.length} flasker. Noten, billedet og placeringen gælder kun denne.</span></label>` : ""}
    <p id="form-error" class="form-error"></p>
    <div class="drawer-actions">
      <button class="btn primary" type="submit">Gem</button>
      <button class="btn ghost" type="button" data-action="drink">Drik flasken</button>
      <button class="btn danger-ghost" type="button" data-action="remove">Fjern flasken</button>
    </div>
    ${datalists()}
  </form>`;
}

function addForm(location) {
  const empties = emptySlots();
  const wines = [];
  const seen = new Set();
  for (const bottle of state.bottles) {
    const key = bottleKey(bottle);
    if (seen.has(key)) continue;
    seen.add(key);
    wines.push(bottle);
  }
  wines.sort((a, b) => a.name.localeCompare(b.name, "da"));
  const copies = [`<option value="">Skriv selv</option>`]
    .concat(wines.map((bottle) => `<option value="${esc(bottle.id)}">${esc(`${bottle.name} · ${bottle.vintage} · ${bottle.producer}`)}</option>`))
    .join("");
  return `<form id="bottle-form">
    ${scanHtml()}
    <input type="hidden" name="sourceId" value="">
    <input type="hidden" name="profileJson" value="">
    <div class="form-grid">
      ${field("location", "Placering", location || empties[0] || "", 'id="field-name" list="empty-list" spellcheck="false" placeholder="f.eks. I6" required')}
      <label class="field"><span>Udfyld fra en vin i kælderen</span><select name="copyFrom">${copies}</select></label>
      ${field("name", "Vin", "", 'list="name-list" required')}
      ${field("producer", "Producent", "", 'list="producer-list"')}
      ${field("vintage", "Årgang", "", 'placeholder="2022 eller NV" required')}
      <label class="field wide"><span>Område</span><input name="region" list="region-list" placeholder="Land, region"></label>
      <label class="field"><span>Type</span><select name="type">${typeOptions("rød")}</select></label>
      <label class="field"><span>Pris</span><span class="with-suffix"><input name="price" inputmode="decimal" placeholder="0"><em>kr.</em></span></label>
      <label class="field wide"><span>Note</span><textarea name="notes"></textarea></label>
    </div>
    <p id="form-error" class="form-error"></p>
    <div class="drawer-actions">
      <button class="btn primary" type="submit">Læg i køleskabet</button>
      <button class="btn danger-ghost" type="button" data-action="close">Annuller</button>
    </div>
    <datalist id="empty-list">${empties.map((code) => `<option value="${esc(code)}"></option>`).join("")}</datalist>
    ${datalists()}
  </form>`;
}

function readForm(form) {
  const data = {};
  for (const field of form.elements) {
    if (!field.name) continue;
    data[field.name] = field.type === "checkbox" ? field.checked : field.value;
  }
  return data;
}

function captureSnapshot() {
  const form = document.getElementById("bottle-form");
  snapshot = form ? JSON.stringify(readForm(form)) : "";
}

function isDirty() {
  if (pendingPhoto || photoRemoved) return true;
  const form = document.getElementById("bottle-form");
  if (!form) return false;
  return JSON.stringify(readForm(form)) !== snapshot;
}

function takenProfile(data, fallback) {
  if (!data.profileJson) return fallback;
  try {
    return WineLookup.sanitizeProfile(JSON.parse(data.profileJson)) || undefined;
  } catch {
    return fallback;
  }
}

function showFormError(message) {
  const el = document.getElementById("form-error");
  if (el) el.textContent = message;
}

function cleanVintage(value) {
  const vintage = String(value || "").trim();
  return fold(vintage) === "nv" ? "NV" : vintage;
}

function saveBottle(id, data) {
  const original = state.bottles.find((bottle) => bottle.id === id);
  if (!original) return "Flasken findes ikke længere.";
  if (!data.name.trim()) return "Skriv vinens navn.";
  const vintage = cleanVintage(data.vintage);
  if (!vintage) return "Skriv årgang, eller NV hvis den ikke har én.";
  const price = parsePrice(data.price);
  if (Number.isNaN(price)) return "Prisen skal være et tal, f.eks. 149 eller 149,50.";
  let location = original.location;
  if (data.moveCustom.trim()) {
    const custom = normalizeLocation(data.moveCustom);
    if (!custom) return "Ny plads skal skrives som bogstav og tal, f.eks. E7.";
    location = custom;
  } else if (data.moveTo) location = data.moveTo;
  if (location !== original.location && state.bottles.some((bottle) => bottle.location === location && bottle.id !== id)) {
    return `${location} er allerede optaget.`;
  }
  const type = TYPE_SET.has(data.type) ? data.type : original.type;
  const next = {
    ...original,
    location,
    name: data.name.trim(),
    producer: data.producer.trim(),
    region: data.region.trim(),
    vintage,
    type,
    price,
    notes: data.notes.trim(),
  };
  const profile = takenProfile(data, original.profile);
  const sourceId = String(data.sourceId || original.sourceId || "");
  if (profile) next.profile = profile;
  else delete next.profile;
  if (sourceId) next.sourceId = sourceId;
  else delete next.sourceId;
  if (type === original.type && original.hue) next.hue = original.hue;
  else delete next.hue;
  const key = bottleKey(original);
  if (data.applyAll) {
    state.bottles = state.bottles.map((bottle) => {
      if (bottle.id === id) return next;
      if (bottleKey(bottle) !== key) return bottle;
      const updated = { ...bottle, name: next.name, producer: next.producer, region: next.region, vintage: next.vintage, type: next.type, price: next.price };
      if (next.profile) updated.profile = next.profile;
      else delete updated.profile;
      if (next.sourceId) updated.sourceId = next.sourceId;
      else delete updated.sourceId;
      if (updated.type !== bottle.type) delete updated.hue;
      return updated;
    });
  } else {
    state.bottles = state.bottles.map((bottle) => (bottle.id === id ? next : bottle));
  }
  persist();
  return "";
}

function addBottle(data) {
  const location = normalizeLocation(data.location);
  if (!location) return "Skriv pladsen som bogstav og tal, f.eks. I6.";
  if (state.bottles.some((bottle) => bottle.location === location)) return `${location} er allerede optaget.`;
  if (!data.name.trim()) return "Skriv vinens navn.";
  const vintage = cleanVintage(data.vintage);
  if (!vintage) return "Skriv årgang, eller NV hvis den ikke har én.";
  const price = parsePrice(data.price);
  if (Number.isNaN(price)) return "Prisen skal være et tal, f.eks. 149 eller 149,50.";
  const bottle = {
    id: `b-${Date.now().toString(36)}`,
    location,
    name: data.name.trim(),
    producer: data.producer.trim(),
    region: data.region.trim(),
    vintage,
    type: TYPE_SET.has(data.type) ? data.type : "rød",
    price,
    notes: data.notes.trim(),
  };
  const profile = takenProfile(data);
  if (profile) bottle.profile = profile;
  if (data.sourceId) bottle.sourceId = data.sourceId;
  state.bottles.push(bottle);
  persist();
  ui.panel = { type: "bottle", id: bottle.id };
  return "";
}

function drinkBottle(bottle, tasting) {
  WineLookup.deletePhoto(bottle.id).catch(() => {});
  state.bottles = state.bottles.filter((item) => item.id !== bottle.id);
  state.history.unshift({
    id: `hist-${Date.now().toString(36)}`,
    name: bottle.name,
    producer: bottle.producer,
    region: bottle.region,
    vintage: bottle.vintage,
    price: bottle.price,
    type: bottle.type,
    hue: bottle.hue,
    notes: bottle.notes,
    tasting: tasting.trim(),
    fromLocation: bottle.location,
    consumedAt: new Date().toISOString(),
  });
  persist();
}

function restoreBottle(item, location) {
  const code = normalizeLocation(location);
  if (!code) return "Vælg eller skriv en ledig plads.";
  if (state.bottles.some((bottle) => bottle.location === code)) return `${code} er optaget.`;
  const bottle = {
    id: `b-${Date.now().toString(36)}`,
    location: code,
    name: item.name,
    producer: item.producer,
    region: item.region,
    vintage: item.vintage,
    price: item.price,
    type: item.type,
    notes: item.notes || "",
  };
  if (item.hue) bottle.hue = item.hue;
  state.bottles.push(bottle);
  state.history = state.history.filter((entry) => entry.id !== item.id);
  persist();
  return "";
}

function joinList(list) {
  if (list.length <= 1) return list[0] || "";
  return `${list.slice(0, -1).join(", ")} og ${list[list.length - 1]}`;
}

function renderFilters() {
  const types = countsBy(state.bottles, (bottle) => bottle.type);
  const typeCounts = Object.fromEntries(types);
  const countries = countsBy(state.bottles, (bottle) => countryOf(bottle.region));
  const pills = [["alle", "Alle", state.bottles.length]]
    .concat(TYPES.map(([id, label]) => [id, label, typeCounts[id] || 0]))
    .filter(([id, , count]) => id === "alle" || count > 0 || id === ui.type);
  const host = document.getElementById("filters");
  host.innerHTML = pills.map(([id, label, count]) => `<button type="button" class="choice${ui.type === id ? " is-on" : ""}" data-type="${id}" aria-pressed="${ui.type === id}">${esc(label)} <em>${count}</em></button>`).join("")
    + `<select id="country" class="inline-select" aria-label="Land"><option value="alle">Alle lande</option>${countries.map(([name, count]) => `<option value="${esc(name)}"${ui.country === name ? " selected" : ""}>${esc(name)} · ${count}</option>`).join("")}</select>`;
}

function syncFilterUI() {
  document.querySelectorAll("#filters [data-type]").forEach((button) => {
    const on = button.dataset.type === ui.type;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", String(on));
  });
  const country = document.getElementById("country");
  if (country && [...country.options].some((option) => option.value === ui.country)) country.value = ui.country;
}

function syncChrome() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const on = button.dataset.tab === ui.tab;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-selected", String(on));
  });
  const hist = document.getElementById("hist-count");
  if (hist) {
    const count = state.history.length;
    hist.textContent = count ? (count > 99 ? "99+" : String(count)) : "";
    hist.setAttribute("aria-label", count ? `${count} drukket` : "");
  }
  document.getElementById("clear-search").hidden = ui.query.trim() === "";
}

function renderResultLine() {
  const line = document.getElementById("resultline");
  const clear = isFiltering() ? ` <button type="button" data-action="clear-filters">Ryd filtre</button>` : "";
  if (ui.tab === "historik") {
    const shown = state.history.filter(matches).length;
    line.innerHTML = isFiltering()
      ? `${shown} matcher i historikken · ${state.history.length} i alt${clear}`
      : `${flasker(state.history.length)} i historikken`;
    return;
  }
  const shown = state.bottles.filter(matches).length;
  line.innerHTML = isFiltering()
    ? `${shown} matcher · ${flasker(state.bottles.length)} i køleskabet${clear}`
    : `${flasker(state.bottles.length)} i køleskabet`;
}

function renderView() {
  const y = window.scrollY;
  const view = document.getElementById("view");
  if (ui.tab === "katalog") view.innerHTML = catalogHtml();
  else if (ui.tab === "historik") view.innerHTML = historyHtml();
  else view.innerHTML = overviewHtml();
  syncChrome();
  renderResultLine();
  window.scrollTo(0, y);
  if (ui.tab === "oversigt") hydrateProducerLogos();
}

function resetLookupState() {
  pendingPhoto = null;
  pendingUpload = null;
  photoRemoved = false;
  lookupCandidates = [];
  if (lookupPreviewUrl) URL.revokeObjectURL(lookupPreviewUrl);
  lookupPreviewUrl = "";
}

function showPreview(blob) {
  const image = document.getElementById("label-preview");
  const clear = document.getElementById("clear-photo");
  const fromPhoto = document.getElementById("lookup-photo");
  if (!image) return;
  if (lookupPreviewUrl) URL.revokeObjectURL(lookupPreviewUrl);
  if (!blob) {
    lookupPreviewUrl = "";
    image.removeAttribute("src");
    image.hidden = true;
    if (clear) clear.hidden = true;
    if (fromPhoto) fromPhoto.hidden = true;
    return;
  }
  lookupPreviewUrl = URL.createObjectURL(blob);
  image.src = lookupPreviewUrl;
  image.hidden = false;
  if (clear) clear.hidden = false;
  if (fromPhoto) fromPhoto.hidden = false;
}

async function paintStoredPhoto(id) {
  if (!id || pendingPhoto) return;
  try {
    const blob = await WineLookup.loadPhoto(id);
    if (!blob || pendingPhoto || !document.getElementById("label-preview")) return;
    pendingUpload = blob;
    showPreview(blob);
  } catch {
    /* billedet er valgfrit */
  }
}

function renderDrawer(force = false) {
  const key = ui.panel ? `${ui.panel.type}:${ui.panel.id || ui.panel.location || "ny"}` : "";
  if (!force && key === drawerKey) return;
  drawerKey = key;
  resetLookupState();
  const drawer = document.getElementById("drawer");
  const backdrop = document.getElementById("backdrop");
  if (!ui.panel) {
    drawer.hidden = true;
    backdrop.hidden = true;
    drawer.innerHTML = "";
    return;
  }
  if (ui.panel.type === "bottle") {
    const bottle = state.bottles.find((item) => item.id === ui.panel.id);
    if (!bottle) {
      ui.panel = null;
      drawerKey = "";
      drawer.hidden = true;
      backdrop.hidden = true;
      drawer.innerHTML = "";
      return;
    }
    drawer.innerHTML = `<div class="drawer-body"><div class="drawer-top"><div><p class="drawer-kicker">Plads ${esc(bottle.location)}</p><h2>${esc(bottle.name)}</h2><p class="sub">${esc(bottle.producer)} · ${esc(bottle.vintage)}</p></div><button type="button" class="icon-btn" data-action="close" aria-label="Luk">×</button></div>${bottleForm(bottle)}</div>`;
  } else {
    drawer.innerHTML = `<div class="drawer-body"><div class="drawer-top"><div><p class="drawer-kicker">Ny flaske</p><h2>Læg en flaske ind</h2></div><button type="button" class="icon-btn" data-action="close" aria-label="Luk">×</button></div>${addForm(ui.panel.location || "")}</div>`;
  }
  drawer.hidden = false;
  backdrop.hidden = false;
  captureSnapshot();
  if (ui.panel?.type === "bottle") paintStoredPhoto(ui.panel.id);
}

function removeModal() {
  const bottles = [...state.bottles].sort((a, b) => compareLocation(a.location, b.location) || a.name.localeCompare(b.name, "da"));
  const rows = bottles.map((bottle) => {
    const search = fold(`${bottle.location} ${bottle.name} ${bottle.producer} ${bottle.vintage}`);
    return `<button type="button" class="pick" data-remove-id="${esc(bottle.id)}" data-search="${esc(search)}">
      <strong>${esc(bottle.location)}</strong>
      <span>${esc(bottle.name)}</span>
      <em>${esc(bottle.vintage)}</em>
    </button>`;
  }).join("");
  return `<div class="dialog pick-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
    <h2 id="dialog-title">Fjern en flaske</h2>
    <p>Vælg flasken. Den slettes og kommer ikke med i historikken.</p>
    <label class="field"><span>Find flasken</span><input id="remove-search" type="search" placeholder="Plads, vin eller producent" autocomplete="off"></label>
    <div class="pick-list" id="remove-list">${rows}</div>
    <p id="remove-empty" class="hint" hidden>Ingen flasker matcher søgningen.</p>
    <div class="dialog-actions">
      <button type="button" class="btn ghost" data-confirm="no">Annuller</button>
    </div>
  </div>`;
}

function confirmModal(config) {
  return `<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title">
    <h2 id="dialog-title">${esc(config.title)}</h2>
    <p>${esc(config.text || "")}</p>
    ${config.note ? `<label class="field"><span>Smagsnote</span><textarea id="modal-note" placeholder="Valgfri note til historikken"></textarea></label>` : ""}
    <div class="dialog-actions">
      <button type="button" class="btn ghost" data-confirm="no">Annuller</button>
      <button type="button" class="btn ${config.danger ? "danger" : "primary"}" data-confirm="yes">${esc(config.confirmLabel || "OK")}</button>
    </div>
  </div>`;
}

function restoreModal(item) {
  const empties = emptySlots();
  const preferred = empties.includes(item.fromLocation) ? item.fromLocation : (empties[0] || "");
  const options = empties.length
    ? empties.map((code) => `<option value="${esc(code)}"${code === preferred ? " selected" : ""}>${esc(code)}</option>`).join("")
    : `<option value="">Ingen ledige pladser</option>`;
  return `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
    <h2 id="dialog-title">Læg ${esc(item.name)} tilbage</h2>
    <p>Den lå på ${esc(item.fromLocation)}. Vælg en ledig plads, eller skriv en ny.</p>
    <label class="field"><span>Ledig plads</span><select id="restore-location">${options}</select></label>
    <label class="field"><span>Eller en ny plads</span><input id="restore-custom" placeholder="f.eks. E7" spellcheck="false"></label>
    <p id="modal-error" class="form-error"></p>
    <div class="dialog-actions">
      <button type="button" class="btn ghost" data-confirm="no">Annuller</button>
      <button type="button" class="btn primary" data-confirm="yes">Læg tilbage</button>
    </div>
  </div>`;
}

function renderModal() {
  const modal = document.getElementById("modal");
  if (!pendingConfirm) {
    modal.hidden = true;
    modal.innerHTML = "";
    return;
  }
  modal.hidden = false;
  modal.innerHTML = pendingConfirm.mode === "restore"
    ? restoreModal(pendingConfirm.item)
    : pendingConfirm.mode === "key"
      ? keyModal()
      : pendingConfirm.mode === "pick-remove"
        ? removeModal()
        : confirmModal(pendingConfirm);
  setTimeout(() => {
    (document.getElementById("api-key") || document.getElementById("remove-search") || document.getElementById("modal-note") || document.querySelector("#modal [data-confirm='yes']"))?.focus();
  }, 0);
}

function askConfirm(config) {
  return new Promise((resolve) => {
    pendingConfirm = { ...config, resolve };
    renderModal();
  });
}

function closeConfirm(ok) {
  const note = document.getElementById("modal-note")?.value ?? "";
  const restoreLocation = document.getElementById("restore-location")?.value ?? "";
  const restoreCustom = document.getElementById("restore-custom")?.value ?? "";
  const current = pendingConfirm;
  pendingConfirm = null;
  renderModal();
  current?.resolve?.({ ok, note, restoreLocation, restoreCustom });
}

function renderAll() {
  renderFilters();
  renderView();
  renderDrawer(true);
  renderModal();
}

async function attemptClose() {
  if (!ui.panel) return true;
  if (isDirty()) {
    const answer = await askConfirm({
      title: "Luk uden at gemme?",
      text: "Ændringerne på flasken er ikke gemt.",
      confirmLabel: "Luk uden at gemme",
      danger: true,
    });
    if (!answer.ok) return false;
  }
  ui.panel = null;
  renderDrawer(true);
  renderView();
  return true;
}

async function openBottle(id) {
  if (ui.panel?.type === "bottle" && ui.panel.id === id) return;
  if (!(await attemptClose()) && ui.panel) return;
  if (!state.bottles.some((bottle) => bottle.id === id)) return;
  ui.panel = { type: "bottle", id };
  renderDrawer(true);
  renderView();
}

async function openAdd(location) {
  if (ui.panel && !(await attemptClose())) return;
  ui.panel = { type: "add", location: location || emptySlots()[0] || "" };
  renderDrawer(true);
  renderView();
}

function setFabOpen(open) {
  const pop = document.getElementById("fab-pop");
  const button = document.getElementById("add-btn");
  pop.hidden = !open;
  button.setAttribute("aria-expanded", open ? "true" : "false");
}

async function openRemovePicker() {
  if (!state.bottles.length) {
    toast("Der er ingen flasker at fjerne");
    return;
  }
  if (ui.panel && !(await attemptClose())) return;
  askConfirm({ mode: "pick-remove" });
}

function setTab(tab) {
  ui.tab = tab;
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  renderView();
}

function setQuery(value) {
  ui.query = value;
  document.getElementById("search").value = value;
  renderView();
}

function clearFilters() {
  ui.type = "alle";
  ui.country = "alle";
  setQuery("");
  syncFilterUI();
  renderView();
}

async function onDrink(id) {
  const bottle = state.bottles.find((item) => item.id === id);
  if (!bottle) return;
  if (isDirty()) {
    const discard = await askConfirm({
      title: "Drik uden at gemme rettelser?",
      text: "De ugemte ændringer bliver ikke taget med.",
      confirmLabel: "Drik alligevel",
      danger: true,
    });
    if (!discard.ok) return;
  }
  const answer = await askConfirm({
    title: `Drik ${bottle.name}?`,
    text: `${bottle.location} bliver ledig, og flasken lægges i historikken.`,
    confirmLabel: "Drik flasken",
    danger: true,
    note: true,
  });
  if (!answer.ok) return;
  drinkBottle(bottle, answer.note);
  ui.panel = null;
  renderAll();
  toast(`${bottle.name} er drukket`);
}

async function onRemove(id) {
  const bottle = state.bottles.find((item) => item.id === id);
  if (!bottle) return;
  const answer = await askConfirm({
    title: "Fjern flasken?",
    text: `${bottle.name} slettes fra ${bottle.location} og kommer ikke med i historikken.`,
    confirmLabel: "Fjern",
    danger: true,
  });
  if (!answer.ok) return;
  WineLookup.deletePhoto(id).catch(() => {});
  state.bottles = state.bottles.filter((item) => item.id !== id);
  persist();
  ui.panel = null;
  renderAll();
  toast(`${bottle.name} er fjernet`);
}

async function onRestore(id) {
  const item = state.history.find((entry) => entry.id === id);
  if (!item) return;
  const answer = await askConfirm({ mode: "restore", item });
  if (!answer.ok) return;
  const error = restoreBottle(item, answer.restoreCustom.trim() || answer.restoreLocation);
  if (error) {
    toast(error);
    return;
  }
  renderAll();
  toast(`${item.name} er lagt tilbage`);
}

function downloadBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  link.href = URL.createObjectURL(blob);
  link.download = `vinkoleskab-${stamp}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast("Backup hentet");
}

function keyModal() {
  return `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
    <h2 id="dialog-title">Vinkilde</h2>
    <p>Et billede af etiketten slås op hos WineAPI. Opslaget kan udfylde navn, producent, område, årgang og type, og det viser priser, hvor de findes. Opret en gratis personlig nøgle og indsæt den her. Den bliver i denne browser.</p>
    <label class="field"><span>API-nøgle</span><input id="api-key" type="password" autocomplete="off" value="${esc(WineLookup.apiKey())}"></label>
    <p class="hint"><a href="https://wineapi.io/login" target="_blank" rel="noopener">Opret eller hent nøglen hos WineAPI</a>. Gratis privat brug dækker 100 opslag om dagen. Ikke alle vine har en pris.</p>
    <div class="dialog-actions">
      <button type="button" class="btn ghost" data-confirm="no">Luk</button>
      <button type="button" class="btn primary" id="save-key">Gem nøgle</button>
    </div>
  </div>`;
}

function setLookupStatus(message) {
  const status = document.getElementById("lookup-status");
  if (status) status.textContent = message;
}

function moneyNumber(value) {
  const text = String(value ?? "").trim();
  if (!text) return NaN;
  if (text.includes(",") && text.includes(".")) return Number(text.replace(/\./g, "").replace(",", "."));
  if (text.includes(",")) return Number(text.replace(",", "."));
  return Number(text);
}

function isKrone(currency) {
  return /^(dkk|kr\.?)$/i.test(String(currency || "").trim());
}

function candidateHtml(wine, index) {
  const profile = WineLookup.compactProfile(wine);
  const title = `${wine.name || "Ukendt vin"}${wine.vintage ? ` ${wine.vintage}` : ""}`;
  const meta = [WineLookup.producerName(wine), WineLookup.regionLine(wine)].filter(Boolean).join(" · ");
  const grapes = profile?.grapes?.join(", ") || "";
  const score = profile?.rating == null ? "" : `Score ${profile.rating}${profile.ratingsCount ? ` (${profile.ratingsCount})` : ""}`;
  const prices = (profile?.prices || []).map((price) => `<li>${esc(price.price)} ${esc(price.currency)}${price.merchant ? ` · ${esc(price.merchant)}` : ""}</li>`).join("");
  return `<article class="hit">
    <h3>${esc(title)}</h3>
    ${profile?.imageUrl ? `<img class="hit-img" src="${esc(profile.imageUrl)}" alt="Etiket fra opslaget" loading="lazy" referrerpolicy="no-referrer">` : ""}
    ${meta ? `<p>${esc(meta)}</p>` : ""}
    ${grapes ? `<p>${esc(grapes)}</p>` : ""}
    ${score ? `<p>${esc(score)}</p>` : ""}
    ${prices ? `<ul class="prices">${prices}</ul>` : "<p>Ingen pris i dette opslag.</p>"}
    <div class="hit-actions"><button type="button" class="btn primary" data-action="use-candidate" data-index="${index}">Brug denne</button></div>
  </article>`;
}

function fillFromWine(wine) {
  const form = document.getElementById("bottle-form");
  if (!form) return;
  const profile = WineLookup.compactProfile(wine);
  if (wine.name) form.name.value = wine.name;
  const producer = WineLookup.producerName(wine);
  if (producer) form.producer.value = producer;
  const region = WineLookup.regionLine(wine);
  if (region) form.region.value = region;
  if (wine.vintage) form.vintage.value = String(wine.vintage);
  const type = WineLookup.mapType(wine);
  if (type) form.type.value = type;
  if (form.sourceId) form.sourceId.value = wine.id || "";
  if (form.profileJson) form.profileJson.value = profile ? JSON.stringify(profile) : "";
  const kroner = (profile?.prices || []).map((price) => ({ ...price, amount: moneyNumber(price.price) })).find((price) => isKrone(price.currency) && Number.isFinite(price.amount));
  if (kroner) form.price.value = priceToInput(kroner.amount);
  const results = document.getElementById("lookup-results");
  if (results) results.innerHTML = profileHtml(profile);
  if (kroner) setLookupStatus("Oplysningerne er sat ind, inklusive en pris i kroner. Gem flasken for at beholde dem.");
  else if (profile?.prices?.length) setLookupStatus("Oplysningerne er sat ind. Markedspriserne er ikke i kroner, så købsprisen er uændret.");
  else setLookupStatus("Oplysningerne er sat ind. Der var ingen pris at hente. Gem flasken for at beholde dem.");
}

async function useCandidate(index) {
  const current = lookupCandidates[index];
  if (!current) return;
  setLookupStatus("Henter detaljer og priser…");
  try {
    const wine = current.id ? await WineLookup.enrich(current) : current;
    lookupCandidates[index] = wine;
    fillFromWine(wine);
  } catch (error) {
    setLookupStatus(WineLookup.explain(error));
  }
}

async function runLookup(mode) {
  const form = document.getElementById("bottle-form");
  if (!form) return;
  if (!WineLookup.apiKey()) {
    setLookupStatus(WineLookup.explain({ code: "no-key" }));
    return;
  }
  const query = [form.name?.value, form.producer?.value, form.vintage?.value].map((part) => String(part || "").trim()).filter(Boolean).join(" ");
  const usePhoto = mode === "photo" || (!query && pendingUpload);
  if (usePhoto && !pendingUpload) {
    setLookupStatus("Tag eller vælg et billede af etiketten først.");
    return;
  }
  if (!usePhoto && query.length < 2) {
    setLookupStatus("Skriv vinens navn, eller tag et billede af etiketten.");
    return;
  }
  setLookupStatus(usePhoto ? "Læser etiketten…" : "Slår vinen op…");
  const results = document.getElementById("lookup-results");
  if (results) results.innerHTML = "";
  try {
    lookupCandidates = await WineLookup.lookup(usePhoto ? { image: pendingUpload, query } : { query });
    if (!lookupCandidates.length) {
      setLookupStatus("Ingen vin matchede. Prøv et tydeligere billede, eller ret navnet og søg igen.");
      return;
    }
    if (results) results.innerHTML = lookupCandidates.map(candidateHtml).join("");
    setLookupStatus(lookupCandidates.length === 1 ? "Ét muligt match. Kontroller det, før du gemmer." : `${lookupCandidates.length} mulige match. Vælg den rigtige.`);
  } catch (error) {
    setLookupStatus(WineLookup.explain(error));
  }
}

async function keepPhoto(id) {
  try {
    if (pendingPhoto) await WineLookup.savePhoto(id, pendingPhoto);
    else if (photoRemoved) await WineLookup.deletePhoto(id);
  } catch {
    /* Billedet er et supplement til flasken. */
  }
  await refreshPhotos();
}

async function fetchLabels() {
  if (!WineLookup.apiKey()) {
    pendingConfirm = { mode: "key" };
    renderModal();
    toast("Indsæt først din WineAPI-nøgle");
    return;
  }
  const groups = new Map();
  for (const bottle of state.bottles) {
    const key = bottleKey(bottle);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bottle);
  }
  const todo = [...groups.values()].filter((list) => !labelImage(list[0]));
  if (!todo.length) {
    toast("Alle vine har allerede en etiket");
    return;
  }
  const answer = await askConfirm({
    title: "Hent etiketbilleder?",
    text: `${todo.length} vine uden etiket slås op hos WineAPI. Det bruger op til ${todo.length * 2} af dagens 100 opslag. Dine egne fotos bliver ikke rørt.`,
    confirmLabel: "Hent",
  });
  if (!answer.ok) return;
  let found = 0;
  let missed = 0;
  let stopped = "";
  for (const [index, list] of todo.entries()) {
    toast(`Henter etiketter ${index + 1} af ${todo.length}…`);
    try {
      const url = await WineLookup.labelImageFor(list[0]);
      if (url) {
        for (const bottle of list) bottle.imageUrl = url;
        found += 1;
      } else missed += 1;
    } catch (error) {
      if (["limit", "unauthorized", "no-key", "network"].includes(error?.code)) {
        stopped = WineLookup.explain(error);
        break;
      }
      missed += 1;
    }
  }
  persist();
  renderView();
  toast(stopped || `Fandt ${found} etiketter${missed ? `, ${missed} uden billede` : ""}`);
}

function bind() {
  document.querySelector(".nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (button) setTab(button.dataset.tab);
  });

  document.getElementById("search").addEventListener("input", (event) => {
    ui.query = event.target.value;
    renderView();
  });

  document.getElementById("clear-search").addEventListener("click", () => setQuery(""));

  document.getElementById("filters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-type]");
    if (!button) return;
    ui.type = button.dataset.type;
    syncFilterUI();
    renderView();
  });

  document.getElementById("filters").addEventListener("change", (event) => {
    if (event.target.id !== "country") return;
    ui.country = event.target.value;
    renderView();
  });

  document.getElementById("resultline").addEventListener("click", (event) => {
    if (event.target.closest("[data-action='clear-filters']")) clearFilters();
  });

  document.getElementById("add-btn").addEventListener("click", () => {
    const open = document.getElementById("add-btn").getAttribute("aria-expanded") === "true";
    setFabOpen(!open);
  });

  document.getElementById("fab-pop").addEventListener("click", (event) => {
    const action = event.target.closest("[data-fab]");
    if (!action) return;
    setFabOpen(false);
    if (action.dataset.fab === "add") openAdd();
    if (action.dataset.fab === "remove") openRemovePicker();
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest("#fab")) setFabOpen(false);
  });

  document.getElementById("view").addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (action) {
      const name = action.dataset.action;
      if (name === "open") openBottle(action.dataset.id);
      if (name === "add") openAdd(action.dataset.location);
      if (name === "filter-country") {
        ui.country = ui.country === action.dataset.country ? "alle" : action.dataset.country;
        syncFilterUI();
        renderView();
      }
      if (name === "filter-type") {
        ui.type = ui.type === action.dataset.type ? "alle" : action.dataset.type;
        syncFilterUI();
        renderView();
      }
      if (name === "search") setQuery(action.dataset.q);
      if (name === "restore") onRestore(action.dataset.id);
      if (name === "tab") {
        setTab(action.dataset.tabTarget);
        window.scrollTo(0, 0);
      }
      return;
    }
    const card = event.target.closest("[data-open]");
    if (card) openBottle(card.dataset.id);
  });

  document.getElementById("view").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest("[data-open]");
    if (!card || event.target !== card) return;
    event.preventDefault();
    openBottle(card.dataset.id);
  });

  document.getElementById("view").addEventListener("change", (event) => {
    if (event.target.id !== "sort") return;
    ui.sort = event.target.value;
    renderView();
  });

  const drawer = document.getElementById("drawer");
  drawer.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "close") attemptClose();
    if (action.dataset.action === "open") openBottle(action.dataset.id);
    if (action.dataset.action === "drink" && ui.panel?.type === "bottle") onDrink(ui.panel.id);
    if (action.dataset.action === "remove" && ui.panel?.type === "bottle") onRemove(ui.panel.id);
    if (action.dataset.action === "lookup-photo") runLookup("photo");
    if (action.dataset.action === "lookup-text") runLookup("text");
    if (action.dataset.action === "use-candidate") useCandidate(Number(action.dataset.index));
    if (action.dataset.action === "clear-photo") {
      pendingPhoto = null;
      pendingUpload = null;
      photoRemoved = true;
      showPreview(null);
      setLookupStatus("Billedet fjernes, når du gemmer.");
    }
  });

  drawer.addEventListener("change", async (event) => {
    if (event.target.id === "label-camera" || event.target.id === "label-file") {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      try {
        pendingPhoto = await WineLookup.compress(file, 640, 0.72);
        pendingUpload = await WineLookup.compress(file, 1600, 0.82);
        photoRemoved = false;
        showPreview(pendingPhoto);
        setLookupStatus("Billedet er klar. Hent oplysningerne, eller gem det sammen med flasken.");
      } catch {
        setLookupStatus("Billedet kunne ikke læses. Prøv et andet.");
      }
      return;
    }
    if (event.target.name !== "copyFrom") return;
    const bottle = state.bottles.find((item) => item.id === event.target.value);
    if (!bottle) return;
    const form = event.target.form;
    form.name.value = bottle.name;
    form.producer.value = bottle.producer;
    form.region.value = bottle.region;
    form.vintage.value = bottle.vintage;
    form.type.value = bottle.type;
    form.price.value = priceToInput(bottle.price);
  });

  drawer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = readForm(event.target);
    if (ui.panel?.type === "add") {
      const before = state.bottles.length;
      const error = addBottle(data);
      if (error) {
        showFormError(error);
        return;
      }
      if (state.bottles.length !== before) {
        await keepPhoto(state.bottles[state.bottles.length - 1].id);
        renderAll();
        toast(`${data.name.trim()} er lagt på ${normalizeLocation(data.location)}`);
      }
      return;
    }
    if (ui.panel?.type === "bottle") {
      const error = saveBottle(ui.panel.id, data);
      if (error) {
        showFormError(error);
        return;
      }
      await keepPhoto(ui.panel.id);
      renderAll();
      toast("Flasken er gemt");
    }
  });

  document.getElementById("backdrop").addEventListener("click", () => {
    if (!pendingConfirm) attemptClose();
  });

  document.getElementById("modal").addEventListener("input", (event) => {
    if (event.target.id !== "remove-search") return;
    const query = fold(event.target.value.trim());
    let visible = 0;
    for (const row of document.querySelectorAll("#remove-list [data-remove-id]")) {
      const match = !query || row.dataset.search.includes(query);
      row.hidden = !match;
      if (match) visible += 1;
    }
    const empty = document.getElementById("remove-empty");
    if (empty) empty.hidden = visible > 0;
  });

  document.getElementById("modal").addEventListener("click", (event) => {
    const pick = event.target.closest("[data-remove-id]");
    if (pick && pendingConfirm?.mode === "pick-remove") {
      const id = pick.dataset.removeId;
      closeConfirm(false);
      onRemove(id);
      return;
    }
    if (event.target.id === "modal") {
      closeConfirm(false);
      return;
    }
    if (event.target.id === "save-key") {
      WineLookup.setApiKey(document.getElementById("api-key").value);
      const saved = Boolean(WineLookup.apiKey());
      closeConfirm(false);
      toast(saved ? "Vinkilden er gemt" : "Vinkilden er fjernet");
      return;
    }
    const button = event.target.closest("[data-confirm]");
    if (!button) return;
    if (button.dataset.confirm === "yes" && pendingConfirm?.mode === "restore") {
      const custom = document.getElementById("restore-custom").value;
      const selected = document.getElementById("restore-location").value;
      const chosen = normalizeLocation(custom.trim() || selected);
      const error = document.getElementById("modal-error");
      if (!chosen) {
        error.textContent = "Skriv pladsen som bogstav og tal, f.eks. I6.";
        return;
      }
      if (state.bottles.some((bottle) => bottle.location === chosen)) {
        error.textContent = `${chosen} er optaget.`;
        return;
      }
    }
    closeConfirm(button.dataset.confirm === "yes");
  });

  document.getElementById("key-btn").addEventListener("click", () => {
    pendingConfirm = { mode: "key" };
    renderModal();
  });
  document.getElementById("prices-btn").addEventListener("click", () => {
    refreshMissingPrices();
  });
  document.getElementById("labels-btn").addEventListener("click", fetchLabels);
  document.addEventListener("error", (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.closest(".thumb, .wine-art, .feature-art")) {
      img.remove();
      return;
    }
    const logo = img.closest(".rank-logo");
    if (!logo) return;
    logo.classList.remove("is-pending");
    logo.classList.add("is-empty");
    logo.textContent = producerInitials(logo.dataset.producer || "");
  }, true);
  document.getElementById("export-btn").addEventListener("click", downloadBackup);
  document.getElementById("import-btn").addEventListener("click", () => document.getElementById("import-file").click());
  document.getElementById("import-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const next = normalizeState(JSON.parse(await file.text()));
      const answer = await askConfirm({
        title: "Importer backup?",
        text: `Filen har ${flasker(next.bottles.length)} og ${next.history.length} i historikken. Den erstatter kælderen i denne browser.`,
        confirmLabel: "Importer",
      });
      if (!answer.ok) return;
      state = next;
      ui.panel = null;
      const filled = applyMarketPrices();
      if (!filled) persist();
      renderAll();
      toast("Backup importeret");
      marketToast(filled);
    } catch {
      toast("Filen kunne ikke læses som en backup");
    }
  });

  document.getElementById("reset-btn").addEventListener("click", async () => {
    const answer = await askConfirm({
      title: "Nulstil kælderen?",
      text: "Rettelser, priser, noter og historik på denne computer slettes. Regnearkets oversigt lægges ind igen.",
      confirmLabel: "Nulstil",
      danger: true,
    });
    if (!answer.ok) return;
    state = freshState();
    ui.panel = null;
    WineLookup.clearPhotos().catch(() => {});
    for (const url of photoUrls.values()) URL.revokeObjectURL(url);
    photoUrls = new Map();
    const filled = applyMarketPrices();
    if (!filled) persist();
    renderAll();
    toast("Kælderen er nulstillet til oversigten");
    marketToast(filled);
  });

  document.querySelector(".menu").addEventListener("click", (event) => {
    if (event.target.closest("button")) event.currentTarget.removeAttribute("open");
  });

  document.addEventListener("keydown", (event) => {
    const typing = event.target && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName);
    if (event.key === "/" && !typing) {
      event.preventDefault();
      document.getElementById("search").focus();
    }
    if (event.key === "Escape") {
      if (pendingConfirm) closeConfirm(false);
      else if (document.getElementById("add-btn").getAttribute("aria-expanded") === "true") setFabOpen(false);
      else if (ui.panel) attemptClose();
    }
  });

  window.addEventListener("hashchange", () => {
    const tab = location.hash.replace("#", "");
    if (["oversigt", "katalog", "historik"].includes(tab) && tab !== ui.tab) {
      ui.tab = tab;
      renderView();
    }
  });
}

function init() {
  state = loadState();
  const filled = applyMarketPrices();
  const hash = location.hash.replace("#", "");
  ui.tab = ["oversigt", "katalog", "historik"].includes(hash) ? hash : "oversigt";
  if (!location.hash) history.replaceState(null, "", "#oversigt");
  const saved = document.getElementById("saved");
  saved.textContent = cameFromStorage ? "Gemt i browseren" : "Indlæst fra oversigten";
  bind();
  renderAll();
  marketToast(filled);
  refreshPhotos().then(() => {
    if (photoUrls.size) renderView();
  });
}

init();
