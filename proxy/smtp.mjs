// Minimal SMTP client (no dependencies): implicit TLS or STARTTLS, AUTH PLAIN/LOGIN, one message.
import net from "node:net";
import tls from "node:tls";
import { randomUUID } from "node:crypto";

const enc = (s) => Buffer.from(s, "utf8").toString("base64");
const headerWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${enc(s)}?=`);
const addr = (s) => String(s).trim().replace(/[\r\n]/g, "");

/**
 * opts: { host, port, security: "tls" | "starttls" | "none", user, pass, from, to, subject, text,
 *         timeoutMs, rejectUnauthorized }
 */
export function sendMail(opts) {
  const timeout = opts.timeoutMs ?? 15_000;
  const host = addr(opts.host);
  return new Promise((resolve, reject) => {
    let sock;
    let buf = "";
    let waiter = null;
    const fail = (e) => {
      sock?.destroy();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const timer = setTimeout(() => fail(new Error("SMTP timed out")), timeout);
    const onData = (d) => {
      buf += d.toString("utf8");
      // A reply is complete when its last line is "NNN text" (no dash after the code).
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const reply = lines.slice(0, i + 1).join("\n");
          buf = lines.slice(i + 1).join("\r\n");
          const w = waiter;
          waiter = null;
          w?.(reply);
          return;
        }
      }
    };
    const read = () => new Promise((r) => (waiter = r));
    const cmd = async (line, expect) => {
      const p = read();
      if (line != null) sock.write(line + "\r\n");
      const reply = await p;
      const code = Number(reply.slice(0, 3));
      if (!expect.includes(code)) throw new Error(`SMTP ${line?.split(" ")[0] ?? "greeting"} failed: ${reply.slice(0, 200)}`);
      return reply;
    };
    const attach = (s) => {
      sock = s;
      sock.on("data", onData);
      sock.on("error", fail);
    };
    const tlsOpts = { servername: host, rejectUnauthorized: opts.rejectUnauthorized !== false };

    const run = async () => {
      await cmd(null, [220]);
      let ehlo = await cmd("EHLO gateway.local", [250]);
      if (opts.security === "starttls") {
        if (!/STARTTLS/i.test(ehlo)) throw new Error("The server does not offer STARTTLS.");
        await cmd("STARTTLS", [220]);
        sock.removeListener("data", onData);
        await new Promise((ok, bad) => {
          const t = tls.connect({ socket: sock, ...tlsOpts }, ok);
          t.on("error", bad);
          attach(t);
        });
        ehlo = await cmd("EHLO gateway.local", [250]);
      }
      if (opts.user) {
        if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo)) await cmd(`AUTH PLAIN ${enc(`\0${opts.user}\0${opts.pass ?? ""}`)}`, [235]);
        else {
          await cmd("AUTH LOGIN", [334]);
          await cmd(enc(opts.user), [334]);
          await cmd(enc(opts.pass ?? ""), [235]);
        }
      }
      const to = String(opts.to).split(/[,;]/).map(addr).filter(Boolean);
      await cmd(`MAIL FROM:<${addr(opts.from)}>`, [250]);
      for (const r of to) await cmd(`RCPT TO:<${r}>`, [250, 251]);
      await cmd("DATA", [354]);
      const body = String(opts.text)
        .replace(/\r?\n/g, "\r\n")
        .replace(/^\./gm, "..");
      const msg = [
        `From: ${addr(opts.from)}`,
        `To: ${to.join(", ")}`,
        `Subject: ${headerWord(String(opts.subject).replace(/[\r\n]/g, " "))}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${randomUUID()}@gateway.local>`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        enc(body).replace(/.{76}/g, "$&\r\n"),
        ".",
      ].join("\r\n");
      await cmd(msg, [250]);
      await cmd("QUIT", [221]).catch(() => {});
    };

    const s =
      opts.security === "tls"
        ? tls.connect({ host, port: opts.port || 465, ...tlsOpts })
        : net.connect({ host, port: opts.port || 587 });
    attach(s);
    run()
      .then(() => {
        clearTimeout(timer);
        sock.end();
        resolve();
      })
      .catch((e) => {
        clearTimeout(timer);
        fail(e);
      });
  });
}
