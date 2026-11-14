# Claude accounts and fallback

The gateway can spread requests over several Claude accounts and switch to another one by itself when an account hits its usage limit or gets signed out. Your apps don't notice: they get one normal reply.

> **Only use accounts that are yours.** Each Claude subscription is for one person. Pooling several people's accounts, or several accounts to get around usage limits, may break Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms).

## How it works

```
request ──▶ project's account list (or all accounts, in order)
             ├─ skip: turned off, signed out, paused, or over its reserve
             └─ try the first one ──▶ rate limited? ──▶ pause it, try the next
                                      signed out?   ──▶ mark it, try the next
                                      backend error? ─▶ try the next once
                                      anything else ─▶ reply to the app
```

- The gateway pins each attempt to one account, so the request log, usage and alerts show which account served each request.
- **Rate limited** (`429` or a billing refusal): the account is paused until the time the backend gives (`Retry-After`), or until its 5-hour window resets. The pause ends early when the quota shows the window has reset. **Use again now** on the Accounts page ends it by hand.
- **Signed out:** the account is skipped until it signs in again (`node proxy/cli.mjs account login <name>`). The gateway notices within a minute.
- **Streams** are checked before anything reaches your app. An error in the first event (for example a rate limit) still falls back to the next account. Once the reply has started, it can't switch.
- **Errors in your request** (bad model, invalid body, a reply that is too long) are returned as they are; another account wouldn't help.
- When **no account can serve**, the app gets `429` with `Retry-After` set to when the first account is free again, and a "No Claude account available" alert opens.

## Adding accounts

Run these in the gateway folder on the gateway computer. Signing in needs a browser there.

```bash
node proxy/cli.mjs account add work            # browser sign-in
node proxy/cli.mjs account add work --headless # prints a link; open it on any device, paste the code back
node proxy/cli.mjs account add ci --token      # uses a token from `claude setup-token` (made on any computer)
node proxy/cli.mjs account list                # every account and whether it's signed in
node proxy/cli.mjs account login work          # sign an account in again
node proxy/cli.mjs account rename work office
node proxy/cli.mjs account remove work
```

New accounts appear on the **Accounts** page within a minute (or press **Refresh**).

### This computer's own sign-in

With no named accounts, the gateway uses the Claude sign-in of the user it runs as (the one `claude` uses in a terminal). It shows as **This computer's sign-in** (`default`).

**Once you add a named account, the backend no longer uses that sign-in**: the `default` entry is turned off. To keep using your main account, add it as a named account too:

```bash
node proxy/cli.mjs account add main
```

Accounts are stored in `data/meridian-config/` inside the gateway folder (not committed to git).

## Order, projects and reserves

- **Order:** requests go to the first ready account. Change the order with the arrows on the Accounts page.
- **Per project:** on a project's **Accounts** tab, pick which accounts it may use and in what order. For example, a production app could use only `work`, while a test app uses `spare` first and `work` as a fallback. Empty means all accounts, in the global order.
- **Reserve:** in an account's **Settings**, set "Stop using above 5-hour use (%)" or the 7-day version. The gateway then leaves the rest for your own Claude use.
- **Project pause:** a project's "Pause above 5-hour use (%)" limit applies to each account it may use, so it skips busy accounts and moves on to others.
- **Turn off** an account to stop sending it anything without removing it.

## What you see

- **Accounts page:** state (Ready, Paused, Signed out, Off), plan, 5-hour and 7-day use with reset times, sign-in renewal date, today's requests through the gateway, and a **Test** button that sends one tiny request.
- **Requests:** an Account column and filter. **Tries** above 1 means the gateway fell back.
- **Usage:** a "By account" table.
- **Monitoring:** each account's 5-hour and 7-day use over time.
- **Activity:** every pause, sign-out and fallback.
- **Alerts:** near limit, limit reached, signed out, sign-in expiring soon, no account available.
