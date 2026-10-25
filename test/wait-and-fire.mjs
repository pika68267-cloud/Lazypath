// Waits for the first real login to land, then proves the gateway with a live request.
const GW = process.env.GW ?? "http://127.0.0.1:8787";
const DEADLINE = Date.now() + Number(process.env.WAIT_MIN ?? 45) * 60_000;

const get = async (path) => (await fetch(GW + path)).json();

let connected = [];
while (Date.now() < DEADLINE) {
  const s = await get("/api/summary").catch(() => null);
  connected = s?.providers.filter((p) => p.connected).map((p) => p.id) ?? [];
  if (connected.length) break;
  await new Promise((r) => setTimeout(r, 4000));
}
if (!connected.length) {
  console.log("TIMEOUT: nothing connected");
  process.exit(1);
}

const key = (await get("/api/summary")).gatewayKey;
const models = await get("/v1/models");
const id = connected[0];
const model = models.data.find((m) => m.id.startsWith(id + "/"))?.id ?? id;
console.log(`CONNECTED: ${connected.join(", ")}`);
console.log(`model:     ${model}`);

for (const stream of [false, true]) {
  const started = Date.now();
  const res = await fetch(GW + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: it works" }],
      stream,
    }),
  });
  const body = await res.text();
  console.log(`\n--- stream=${stream} HTTP ${res.status} in ${Date.now() - started}ms`);
  console.log(`provider: ${res.headers.get("x-lazypath-provider")}`);
  console.log(body.slice(0, 1200));
}
