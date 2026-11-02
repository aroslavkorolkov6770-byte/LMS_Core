"use strict";
const path = require("node:path");
const crypto = require("node:crypto");
const fail = code => { throw Object.assign(Error(code), { code }); };
const requireValue = (value, code) => { if (!value) fail(code); };
const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) && !/^\d+$/.test(value);
const ENDPOINT = "https://ai.api.cloud.yandex.net/v1/vector_stores";
const MAX_CALENDAR_UNIX_SECONDS = 253402300799;

// Only resource-management requests are allowed here: no generation, search, upload or deletion.
async function provisionAi(target, input, options = {}) {
  const ai = options.ai;
  requireValue(ai && typeof ai.configureAi === "function", "AI_PROVISION_CONTRACT_REQUIRED");
  const settings = { ...input, AI_VECTOR_STORE_ID: "core-auto-pending" };
  let indexId = "", indexReused = false, indexExpiryDays, indexExpiresAt, indexExpiryDiagnostic;
  const cloudFetch = options.cloudFetch || fetch;
  try {
    const result = await ai.configureAi(target, settings, { ...options,
      prepare: async e => {
        await e.health();
        const values = ai.normalizeSettings(settings, e.effective);
        const folder = values.AI_PROJECT_ID;
        const file = path.join(e.shared, `ai-index-${crypto.createHash("sha256").update(folder).digest("hex").slice(0, 16)}.json`);
        const rawJournal = await e.optional(file);
        let journal;
        if (rawJournal !== null) {
          try { journal = JSON.parse(rawJournal); } catch { fail("AI_INDEX_JOURNAL_INVALID"); }
          requireValue(journal.version === 1 && journal.clientId === e.c.clientId && journal.folder === folder && ["creating", "ready", "rejected"].includes(journal.phase) && (journal.indexId === undefined || validId(journal.indexId)), "AI_INDEX_JOURNAL_INVALID");
        }
        const save = async (phase, id) => {
          journal = { version: 1, clientId: e.c.clientId, folder, operationId: e.c.operationId, phase, updatedAt: new Date().toISOString(), ...(id ? { indexId: id } : {}) };
          await e.atomic(file, JSON.stringify(journal));
        };
        const request = async (suffix, body) => {
          let response;
          try {
            response = await cloudFetch(ENDPOINT + suffix, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(20000),
              headers: { Authorization: `Bearer ${values.AI_API_KEY}`, "OpenAI-Project": folder, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
          } catch { fail(body ? "AI_INDEX_CREATION_UNCONFIRMED" : "AI_INDEX_NETWORK_UNAVAILABLE"); }
          if (!response.ok) {
            if (body && [400, 401, 403, 404, 422, 429].includes(response.status)) await save("rejected");
            // Never return provider text: it may echo headers, credentials or request data.
            const codes = { 400: "AI_INDEX_REQUEST_REJECTED", 401: "AI_PROVIDER_KEY_REJECTED", 403: "AI_PROVIDER_PERMISSION_DENIED", 404: "AI_INDEX_NOT_FOUND", 422: "AI_INDEX_REQUEST_REJECTED", 429: "AI_PROVIDER_RATE_LIMIT" };
            fail(codes[response.status] || (body ? "AI_INDEX_CREATION_UNCONFIRMED" : "AI_PROVIDER_UNAVAILABLE"));
          }
          try {
            if (Number(response.headers?.get("content-length")) > 1024 * 1024) fail("AI_INDEX_RESPONSE_INVALID");
            const text = await response.text(); requireValue(Buffer.byteLength(text) <= 1024 * 1024, "AI_INDEX_RESPONSE_INVALID"); return JSON.parse(text);
          } catch { fail(body ? "AI_INDEX_CREATION_UNCONFIRMED" : "AI_INDEX_RESPONSE_INVALID"); }
        };
        const owned = item => item && validId(item.id) && item.object === "vector_store" && item.metadata?.managed_by === "lms_core" && item.metadata?.client_id === e.c.clientId;
        const verify = (item, reused = false) => {
          requireValue(owned(item), "AI_INDEX_OWNER_MISMATCH");
          indexId = item.id; indexReused = reused;
          requireValue(item.status === "completed", "AI_INDEX_NOT_READY");
          const policy = item.expires_after;
          indexExpiryDiagnostic = {
            anchor: policy?.anchor == null ? "absent" : policy.anchor === "" ? "empty" : policy.anchor === "last_active_at" ? "last_active_at" : "other",
            policyKeys: policy && typeof policy === "object" && !Array.isArray(policy) ? [...new Set(Object.keys(policy).map(key => ["anchor", "days", "valid"].includes(key) ? key : "unknown")), ...(policy.valid === false ? ["valid_false"] : policy.valid === true ? ["valid_true"] : []), ...(item.expires_at === -62135596800 ? ["timestamp_zero_time"] : typeof item.expires_at === "number" && item.expires_at < 0 ? ["timestamp_negative"] : [])].sort().join(",") : "",
            timestampType: item.expires_at == null ? "absent" : typeof item.expires_at,
            timestampZero: item.expires_at === "0" || item.expires_at === 0
          };
          indexExpiryDays = Number.isSafeInteger(policy?.days) ? policy.days : undefined;
          indexExpiresAt = typeof item.expires_at === "number" && Number.isFinite(item.expires_at) && Number.isSafeInteger(Math.trunc(item.expires_at)) ? Math.trunc(item.expires_at) : undefined;
          // Yandex can serialize an unset policy as zero days (valid policies require 1..365).
          // A calendar expiry timestamp, positive days or unknown policy fields still block use.
          const wrappedUnset = policy && typeof policy === "object" && !Array.isArray(policy) && policy.valid === false && policy.days === 0 && Object.keys(policy).every(key => ["anchor", "days", "valid"].includes(key));
          const noPolicy = wrappedUnset || policy == null || typeof policy === "object" && !Array.isArray(policy) && (
            Object.keys(policy).length === 0 || policy.days === 0 &&
            (policy.anchor == null || ["", "last_active_at"].includes(policy.anchor)) && Object.keys(policy).every(key => ["anchor", "days"].includes(key))
          );
          // With valid=false the provider can emit a non-calendar sentinel, not a Unix-seconds expiry.
          // A usable positive Unix timestamp still fails closed, even alongside a disabled wrapper.
          const sentinel = typeof item.expires_at === "number" && Number.isFinite(item.expires_at) && (item.expires_at < 0 || item.expires_at > MAX_CALENDAR_UNIX_SECONDS);
          const noTimestamp = item.expires_at == null || item.expires_at === 0 || wrappedUnset && sentinel;
          requireValue(noPolicy && noTimestamp, "AI_INDEX_EXPIRATION_UNSUPPORTED");
          return item.id;
        };
        if (journal?.indexId) {
          indexId = verify(await request("/" + encodeURIComponent(journal.indexId)), true);
          requireValue(indexId === journal.indexId, "AI_INDEX_OWNER_MISMATCH"); indexReused = true;
        } else {
          // Stable ownership metadata also recovers a resource after a lost POST response or reinstall.
          const matches = []; let after = "", finished = false;
          for (let page = 0; page < 10; page++) {
            const list = await request("?limit=100&order=desc" + (after ? "&after=" + encodeURIComponent(after) : ""));
            requireValue(Array.isArray(list.data) && list.data.length <= 100 && typeof list.has_more === "boolean", "AI_INDEX_RESPONSE_INVALID");
            matches.push(...list.data.filter(owned));
            requireValue(matches.length <= 1, "AI_INDEX_MULTIPLE_OWNED");
            if (!list.has_more) { finished = true; break; }
            requireValue(validId(list.last_id) && list.last_id !== after && list.data.length > 0, "AI_INDEX_RESPONSE_INVALID"); after = list.last_id;
          }
          requireValue(finished, "AI_INDEX_LIST_LIMIT");
          if (matches.length) { indexId = verify(matches[0], true); indexReused = true; }
          else {
            // An interrupted creation is never retried blindly, even if listing is eventually consistent.
            requireValue(journal?.phase !== "creating", "AI_INDEX_CREATION_UNCONFIRMED");
            await save("creating");
            const created = await request("", { name: "LMS " + path.basename(e.c.appPath), file_ids: [], metadata: { managed_by: "lms_core", client_id: e.c.clientId } });
            requireValue(owned(created), "AI_INDEX_CREATION_UNCONFIRMED");
            indexId = created.id; await save("ready", indexId);
            verify(created);
          }
          await save("ready", indexId);
        }
        settings.AI_VECTOR_STORE_ID = indexId;
      }
    });
    if (result.errorCode === "AI_INDEX_CREATION_UNCONFIRMED") result.phase = "needs_attention";
    return { ...result, ...(indexId ? { indexId, indexReused } : {}), ...(indexExpiryDays !== undefined ? { indexExpiryDays } : {}), ...(indexExpiresAt !== undefined ? { indexExpiresAt } : {}), ...(indexExpiryDiagnostic ? { indexExpiryDiagnostic } : {}), provisionMode: "core_vector_store", providerVerified: false };
  } finally { delete settings.AI_API_KEY; }
}
module.exports = { provisionAi };
