# Making this repository private

LeRoutier is public during development and will be made private before launch.
This file records what actually changes when that happens, so the switch is a
decision rather than a surprise.

It deliberately contains no credentials, no project identifiers and no
production internals. Everything below is verified platform behaviour from the
vendors' own documentation, not recollection.

**Nothing here is a security control.** The application is built to be safe
against somebody who has read every line of it: authorization is server-side,
secrets are never in the repository or the browser bundle, and no rule depends
on an attacker not knowing a route name. Going private reduces how cheaply the
product can be *copied*. It does not reduce how carefully it must be written.

## What keeps working

**Vercel deployments.** Vercel for GitHub supports GitHub Free, Team and
Enterprise accounts, with no public/private distinction. The GitHub App already
holds repository access, so pushes keep deploying exactly as they do now. No
project needs reconnecting.

**GitHub Actions.** Workflows keep running. Billing changes — see below.

**Dependabot** security and version updates work on private repositories.

## What changes

### CodeQL stops

GitHub's documentation is explicit: code scanning is available for public
repositories on GitHub.com, and for organization-owned repositories on Team,
Enterprise Cloud or Enterprise Server with GitHub Code Security enabled — *"If
you want to use code scanning on private repositories, you need a GitHub Code
Security license."*

So on a personal account with a private repository, **the CodeQL workflow will
stop producing results**. Three honest options, in order of preference:

1. Accept the loss and keep the CI suite as the gate. CodeQL has never been the
   thing catching defects in this codebase; the database, API and browser
   suites have.
2. Move the repository to an organization and buy GitHub Code Security.
3. Run a third-party SARIF-producing scanner in CI. Uploading SARIF to the
   Security tab has the same licensing constraint, so this means reading the
   tool's own output in the workflow log rather than in GitHub's UI.

Decide before privatizing, and remove the CodeQL workflow rather than leaving
one that silently reports nothing. **A green check that checks nothing is worse
than no check** — it is the same failure as the capacity dashboard that showed
"protection available" while the protection was unarmed.

### Actions minutes become metered

*"GitHub Actions usage is free for self-hosted runners and for public
repositories that use standard GitHub-hosted runners. For private repositories,
each GitHub account receives a quota of free minutes ... Any usage beyond the
included amounts is billed to your account."*

The suite is not small: lint, typecheck, build, unit, secret scan, dependency
audit, plus database and browser jobs. Before switching, check the account's
included minutes against a week of real usage. If the allowance is tight, the
first thing to cut is running the full browser matrix on every push to a
branch, not the database suite.

The secret scan clones with `fetch-depth: 0` because it walks the whole
history. That cost does not change, and it should not be traded away.

### Collaborator and access review

Public forks and clones already exist and stay wherever they are. Privatizing
is not retroactive. Before the switch:

- Review who has repository access; on a private repository every collaborator
  is a deliberate grant rather than an incidental one.
- Confirm branch protection and any rulesets still apply — ruleset behaviour
  differs by plan on private repositories, so re-read the settings page after
  the switch rather than assuming they carried over.
- Re-check that Actions secrets and the Vercel integration survived, by
  pushing one no-op commit and watching it deploy.

## Public history

`pnpm secrets:check` walks the full git history, not just the working tree, and
runs in CI on every push. It is the standing answer to "did a credential ever
land in this repository". Run it once more immediately before privatizing and
record the result.

Privatizing does **not** retract anything already published. Any credential
that reached a public commit must be treated as disclosed and rotated, whatever
the repository's visibility becomes afterwards.

## What must stay out, public or private

These rules do not relax when the repository becomes private. A private
repository is one compromised laptop away from being a public one.

- No credentials, tokens or connection strings, including in examples.
- No real KYC documents, identity references or production exports.
- No production incident data or passenger records.
- `.env*` files stay ignored; `.env.example` carries names and never values.
- No source maps in the production bundle (`build.sourcemap` is `false`, and
  the secret scan fails the build if a `.map` appears in `dist`).
