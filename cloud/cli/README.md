# athena-cloud

Athena Cloud from a terminal. It talks to `/api/v1` over HTTP and holds a
session cookie in `~/.athena/cloud.json`.

It has **no access to the catalogue and no copy of it**. Every number it prints
was counted by the server — the same promise the web UI makes, and the reason
both can be believed.

```bash
cd cloud
npm install
npm run cli -- --help
```

By default it talks to the deployed site. Point it somewhere else with
`--base http://localhost:3000` or `ATHENA_CLOUD_URL`.

## Signing in

```bash
npm run cli -- login                        # lists the accounts this deployment offers
npm run cli -- login iris@hadesmedia.example
```

The account list is **fetched, not hardcoded** — the first draft of this tool
shipped five addresses on the wrong domain and every one of them failed. It is
published only while the deployment runs on fixture accounts; with real
accounts `/api/v1/accounts` returns 404 rather than enumerating users, and
`login` asks for a password.

What is stored is a signed, expiring session cookie, written `0600` and never
printed — including by `--json`. There is no password on the demo deployment to
store.

## Reading the catalogue

```bash
npm run cli -- workspaces
npm run cli -- ls --doctype invoice --date 2024
npm run cli -- ls --q statement --limit 20 --cursor 40
npm run cli -- tags --topic finance
npm run cli -- show f_97eb5b07c9
```

`ls`, `tags` and `brief` take the same filters as the web app, parsed by the
same codec — so a URL you are looking at in a browser answers the same question
with `/w/` swapped for `/api/v1/w/`. Filter flags are derived from `TAG_AXES`,
so an axis added to the taxonomy reaches the terminal for free and one removed
cannot leave a flag behind that quietly filters on nothing.

The workspace comes from `--ws`, then `ATHENA_CLOUD_WS`, then the one
remembered at login — which only happens when you belong to exactly one.
Guessing for a member of three would print a real table about the wrong
catalogue.

## The agent

```bash
npm run cli -- brief --doctype invoice --date 2024
npm run cli -- brief --topic design --no-model      # counted only, spends nothing
npm run cli -- ask "how do finance and legal overlap"
npm run cli -- explain f_97eb5b07c9
```

`ask` turns a question into a filter and picks one of the three graph modes,
then prints **the catalogue's count** and a URL. The model chooses what to look
at; it is never asked how many there are.

`explain` describes a file from its name, folder, labels and nearest
neighbours, and always prints what it could not determine without opening the
file. Nothing in this catalogue holds file contents.

`show` includes related files, which cost nothing: cosine similarity over
idf-weighted tag vectors, ranked by how *rare* the shared tags are rather than
how many there are.

**`ask`, `explain` and `brief` (without `--no-model`) spend a model call** from
the same per-viewer daily budget the website uses. Exit code `4` means that
budget is gone.

## Scripting

`--json` on any command prints the server's answer verbatim. That is the point
of a CLI over a web page, so the human rendering is a convenience over it
rather than the only way to reach an answer.

```bash
npm run cli -- ls --topic finance --json | jq -r '.files[].relPath'
npm run cli -- ask "what did aria chen work on" --json | jq '.matches'
```

Colour is disabled automatically when stdout is not a TTY, and by `NO_COLOR` or
`--no-color`. Nothing is ever conveyed by colour alone.

Exit codes: `0` fine, `1` error, `2` unknown command, `4` out of model budget.

## Why TypeScript

The client and the routes import the same interfaces from
[`lib/api/types.ts`](../lib/api/types.ts), so a field renamed on one side is a
type error on both. Client/server drift is the ordinary way a CLI rots — a
column silently prints `undefined` and nobody notices — and sharing the types
removes the possibility rather than testing for it.
