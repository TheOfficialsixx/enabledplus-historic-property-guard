// ==UserScript==
// @name         Enabled+ Historic Property Guard
// @namespace    sixx.enabledplus.tools
// @version      1.4.0
// @description  Detects historic-property flags and checks supported official public records.
// @author       Sixx
// @updateURL    https://raw.githubusercontent.com/TheOfficialsixx/enabledplus-historic-property-guard/main/enabledplus-historic-guard.user.js
// @downloadURL  https://raw.githubusercontent.com/TheOfficialsixx/enabledplus-historic-property-guard/main/enabledplus-historic-guard.user.js
// @match        https://www.enabledplus.com/Lead*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const PANEL_ID = "ep-historic-guard";
  const STYLE_ID = "ep-historic-guard-style";
  const NYC_DATASET = "gpmc-yuvp";
  const NYC_MAP = "https://experience.arcgis.com/experience/fa1bcaad31374a88839da3f0166e640a/page/Page";
  const SF_PIM = "https://sfplanninggis.org/pim/";
  const PANEL_STATE_KEY = "ep-historic-guard-window-v1";
  let scanTimer = 0;
  let dismissed = false;
  let lastKey = "";
  let activeLeadId = "";
  let backgroundScanTimer = 0;

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function textFrom(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const value = clean("value" in node ? node.value : node.textContent);
      if (value) return value;
    }
    return "";
  }

  function valuesFrom(selector) {
    return [...document.querySelectorAll(selector)]
      .map((node) => clean("value" in node ? node.value : node.textContent))
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index);
  }

  function stripLabel(value, labels) {
    const pattern = new RegExp(`^(?:${labels.join("|")})\\s*:?\\s*`, "i");
    return clean(value).replace(pattern, "");
  }

  function readLead() {
    const street = stripLabel(textFrom([
      "#leadinformation .lead-attribute.address",
      ".lead-attribute.address",
      "[class*='lead'] [class*='address']",
    ]), ["address", "property address"]);

    const cityStateZip = stripLabel(textFrom([
      "#leadinformation .lead-attribute.city-state-zip",
      ".lead-attribute.city-state-zip",
      "[class*='city-state-zip']",
      "input[name='City']", "input[name='State']", "input[name='Zip']",
      "input[name='ZipCode']", "input[name='PostalCode']",
    ]), ["city/state/zip", "city state zip"]);

    const locationFields = [
      ...valuesFrom("input[name='Address']"),
      ...valuesFrom("input[name='City']"),
      ...valuesFrom("input[name='State']"),
      ...valuesFrom("input[name='Zip']"),
      ...valuesFrom("input[name='ZipCode']"),
      ...valuesFrom("input[name='PostalCode']"),
      ...valuesFrom("select[name='State']"),
      clean(document.querySelector("#leadinformation")?.textContent),
    ].filter(Boolean).join(" ");

    const yellowCandidates = [
      "textarea[name='Notes']",
      "#yellowbox", "#yellowBox", "#YellowBox",
      "[id*='yellow'][id*='box']", "[class*='yellow'][class*='box']",
      "textarea[name*='yellow' i]", "textarea[id*='yellow' i]",
    ];
    let yellowBox = valuesFrom("textarea[name='Notes']").join("\n") || textFrom(yellowCandidates);
    if (!yellowBox) {
      const labeled = [...document.querySelectorAll("textarea, input")].find((node) =>
        /yellow\s*box/i.test(clean(node.closest("div,td,tr,section")?.textContent))
      );
      yellowBox = clean(labeled?.value);
    }

    const relevantPageText = clean([
      yellowBox,
      document.querySelector("#leadinformation")?.textContent,
      ...[...document.querySelectorAll(".lead-attribute, .appointment-info, .project-info")]
        .map((node) => node.textContent),
    ].join(" "));

    const exactAgeValues = valuesFrom("input[name='WindowsAge']")
      .map((value) => Number(value.match(/\d{1,3}/)?.[0]))
      .filter((age) => age > 0 && age < 300);
    const ages = [
      ...exactAgeValues,
      ...[...relevantPageText.matchAll(/\b(\d{1,3})\s*(?:y\/?o|yo|years?\s*old|yrs?\s*old)\b/gi)]
      .map((match) => Number(match[1]))
      .filter((age) => age > 0 && age < 300),
    ];
    const age = ages.length ? Math.max(...ages) : null;
    const zipChanged = /(?:zip|postal)(?:\s+code)?[^.\n]{0,35}(?:changed|capacity|routing|do\s+not\s+change)|do\s+not\s+change[^.\n]{0,25}(?:zip|postal)/i.test(yellowBox);
    const historicWords = /\b(?:historic|historical|landmark|historic\s+district|class\s*a|heritage\s+home)\b/i.test(relevantPageText);

    return {street, cityStateZip, locationFields, yellowBox, relevantPageText, age, zipChanged, historicWords};
  }

  function locationType(lead) {
    // Yellow Box may preserve the property's real/original ZIP when the visible
    // routing ZIP was changed for store capacity. Read it, but never edit it.
    // Enabled+ uses multiple lead layouts. Some render the property location as
    // plain text outside #leadinformation, so use visible page text as a final
    // read-only fallback. This does not collect or transmit the text.
    const visiblePageLocation = clean(document.body?.innerText);
    const location = `${lead.street} ${lead.cityStateZip} ${lead.locationFields || ""} ${lead.yellowBox || ""} ${visiblePageLocation}`.toLowerCase();
    if (/\bsan\s+francisco\b|\bca\s+941\d{2}\b/.test(location)) return "sf";
    if (/\b(?:new\s+york|bronx|brooklyn|queens|manhattan|staten\s+island)\b|\bny\s+(?:10[0-4]|11[0-4]|116)\d{2}\b|\b(?:10[0-4]|11[0-4]|116)\d{2}\b/.test(location)) return "nyc";
    return "other";
  }

  function normalizeAddress(value) {
    return clean(value).toLowerCase()
      .replace(/\b(street|avenue|road|boulevard|drive|lane|place|court|parkway)\b/g, (word) => ({
        street: "st", avenue: "ave", road: "rd", boulevard: "blvd", drive: "dr",
        lane: "ln", place: "pl", court: "ct", parkway: "pkwy",
      })[word])
      .replace(/[^a-z0-9]+/g, " ").trim();
  }

  function officialUrl(type, lead) {
    if (type === "sf") return `${SF_PIM}?search=${encodeURIComponent(lead.street)}&tab=${encodeURIComponent("Historic Preservation")}`;
    if (type === "nyc") return NYC_MAP;
    return "";
  }

  function classifyInitial(lead, type) {
    const triggered = lead.historicWords || (lead.age !== null && lead.age >= 80) || type === "sf" || type === "nyc";
    if (!triggered) return {level: "clear", title: "NO HISTORIC FLAGS DETECTED", message: "No 80+ age, historic wording, or required check location was detected."};
    if (!lead.street && !lead.cityStateZip && !lead.locationFields) return {level: "unknown", title: "ADDRESS NOT DETECTED", message: "Open the lead details or use the manual check button."};
    if (type === "sf") return {level: "review", title: "SAN FRANCISCO CLASS CHECK", message: "Official SF PIM report prepared. Confirm the Historic Preservation class manually."};
    if (type === "nyc") return {level: "review", title: "NYC HISTORIC CHECK", message: "Open the official NYC report and verify the street address before clearing the lead."};
    return {level: "review", title: "HISTORIC REVIEW REQUIRED", message: "An age or historic-property flag was detected, but this location has no configured background database."};
  }

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID}{position:fixed;left:14px;top:82px;z-index:999996;display:flex;flex-direction:column;width:min(285px,calc(100vw - 20px));min-width:220px;min-height:125px;max-width:calc(100vw - 8px);max-height:calc(100vh - 8px);border:1px solid #50546b;border-radius:11px;background:#282a36;color:#f8f8f2;box-shadow:0 12px 30px rgba(0,0,0,.34);font:12px/1.4 "Segoe UI",Arial,sans-serif;overflow:hidden;resize:both}
      #${PANEL_ID}[data-level=clear]{border-color:#50fa7b}#${PANEL_ID}[data-level=review]{border-color:#ffb86c}#${PANEL_ID}[data-level=match]{border-color:#ff5555}#${PANEL_ID}[data-level=checking]{border-color:#8be9fd}#${PANEL_ID}[data-level=unknown]{border-color:#bd93f9}
      #${PANEL_ID} .eh-head{display:flex;flex:0 0 auto;gap:9px;padding:10px 11px 9px;background:#21222c;cursor:move;user-select:none;touch-action:none}#${PANEL_ID} .eh-dot{width:11px;height:11px;margin-top:3px;border-radius:50%;background:#6272a4;box-shadow:0 0 0 4px rgba(98,114,164,.16);flex:none}#${PANEL_ID}[data-level=clear] .eh-dot{background:#50fa7b}#${PANEL_ID}[data-level=review] .eh-dot{background:#ffb86c}#${PANEL_ID}[data-level=match] .eh-dot{background:#ff5555}#${PANEL_ID}[data-level=checking] .eh-dot{background:#8be9fd;animation:ehpulse 1s infinite}#${PANEL_ID}[data-level=unknown] .eh-dot{background:#bd93f9}
      #${PANEL_ID} strong{display:block;font-size:13px;letter-spacing:.015em}#${PANEL_ID} p{margin:3px 0 0;color:#c7c9d3}#${PANEL_ID} .eh-body{flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-color:#6272a4 #21222c;scrollbar-width:thin}#${PANEL_ID} .eh-body::-webkit-scrollbar{width:9px}#${PANEL_ID} .eh-body::-webkit-scrollbar-track{background:#21222c}#${PANEL_ID} .eh-body::-webkit-scrollbar-thumb{background:#6272a4;border:2px solid #21222c;border-radius:8px}#${PANEL_ID} .eh-meta{margin:8px 10px;color:#c7c9d3;font-size:11px}#${PANEL_ID} .eh-label{font-weight:700;color:#f8f8f2;margin-top:5px}#${PANEL_ID} .eh-address{margin-top:3px;padding:6px 7px;border:1px solid #55596e;border-radius:6px;background:#30323f;word-break:break-word}#${PANEL_ID} .eh-zip{padding:6px 7px;border:1px solid #bd93f9;border-radius:6px;background:#3a304d;color:#f8f8f2;font-weight:700;margin-top:6px}#${PANEL_ID} .eh-actions{display:flex;flex:0 0 auto;flex-wrap:wrap;gap:5px;justify-content:flex-end;padding:7px 9px;border-top:1px solid #44475a;background:#242630}#${PANEL_ID} button,#${PANEL_ID} a{border:1px solid #62667e;border-radius:7px;padding:5px 7px;background:#343746;color:#f8f8f2;font:600 11px "Segoe UI",Arial,sans-serif;text-decoration:none;cursor:pointer}#${PANEL_ID} button:hover,#${PANEL_ID} a:hover{background:#44475a}#${PANEL_ID} .eh-ok{background:#6272a4;color:#fff;border-color:#7b88b6}@keyframes ehpulse{50%{opacity:.3}}
    `;
    document.head.appendChild(style);
  }

  function render(lead, type, result) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("aside");
      panel.id = PANEL_ID;
      panel.setAttribute("aria-live", "polite");
      document.body.appendChild(panel);
      restorePanelState(panel);
      enableResizePersistence(panel);
    }
    panel.style.display = dismissed ? "none" : "flex";
    panel.dataset.level = result.level;
    const url = officialUrl(type, lead);
    const nycAddress = clean([lead.street, lead.cityStateZip].filter(Boolean).join(", "));
    const facts = [lead.age !== null ? `Age detected: ${lead.age}` : "Age not detected", type === "sf" ? "San Francisco" : type === "nyc" ? "NYC/borough check" : "Other location"];
    panel.innerHTML = `
      <div class="eh-head"><span class="eh-dot"></span><div><strong>${escapeHtml(result.title)}</strong><p>${escapeHtml(result.message)}</p></div></div>
      <div class="eh-body"><div class="eh-meta">${escapeHtml(facts.join(" · "))}${lead.zipChanged ? `<div class="eh-zip">Routing ZIP changed. Do not modify it; checking uses street/city/state.</div>` : ""}</div></div>
      <div class="eh-actions">${type === "nyc" && url && nycAddress ? `<button id="eh-nyc-open">Copy address + open</button>` : url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">Official report</a>` : ""}<button id="eh-refresh">Recheck</button><button class="eh-ok" id="eh-ok">Okay</button></div>`;
    panel.querySelector("#eh-ok").onclick = () => { dismissed = true; panel.style.display = "none"; };
    panel.querySelector("#eh-refresh").onclick = () => { lastKey = ""; scan(true); };
    const nycButton = panel.querySelector("#eh-nyc-open");
    if (nycButton) nycButton.onclick = () => {
      copyText(nycAddress);
      nycButton.textContent = "Address copied";
      window.open(url, "_blank", "noopener");
    };
    makeDraggable(panel, panel.querySelector(".eh-head"));
  }

  function copyText(value) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).catch(() => legacyCopy(value));
    } else {
      legacyCopy(value);
    }
  }

  function legacyCopy(value) {
    const area = document.createElement("textarea");
    area.value = value;
    area.style.cssText = "position:fixed;left:-9999px;top:-9999px";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }

  function removePanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  function makeDraggable(panel, handle) {
    handle.onpointerdown = (event) => {
      if (event.button !== 0) return;
      const rect = panel.getBoundingClientRect(), dx = event.clientX - rect.left, dy = event.clientY - rect.top;
      handle.setPointerCapture(event.pointerId);
      handle.onpointermove = (move) => {
        panel.style.left = `${Math.max(0, Math.min(innerWidth - panel.offsetWidth, move.clientX - dx))}px`;
        panel.style.top = `${Math.max(0, Math.min(innerHeight - panel.offsetHeight, move.clientY - dy))}px`;
      };
      handle.onpointerup = handle.onpointercancel = () => {
        handle.onpointermove = null;
        keepPanelOnScreen(panel);
        savePanelState(panel);
      };
    };
  }

  function restorePanelState(panel) {
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_STATE_KEY) || "null");
      if (!saved) return;
      if (Number.isFinite(saved.left)) panel.style.left = `${saved.left}px`;
      if (Number.isFinite(saved.top)) panel.style.top = `${saved.top}px`;
      if (Number.isFinite(saved.width)) panel.style.width = `${saved.width}px`;
      if (Number.isFinite(saved.height)) panel.style.height = `${saved.height}px`;
      keepPanelOnScreen(panel);
    } catch (_) {}
  }

  function savePanelState(panel) {
    if (!panel || panel.style.display === "none") return;
    const rect = panel.getBoundingClientRect();
    try {
      localStorage.setItem(PANEL_STATE_KEY, JSON.stringify({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }));
    } catch (_) {}
  }

  function keepPanelOnScreen(panel) {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const width = Math.min(rect.width, Math.max(220, innerWidth - 8));
    const height = Math.min(rect.height, Math.max(125, innerHeight - 8));
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    panel.style.left = `${Math.max(4, Math.min(innerWidth - width - 4, rect.left))}px`;
    panel.style.top = `${Math.max(4, Math.min(innerHeight - height - 4, rect.top))}px`;
  }

  function enableResizePersistence(panel) {
    if (!window.ResizeObserver || panel.dataset.resizeReady === "true") return;
    panel.dataset.resizeReady = "true";
    let timer = 0;
    new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => savePanelState(panel), 180);
    }).observe(panel);
  }

  function escapeHtml(value) {
    return clean(value).replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
  }

  async function scan(force = false) {
    try {
      const leadId = new URLSearchParams(location.search).get("L") || `${location.pathname}${location.search}`;
      if (leadId !== activeLeadId) {
        activeLeadId = leadId;
        dismissed = false;
      }
      const lead = readLead();
      const type = locationType(lead);
      const key = `${location.search}|${lead.street}|${lead.cityStateZip}|${type}|${lead.age}|${lead.zipChanged}|${lead.historicWords}`;
      if (!force && key === lastKey) return;
      lastKey = key;
      const initial = classifyInitial(lead, type);
      if (initial.level === "clear") {
        removePanel();
        return;
      }
      render(lead, type, initial);
    } catch (error) {
      console.error("Historic Property Guard scan failed", error);
      render({street:"",cityStateZip:"",locationFields:"",age:null,zipChanged:false}, "other", {
        level:"unknown",
        title:"HISTORIC CHECK NEEDS ATTENTION",
        message:`The lead page could not be read: ${error?.message || "unknown page-layout error"}`,
      });
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scan, 350);
  }

  function start() {
    if (!document.body || document.getElementById(PANEL_ID)) return;
    document.documentElement.dataset.historicGuardLoaded = "1.4.0";
    console.info("[Historic Guard] v1.4.0 injected at", location.href);
    addStyles();
    scan(true);
    new MutationObserver(scheduleScan).observe(document.documentElement, {childList:true, subtree:true});
    // Enabled+ sometimes fills lead fields without adding DOM nodes, so the
    // MutationObserver never sees it. A quiet periodic scan catches those late
    // value changes while still rendering nothing on ordinary leads.
    clearInterval(backgroundScanTimer);
    backgroundScanTimer = window.setInterval(() => scan(false), 1000);
    window.addEventListener("hashchange", scheduleScan);
    window.addEventListener("popstate", scheduleScan);
    window.addEventListener("resize", () => {
      const panel = document.getElementById(PANEL_ID);
      if (!panel) return;
      keepPanelOnScreen(panel);
      savePanelState(panel);
    });
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, {once:true});
})();
