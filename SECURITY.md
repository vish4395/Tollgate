# Security

## Reporting a problem

Please report security problems privately through GitHub's **Report a vulnerability** button (Security tab), not in a public issue. Include the steps to reproduce it and what an attacker could do. You'll get an answer within a week.

## Design notes

- Project keys are random and stored only as SHA-256 hashes.
- The backend listens only on `127.0.0.1` and needs an internal key.
- The dashboard uses a scrypt password and an HttpOnly, SameSite=Strict cookie, plus a custom header on every change (CSRF). Sign-in attempts are rate-limited, and sessions can be ended everywhere.
- Client addresses come from the connection; proxy headers are believed only when a trusted proxy is configured.
- Prompts and replies are never stored.
- Tollgate is meant for one person's own use on a trusted network or behind a tunnel. Don't expose the dashboard to the internet without the protections in [docs/remote-access.md](docs/remote-access.md).
