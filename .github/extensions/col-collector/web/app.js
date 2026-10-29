import { completedPassIds, filterPasses, GROUP_LABELS } from "./model.mjs";

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const number = (value) => value == null ? "Unknown" : new Intl.NumberFormat("en").format(value);
const shortName = (pass) => pass.name.split(/[/(]/)[0].trim();
const photoUrl = (id) => `api/photo/${encodeURIComponent(id)}?revision=${state.revision}`;
let catalogue, state, selectedId = null, view = "collection", map, markers, locationMarker;
let draft = false, saving = false, searchSequence = 0, updateNoticeShown = false;
let noticeTimer;

async function api(path, body) {
  const response = await fetch(`api/${path}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error("The local app returned an unreadable response. Reopen the canvas and try again."); }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}
function showError(error) {
  $("#error-text").textContent = error.message || String(error);
  $("#error").hidden = false;
}
function notice(message) {
  clearTimeout(noticeTimer);
  $("#notice").textContent = message;
  $("#notice").hidden = false;
  noticeTimer = setTimeout(() => { $("#notice").hidden = true; }, 7000);
}
function run(action) {
  return async (event) => {
    try { await action(event); } catch (error) { showError(error); }
  };
}
function doneIds() { return completedPassIds(state.approaches, state.ascents); }
function filters() { return { group: $("#group-filter").value, status: $("#status-filter").value, query: $("#pass-search").value }; }
function matching() { return filterPasses(catalogue.passes, doneIds(), filters()); }
function passAscents(passId) {
  const ids = new Set(state.approaches.filter((a) => a.passId === passId).map((a) => a.id));
  return state.ascents.filter((a) => ids.has(a.approachId));
}
function imageFor(pass) {
  const ascent = passAscents(pass.id).find((a) => a.hasPhoto);
  return ascent ? photoUrl(ascent.id) : "mountain.svg";
}

function renderCards() {
  const completed = doneIds();
  const allMatching = matching();
  const passes = view === "map" && map ? allMatching.filter((p) => map.getBounds().contains([p.latitude, p.longitude])) : allMatching;
  $("#progress-label").textContent = `${completed.size} / ${catalogue.passes.length} collected`;
  $("#progress").max = catalogue.passes.length;
  $("#progress").value = completed.size;
  $("#list-title").textContent = view === "map" ? "Passes in this map area" : "The whole collection";
  $("#result-count").textContent = `${passes.length} ${passes.length === 1 ? "pass" : "passes"}${view === "map" ? ` in view · ${allMatching.length} match your filters` : " match your filters"}`;
  $("#empty").hidden = passes.length > 0;
  $("#empty-text").textContent = view === "map"
    ? "Try moving the map, zooming out, or changing your filters."
    : $("#status-filter").value === "done"
      ? "Your first ascent will bring this collection to life. Open a pass and log an approach."
      : "Try another name or broaden the summit and progress filters.";
  $("#cards").innerHTML = passes.map((pass) => `
    <button type="button" class="pass-card ${completed.has(pass.id) ? "collected" : ""}" data-pass="${esc(pass.id)}"
      aria-label="${esc(shortName(pass))}, ${number(pass.elevation)} metres, ${completed.has(pass.id) ? "collected" : "still to ride"}">
      <div class="card-landscape">
        <img src="${esc(imageFor(pass))}" alt="" loading="lazy">
        <span class="elevation">${number(pass.elevation)} <small>m</small></span>
        ${completed.has(pass.id) ? '<span class="collected-stamp">✓ Collected</span>' : ""}
      </div>
      <div class="card-body">
        <h3>${esc(shortName(pass))}</h3>
        <div class="card-meta"><span>${completed.has(pass.id) ? `${passAscents(pass.id).length} ascent${passAscents(pass.id).length === 1 ? "" : "s"}` : "Still to ride"}</span><span class="arrow" aria-hidden="true">↗</span></div>
      </div>
    </button>`).join("");
}

function initializeMap() {
  if (map) { map.invalidateSize(); return; }
  if (!window.L) throw new Error("Map assets could not load. Run npm ci in the repository, then reopen the canvas. Your collection still works.");
  map = L.map("map", { scrollWheelZoom: false }).setView([46.5, 9.2], 7);
  const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
  }).addTo(map);
  tiles.on("tileerror", () => { $("#map-error").hidden = false; });
  markers = L.layerGroup().addTo(map);
  map.on("moveend", renderCards);
  renderMarkers();
}

function renderMarkers() {
  if (!map) return;
  markers.clearLayers();
  const completed = doneIds();
  const collectedColor = getComputedStyle(document.documentElement).getPropertyValue("--map-collected").trim();
  for (const pass of matching()) {
    const collected = completed.has(pass.id);
    const marker = L.circleMarker([pass.latitude, pass.longitude], {
      radius: collected ? 8 : 6, color: "#fff", weight: collected ? 2.5 : 1.5,
      fillColor: collected ? collectedColor : "#596960", fillOpacity: .95,
    });
    const label = document.createElement("span");
    label.textContent = `${shortName(pass)} · ${number(pass.elevation)} m${completed.has(pass.id) ? " · Collected" : ""}`;
    marker.bindTooltip(label).on("click", () => openPass(pass.id));
    markers.addLayer(marker);
  }
}

function setView(next) {
  view = next;
  $("#collection-tab").setAttribute("aria-pressed", String(next === "collection"));
  $("#map-tab").setAttribute("aria-pressed", String(next === "map"));
  $("#map-view").hidden = next !== "map";
  if (next === "map") initializeMap();
  renderCards();
}

function confirmChange(message, acceptLabel) {
  const dialog = $("#confirmation");
  $("#confirmation-message").textContent = message;
  $("#confirmation-accept").textContent = acceptLabel;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
}
async function allowLeave() {
  if (saving) { notice("Please wait for the current save to finish."); return false; }
  return !draft || await confirmChange("Discard the unfinished ascent or approach? Your saved records will not change.", "Discard draft");
}

async function openPass(passId) {
  if (!await allowLeave()) return;
  selectedId = passId;
  draft = false;
  $("#explorer").hidden = true;
  $("#detail").hidden = false;
  renderDetail();
  $("#detail-title").focus();
  window.scrollTo({ top: 0 });
}

async function backToCollection() {
  if (!await allowLeave()) return;
  draft = false;
  selectedId = null;
  $("#detail").hidden = true;
  $("#explorer").hidden = false;
  renderCards();
  renderMarkers();
  if (view === "map" && map) map.invalidateSize();
  $(`#${view}-tab`).focus();
}

function renderDetail() {
  const pass = catalogue.passes.find((p) => p.id === selectedId);
  const completed = doneIds().has(pass.id);
  const approaches = state.approaches.filter((a) => a.passId === pass.id);
  const ascents = passAscents(pass.id);
  const ridden = new Set(ascents.map((a) => a.approachId));
  const hasPhoto = ascents.some((a) => a.hasPhoto);
  $("#detail").innerHTML = `
    <button type="button" class="back-button quiet" id="back-button">← Back to ${view === "map" ? "map" : "collection"}</button>
    <div class="detail-banner ${completed ? "" : "uncollected"}"><img src="${esc(imageFor(pass))}" alt="${hasPhoto ? "Your photo from this pass" : ""}">${hasPhoto ? "" : '<span class="illustration-label">Alpine illustration · not a photograph of this pass</span>'}</div>
    <h1 class="detail-title" id="detail-title" tabindex="-1">${esc(shortName(pass))}</h1>
    ${shortName(pass) !== pass.name ? `<p class="full-name">${esc(pass.name)}</p>` : ""}
    <div class="detail-facts">
      <strong>${number(pass.elevation)} m summit</strong>
      <span>${esc(GROUP_LABELS[pass.group])}</span>
      <span class="status-pill ${completed ? "done" : ""}">${completed ? "✓ Collected" : "Still to ride"}</span>
      <button type="button" class="quiet" id="show-on-map">Show on map ↗</button>
    </div>
    <div class="detail-columns">
      <section aria-labelledby="approaches-title">
        <h2 id="approaches-title" class="section-heading">Choose your way up</h2>
        <p class="section-intro">Each approach is its own ride. Complete any one to collect this pass.</p>
        ${approaches.length ? approaches.map((a) => `
          <article class="approach">
            <h3>${esc(a.name)} ${ridden.has(a.id) ? '<span aria-label="Completed">✓</span>' : ""}</h3>
            <p class="metrics">${a.distanceKm != null ? `${number(a.distanceKm)} km · ${number(a.gainM)} m gain · ${number(a.gradient)}% average` : "Distance, gain and gradient not verified"}</p>
            <div class="approach-actions">
              <span>${a.verified ? "Source-verified" : "Added by you"}${a.sourceUrl ? ` · <a href="${esc(a.sourceUrl)}" target="_blank" rel="noopener noreferrer">Route details ↗</a>` : ""}</span>
              <button type="button" class="primary" data-log="${esc(a.id)}">${ridden.has(a.id) ? "Log another ascent" : "Log ascent"}</button>
            </div>
          </article>`).join("") : '<p class="journal-empty">Approaches for this pass have not been verified yet. Add the starting place or side you rode below.</p>'}
        <details class="add-approach" ${approaches.length ? "" : "open"}>
          <summary>Add an approach</summary>
          <form id="approach-form" class="form-stack">
            <label>Starting place or approach name<input name="name" required maxlength="160" placeholder="e.g. From Bormio (southwest)"></label>
            <label>Source link <small>Optional, such as a quäldich route page</small><input type="url" name="sourceUrl" maxlength="2000" placeholder="https://www.quaeldich.de/…"></label>
            <button type="submit">Add approach</button>
          </form>
        </details>
        <p class="section-footnote">${pass.sourceUrl ? `<a href="${esc(pass.sourceUrl)}" target="_blank" rel="noopener noreferrer">Original pass reference ↗</a> · ` : ""}<a href="https://www.quaeldich.de/paesse/" target="_blank" rel="noopener noreferrer">Research on quäldich ↗</a></p>
        <p class="section-footnote">The approach list may be incomplete. Check road surfaces, seasonal closures and cycling access before riding. Summit elevation is not elevation gained.</p>
      </section>
      <section aria-labelledby="journal-title">
        <div class="journal-heading"><h2 id="journal-title">Your summit journal</h2><span class="muted">${ascents.length} ${ascents.length === 1 ? "ascent" : "ascents"}</span></div>
        <div id="ascent-editor"></div>
        ${ascents.length ? ascents.map((a) => `
          <article class="journal-entry">
            <p class="journal-date">${a.date ? esc(new Date(`${a.date}T12:00:00`).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric" })) : "Date not recorded"}</p>
            <p class="approach-name">${esc(approaches.find((route) => route.id === a.approachId)?.name)}</p>
            ${a.hasPhoto ? `<img class="journal-photo" src="${photoUrl(a.id)}" alt="Photo from your ascent" loading="lazy">` : ""}
            ${a.note ? `<p class="note">${esc(a.note)}</p>` : ""}
            <div class="journal-actions"><button type="button" data-edit="${esc(a.id)}">Edit</button><button type="button" class="quiet danger" data-delete="${esc(a.id)}">Delete</button></div>
          </article>`).join("") : '<div class="journal-empty"><h3>This story is still yours to write.</h3><p>Log an ascent from one of the approaches. A date, a photo, a few words: add as much or as little as you remember.</p></div>'}
      </section>
    </div>`;
  $("#back-button").onclick = run(backToCollection);
  $("#show-on-map").onclick = run(async () => {
    if (!await allowLeave()) return;
    draft = false;
    await backToCollection();
    $("#group-filter").value = "all";
    $("#status-filter").value = "all";
    $("#pass-search").value = "";
    setView("map");
    renderMarkers();
    map.setView([pass.latitude, pass.longitude], 12);
  });
  $("#approach-form").oninput = () => { draft = true; };
  $(".add-approach").addEventListener("toggle", run(async () => {
    if (!$(".add-approach").open || !$("#ascent-form")) return;
    if (!await allowLeave()) { $(".add-approach").open = false; return; }
    draft = false;
    $("#ascent-editor").innerHTML = "";
  }));
  $("#approach-form").onsubmit = run(async (event) => {
    event.preventDefault();
    if (saving) return;
    const form = event.currentTarget;
    const button = form.querySelector("button");
    const values = Object.fromEntries(new FormData(form));
    button.disabled = true;
    saving = true;
    try {
      const result = await api("approaches", { ...values, passId: pass.id, revision: state.revision });
      state = result.state;
      draft = false;
      renderDetail();
      saving = false;
      await startAscent(result.id);
      notice("Approach added. You can now record your ascent.");
    } finally { saving = false; button.disabled = false; }
  });
}

async function preparePhoto(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 20 * 1024 * 1024) {
    throw new Error("Choose a JPEG, PNG or WebP photo under 20 MB. It will be resized and saved privately on this device.");
  }
  let image;
  try { image = await createImageBitmap(file); }
  catch { throw new Error("This photo could not be decoded. Try a different JPEG, PNG or WebP file."); }
  const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  return canvas.toDataURL("image/jpeg", .85);
}

async function startAscent(approachId, existing) {
  if (!await allowLeave()) return;
  draft = false;
  $(".add-approach").open = false;
  $("#approach-form").reset();
  const approaches = state.approaches.filter((a) => a.passId === selectedId);
  $("#ascent-editor").innerHTML = `
    <form id="ascent-form" class="ascent-form">
      <h3>${existing ? "Edit ascent" : "Record an ascent"}</h3>
      <fieldset class="form-stack">
        <label>Approach<select name="approachId" required>${approaches.map((a) => `<option value="${esc(a.id)}" ${a.id === approachId ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>
        <label>Date <small>Optional; leave empty if you do not remember</small><input type="date" name="date" value="${esc(existing?.date || "")}"></label>
        <label>A few words <small>Optional</small><textarea name="note" maxlength="4000" placeholder="The last switchback. The view. The cake afterwards.">${esc(existing?.note || "")}</textarea></label>
        <label>Photo <small>Optional · JPEG, PNG or WebP, up to 20 MB; resized to remove metadata</small><input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>
        ${existing?.hasPhoto ? `<img class="photo-preview" src="${photoUrl(existing.id)}" alt="Current ascent photo"><label class="check-label"><input type="checkbox" name="removePhoto">Remove current photo</label>` : ""}
        <div class="form-actions"><button class="primary" type="submit">Save ascent</button><button type="button" class="quiet" id="cancel-ascent">Cancel</button></div>
      </fieldset>
    </form>`;
  const form = $("#ascent-form");
  form.oninput = () => { draft = true; };
  $("#cancel-ascent").onclick = run(async () => {
    if (await allowLeave()) { draft = false; $("#ascent-editor").innerHTML = ""; }
  });
  form.onsubmit = run(async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const fieldset = form.querySelector("fieldset");
    fieldset.disabled = true;
    saving = true;
    try {
      const input = {
        revision: state.revision, approachId: data.get("approachId"),
        date: data.get("date"), note: data.get("note"), ...(existing ? { id: existing.id } : {}),
      };
      const file = data.get("photo");
      if (file?.size) input.photo = await preparePhoto(file);
      else if (data.get("removePhoto")) input.photo = null;
      const wasDone = doneIds().has(selectedId);
      const result = await api("ascents", input);
      state = result.state;
      draft = false;
      renderDetail();
      notice(wasDone ? "Ascent saved to your journal." : "Pass collected. One more road, one more story.");
    } finally { saving = false; fieldset.disabled = false; }
  });
  form.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "nearest" });
  form.querySelector("select").focus();
}

async function refreshRecords({ preserveDraft = false } = {}) {
  const latest = await api("state");
  if (state && latest.revision !== state.revision && draft && preserveDraft) {
    if (!updateNoticeShown) { notice("Another panel updated your passport. Use Reload records before saving this draft."); updateNoticeShown = true; }
    return;
  }
  state = latest;
  updateNoticeShown = false;
  if (!draft) {
    if (selectedId) renderDetail();
    else { renderCards(); renderMarkers(); }
  }
}

$("#dismiss-error").onclick = () => { $("#error").hidden = true; };
$(".brand").onclick = run(async (event) => {
  if (!catalogue) return;
  event.preventDefault();
  await backToCollection();
});
$("#reload-button").onclick = run(async () => {
  if (!catalogue) { await initialize(); return; }
  await refreshRecords();
  $("#error").hidden = true;
  notice(draft ? "Latest records loaded. Your draft is unchanged; review it before saving." : "Latest records loaded.");
});
$("#collection-tab").onclick = run(() => setView("collection"));
$("#map-tab").onclick = run(() => setView("map"));
$("#cards").onclick = run(async (event) => {
  const button = event.target.closest("[data-pass]");
  if (button) await openPass(button.dataset.pass);
});
for (const selector of ["#group-filter", "#status-filter", "#pass-search"]) {
  $(selector).addEventListener(selector === "#pass-search" ? "input" : "change", () => { renderCards(); renderMarkers(); });
}
$("#reset-filters").onclick = run(() => {
  $("#group-filter").value = "all";
  $("#status-filter").value = "all";
  $("#pass-search").value = "";
  renderMarkers();
  if (map && view === "map") fitMap();
  renderCards();
});
function fitMap() {
  const passes = matching();
  if (!passes.length) { notice("No passes match these filters."); return; }
  map.fitBounds(passes.map((p) => [p.latitude, p.longitude]), { padding: [25, 25], maxZoom: 12 });
}
$("#fit-map").onclick = run(fitMap);
$("#location-form").onsubmit = run(async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  const sequence = ++searchSequence;
  button.disabled = true;
  $("#location-results").textContent = "Finding places…";
  try {
    const places = await api(`search?q=${encodeURIComponent($("#location-input").value.trim())}`);
    if (sequence !== searchSequence) return;
    $("#location-results").replaceChildren();
    if (!places.length) $("#location-results").textContent = "No places found. Try a nearby town or a different spelling.";
    for (const place of places) {
      const result = document.createElement("button");
      result.type = "button";
      result.textContent = place.label;
      result.onclick = () => {
        map.setView([place.latitude, place.longitude], 10);
        if (locationMarker) locationMarker.remove();
        locationMarker = L.circleMarker([place.latitude, place.longitude], { radius: 9, color: "#2145a0", fillOpacity: .3 }).addTo(map);
        const label = document.createElement("span");
        label.textContent = place.label;
        locationMarker.bindTooltip(label);
        $("#map-caption").textContent = `Around ${place.label}`;
        $("#location-results").replaceChildren();
      };
      $("#location-results").append(result);
    }
  } catch (error) {
    $("#location-results").textContent = "Search failed. You can still browse the map.";
    throw error;
  } finally { button.disabled = false; }
});
$("#detail").onclick = run(async (event) => {
  const log = event.target.closest("[data-log]");
  const edit = event.target.closest("[data-edit]");
  const remove = event.target.closest("[data-delete]");
  if (log) await startAscent(log.dataset.log);
  if (edit) {
    const ascent = state.ascents.find((a) => a.id === edit.dataset.edit);
    await startAscent(ascent.approachId, ascent);
  }
  if (remove) {
    if (!await allowLeave() || !await confirmChange("Delete this ascent and its photo? If it is the last ascent, the pass will return to Still to ride.", "Delete ascent")) return;
    saving = true;
    remove.disabled = true;
    try {
      const result = await api("ascents/delete", { id: remove.dataset.delete, revision: state.revision });
      state = result.state;
      draft = false;
      renderDetail();
      notice("Ascent deleted.");
    } finally { saving = false; remove.disabled = false; }
  }
});
$("#backup-button").onclick = run(async () => {
  const backup = await api("backup");
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `col-collector-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  notice("Backup downloaded. It contains your private notes and photos; keep it somewhere safe.");
});
$("#restore-file").onchange = run(async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) throw new Error("This backup is larger than the 60 MB restore limit.");
  if (!await allowLeave() || !await confirmChange("Replace this device's passport with the backup? Download a backup of your current records first. This cannot be undone.", "Replace passport")) return;
  let backup;
  try { backup = JSON.parse(await file.text()); } catch { throw new Error("This file is not valid JSON. Choose a Col Collector backup."); }
  saving = true;
  try {
    const result = await api("restore", { revision: state.revision, backup });
    state = result.state;
    draft = false;
    if (selectedId) renderDetail();
    else { renderCards(); renderMarkers(); }
    notice(`Backup restored: ${result.restored} ascents.`);
  } finally { saving = false; }
});
window.addEventListener("beforeunload", (event) => { if (draft) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("focus", run(async () => { if (state && !saving) await refreshRecords({ preserveDraft: true }); }));
document.addEventListener("visibilitychange", run(async () => {
  if (!document.hidden && state && !saving) await refreshRecords({ preserveDraft: true });
}));
async function initialize() {
  [catalogue, state] = await Promise.all([api("catalogue"), api("state")]);
  $("#loading").hidden = true;
  $("#explorer").hidden = false;
  $("#error").hidden = true;
  renderCards();
}
initialize().catch((error) => { $("#loading").textContent = "Your passport could not open. Use Reload records to try again."; showError(error); });
