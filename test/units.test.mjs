import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { zoneStart, zoneEndOfDay } from "../proxy/time.mjs";
import { classify, usageFromJson, firstEvent } from "../proxy/proxy.mjs";
import { clientIp } from "../proxy/http-util.mjs";
import { sendMail } from "../proxy/smtp.mjs";
import { inQuietHours } from "../proxy/notify.mjs";

test("day starts follow the time zone", () => {
  const at = new Date("2026-03-10T20:00:00Z");
  assert.equal(zoneStart("UTC", "day", at), "2026-03-10T00:00:00.000Z");
  assert.equal(zoneStart("Asia/Kolkata", "day", at), "2026-03-10T18:30:00.000Z"); // 01:30 local on the 11th
  assert.equal(zoneStart("America/New_York", "month", at), "2026-03-01T05:00:00.000Z");
  assert.equal(zoneEndOfDay("UTC", "2026-03-10"), "2026-03-10T23:59:59.000Z");
});

test("error classification", () => {
  assert.equal(classify(429, "rate_limit_error"), "limited");
  assert.equal(classify(402, "billing_error"), "limited");
  assert.equal(classify(401, "authentication_error"), "signed_out");
  assert.equal(classify(503, "overloaded_error"), "server");
  assert.equal(classify(400, "invalid_request_error"), null);
  assert.equal(classify(429, "overloaded_error"), "server");
});

test("usage from both formats", () => {
  assert.deepEqual(usageFromJson({ usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 1 } }), { in_tok: 5, out_tok: 2, cache_read: 7, cache_write: 1 });
  assert.deepEqual(usageFromJson({ usage: { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 60 } } }), { in_tok: 40, out_tok: 3, cache_read: 60, cache_write: 0 });
});

test("first stream event skips pings", () => {
  assert.equal(firstEvent(": ping\n\n"), null);
  assert.equal(firstEvent(': ping\n\nevent: error\ndata: {"type":"error","error":{"type":"rate_limit_error"}}\n\n').type, "error");
  assert.equal(firstEvent('data: {"type":"message_start"}\n').type, "message_start");
});

test("client address trusts headers only when told to, and only from this machine", () => {
  const req = (addr, headers) => ({ socket: { remoteAddress: addr }, headers });
  assert.equal(clientIp(req("127.0.0.1", { "cf-connecting-ip": "1.2.3.4" }), "none"), "127.0.0.1");
  assert.equal(clientIp(req("127.0.0.1", { "cf-connecting-ip": "1.2.3.4" }), "cloudflare"), "1.2.3.4");
  assert.equal(clientIp(req("10.0.0.5", { "cf-connecting-ip": "1.2.3.4" }), "cloudflare"), "10.0.0.5");
  assert.equal(clientIp(req("::ffff:127.0.0.1", { "x-forwarded-for": "5.6.7.8, 9.9.9.9" }), "forwarded"), "5.6.7.8");
});

test("quiet hours across midnight", () => {
  const cfg = (from, to, tz) => ({ timeZone: tz, alerts: { quietFrom: from, quietTo: to } });
  const now = new Date();
  const hh = (d) => String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
  const minus = (m) => hh(new Date(now.getTime() - m * 60_000));
  const plus = (m) => hh(new Date(now.getTime() + m * 60_000));
  assert.equal(inQuietHours(cfg(minus(30), plus(30), "UTC")), true);
  assert.equal(inQuietHours(cfg(plus(30), plus(90), "UTC")), false);
  assert.equal(inQuietHours(cfg("", "", "UTC")), false);
});

test("SMTP client sends a message (plain, with AUTH)", async () => {
  const got = [];
  const server = net.createServer((sock) => {
    sock.write("220 fake ESMTP\r\n");
    let data = false;
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === ".") {
            data = false;
            sock.write("250 queued\r\n");
          } else got.push(line);
          continue;
        }
        got.push(line);
        if (line.startsWith("EHLO")) sock.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (line.startsWith("AUTH PLAIN")) sock.write("235 ok\r\n");
        else if (line === "DATA") {
          data = true;
          sock.write("354 go\r\n");
        } else if (line === "QUIT") sock.end("221 bye\r\n");
        else sock.write("250 ok\r\n");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await sendMail({ host: "127.0.0.1", port: server.address().port, security: "none", user: "u", pass: "p", from: "a@x", to: "b@x, c@x", subject: "Hello ✓", text: "line\n.dot" });
  server.close();
  assert.ok(got.includes("MAIL FROM:<a@x>"));
  assert.ok(got.includes("RCPT TO:<b@x>") && got.includes("RCPT TO:<c@x>"));
  assert.ok(got.some((l) => l.startsWith("Subject: =?UTF-8?B?")));
});
