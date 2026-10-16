# copilot-effort-guard

Hook per **GitHub Copilot** (Copilot CLI e agent hooks di VS Code) che osserva i turni dell'agente e, dopo N turni "faticosi" consecutivi, avvisa di passare a un modello più forte o a più reasoning effort. Solo osservazione: non blocca mai un tool. Derivato dalla mod [claude-effort-guard](https://github.com/stefanochieli/claude-effort-guard) (ramo `feat/copilot-hooks`).

## Come funziona

- **Turno faticoso**: un tool fallito (`postToolUseFailure` o `resultType: "failure"`), un comando di test/build (`npm test`, `ng test`, `mvn`, `gradle`, `pytest`, `go test`…) il cui output contiene un fallimento anche con exit code 0, oppure lo stesso comando fallito due volte nel turno.
- **Escalation**: alla soglia (default 3) l'avviso va su stderr e viene offerto all'agente come `additionalContext`. Un turno pulito azzera la serie.
- **Stato**: `.effort-guard/state.json` (ignorato da git); cartella cambiabile con `EFFORT_GUARD_DIR`, soglia con `EFFORT_GUARD_THRESHOLD`.
- `npm run summary` stampa il riepilogo dei turni.

## Uso

Documentazione: [setup](docs/SETUP.md), [funzionamento](docs/FUNZIONAMENTO.md), [prove sul tuo Copilot](TESTING.md). In breve: `node scripts/install.mjs --user` (globale, CLI e VS Code) oppure `node scripts/install.mjs <repo>` (team).

Comandi: `summary`, `doctor` (stato e configurazione), `selftest` (verifica locale senza Copilot). Opzioni via ambiente: `EFFORT_GUARD_THRESHOLD`, `EFFORT_GUARD_DIR`, `EFFORT_GUARD_DEBUG=1` (salva i payload grezzi).

## Limiti

Niente banda sopra il prompt, toast o slash command (Copilot non li offre) e gli hook non espongono token/contesto. Supporta sia gli eventi della CLI (`userPromptSubmitted`, `postToolUse`, `errorOccurred`) sia quelli di VS Code (`UserPromptSubmit`, `PostToolUse`, riconosciuti da `hook_event_name`). I nomi dei campi sono stati ricavati dalla documentazione e non ancora verificati su una sessione reale: usa il dump dei payload per controllarli.

## Sviluppo

```
npm test
```

## Rilasci

Flusso: i rami di lavoro partono da `develop` e tornano su `develop` con PR (titolo in stile [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`…); quando la situazione è stabile si mergia la PR `develop` → `main` (merge commit, non squash).

Dopo il merge su `main`, [release-please](https://github.com/googleapis/release-please) legge i commit, calcola la versione (`fix:` → patch, `feat:` → minor, `feat!:` o `BREAKING CHANGE` → major) e apre la PR "chore: release X.Y.Z", che aggiorna `package.json` e `CHANGELOG.md`. Il workflow `release-please.yml` lancia la CI su quella PR; unendola (merge) vengono creati il tag `vX.Y.Z` e la GitHub Release. Non modificare a mano `version` né `CHANGELOG.md`.

Con il secret `RELEASE_PLEASE_TOKEN` (PAT o GitHub App con `contents` e `pull-requests` in scrittura) la PR di release si unisce da sola quando `checks` è verde (serve **Allow auto-merge** nelle impostazioni del repo) e il tag parte senza passaggi manuali. Senza il secret la PR di release va unita a mano. Settings → Actions → General → Workflow permissions: **Read and write** + **Allow GitHub Actions to create and approve pull requests**.

Dopo il merge della PR di release, riporta `main` su `develop` (PR `main` → `develop`) per non far divergere `package.json` e il changelog.
