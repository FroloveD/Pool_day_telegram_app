const token = process.env.BOT_TOKEN;
const baseUrl = (process.env.PUBLIC_SERVER_URL || "").replace(/\/$/, "");
const secret = process.env.WEBHOOK_SECRET;
if (!token || !baseUrl || !secret) {
  console.error("Set BOT_TOKEN, PUBLIC_SERVER_URL (HTTPS) and WEBHOOK_SECRET first.");
  process.exit(1);
}
(async () => {
  const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `${baseUrl}/telegram/webhook`, secret_token: secret, allowed_updates: ["message"] })
  });
  const data = await r.json();
  console.log(data);
  if (!data.ok) process.exitCode = 1;
})();
