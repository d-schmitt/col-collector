export const GROUP_LABELS = { high: "Above 2,000 m", low: "Below 2,000 m" };

export function completedPassIds(approaches, ascents) {
  const ridden = new Set(ascents.map((ascent) => ascent.approachId));
  return new Set(approaches.filter((approach) => ridden.has(approach.id)).map((approach) => approach.passId));
}

export function filterPasses(passes, completed, { group = "all", status = "all", query = "" } = {}) {
  const needle = normalize(query);
  return passes.filter((pass) =>
    (group === "all" || pass.group === group) &&
    (status === "all" || completed.has(pass.id) === (status === "done")) &&
    (!needle || normalize(pass.name).includes(needle)));
}

export function normalize(value) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function text(value, label, max, required = false) {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw new InputError(`${label} must be ${required ? "non-empty text" : "text"} of at most ${max} characters.`);
  }
  return value.trim();
}

export function validateDate(value) {
  if (value === "") return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InputError("Choose a valid date or leave the date empty.");
  }
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new InputError("Choose a valid calendar date.");
  }
  return value;
}

export function validateSourceUrl(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new InputError("The source link must be a complete HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password || value.length > 2000) {
    throw new InputError("The source link must be an HTTPS URL without credentials.");
  }
  return url.href;
}
