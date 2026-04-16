/**
 * api.js - Fetch wrapper for the azworld REST API.
 *
 * All endpoints return JSON. POST endpoints typically return { result, snapshot }.
 */

export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

export async function apiPost(path, body) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

export async function apiDelete(path) {
  return api(path, { method: "DELETE" });
}

export async function apiPatch(path, body) {
  return api(path, { method: "PATCH", body: JSON.stringify(body) });
}
