# Contributing to Tollgate

Thanks for helping. Tollgate is small on purpose, so a few rules keep it that way.

## Ground rules

- **No npm dependencies in the gateway** (`proxy/`). Use what Node 22 ships (`node:http`, `node:sqlite`, `node:test`, `fetch`). Meridian is the one dependency, installed separately in `meridian/`.
- **No build step** for the dashboard (`proxy/public/`): plain HTML, JS and CSS. No inline scripts or styles; the page runs under a strict Content-Security-Policy.
- **Never store prompts or replies.** Log metadata only.
- **Every change ships with tests** in `test/`. They run against the fake backend in `test/helpers.mjs` and must never need a real Claude account.
- **macOS, Linux and Windows.** Use `node:path`, avoid shell-only tricks, and keep `proxy/cli.mjs` working on all three.

## Getting started

```bash
git clone https://github.com/vishalsharmads/claude-cli-api-gateway.git tollgate
cd tollgate
npm test        # all tests, about 30 seconds
npm run demo    # the dashboard with sample data at http://127.0.0.1:4199
```

To run the real gateway in the foreground while you work: `node proxy/cli.mjs run`.

## Pull requests

- One topic per pull request, with a short description of what and why.
- Conventional commit messages: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`.
- Update the docs (`README.md`, `docs/`) and `CHANGELOG.md` when behaviour changes.
- For UI changes, add a screenshot in light and dark mode, and check a phone-width window.

## Reporting security problems

Please don't open a public issue. See [SECURITY.md](SECURITY.md).
