/* Service-worker fetch/cache contract. Run with: node tests/test-sw.js */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");

function harness() {
  const listeners = {};
  const writes = [];
  let response = null;
  let cached = null;
  let rejectPut = false;
  const context = {
    URL,
    location: { origin: "https://nutridaily.test" },
    self: {
      addEventListener(type, handler) { listeners[type] = handler; },
      skipWaiting() { return Promise.resolve(); },
      clients: { claim() { return Promise.resolve(); } },
    },
    caches: {
      match() { return Promise.resolve(cached); },
      keys() { return Promise.resolve([]); },
      delete() { return Promise.resolve(true); },
      open() {
        return Promise.resolve({
          addAll() { return Promise.resolve(); },
          put(request, value) {
            writes.push({ request, value });
            return rejectPut ? Promise.reject(new Error("cache quota")) : Promise.resolve();
          },
        });
      },
    },
    fetch() { return Promise.resolve(response); },
    Promise,
  };
  vm.runInNewContext(source, context, { filename: "sw.js" });
  return {
    listeners,
    writes,
    setResponse(value) { response = value; },
    setCached(value) { cached = value; },
    failCacheWrite(value) { rejectPut = value; },
  };
}

function fakeResponse(status) {
  const response = {
    status,
    ok: status >= 200 && status < 300,
    type: "basic",
    clone() { return { clonedFrom: response }; },
  };
  return response;
}

async function dispatchFetch(h, request) {
  let waitPromise = null;
  let responsePromise = null;
  h.listeners.fetch({
    request,
    waitUntil(promise) { waitPromise = Promise.resolve(promise); },
    respondWith(promise) { responsePromise = Promise.resolve(promise); },
  });
  assert(responsePromise, "fetch handler must call respondWith");
  assert(waitPromise, "fetch handler must register waitUntil synchronously");
  const result = await responsePromise;
  await waitPromise;
  return result;
}

(async () => {
  const request = { url: "https://nutridaily.test/js/app.js", method: "GET" };

  const quota = harness();
  const network200 = fakeResponse(200);
  quota.setResponse(network200);
  quota.failCacheWrite(true);
  const quotaResult = await dispatchFetch(quota, request);
  assert.strictEqual(quotaResult, network200,
    "a cache.put rejection must not discard a successful network response");
  assert.strictEqual(quota.writes.length, 1, "a 200 response should attempt a best-effort cache write");

  for (const status of [204, 404]) {
    const nonCacheable = harness();
    const network = fakeResponse(status);
    nonCacheable.setResponse(network);
    const result = await dispatchFetch(nonCacheable, request);
    assert.strictEqual(result, network, `status ${status} should still be returned`);
    assert.strictEqual(nonCacheable.writes.length, 0, `status ${status} must not be cached`);
  }

  console.log("service worker: 5 passed, 0 failed");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
