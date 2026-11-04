# copilot-effort-guard

Hook per **GitHub Copilot** (Copilot CLI e agent hooks di VS Code) che osserva i turni dell'agente e, dopo N turni "faticosi" consecutivi, avvisa di passare a un modello più forte o a più reasoning effort. Solo osservazione: non blocca mai un tool. Derivato dalla mod [claude-effort-guard](https://github.com/stefanochieli/claude-effort-guard) (ramo `feat/copilot-hooks`).

## Come funziona

- **Turno faticoso**: un tool fallito (`postToolUseFailure` o `resultType: "failure"`), un comando di test/build (`npm test`, `ng test`, `mvn`, `gradle`, `pytest`, `go test`…) il cui output contiene un fallimento anche con exit code 0, oppure lo stesso comando fallito due volte nel turno.
- **Escalation**: alla soglia (default 3) l'avviso va su stderr e viene offerto all'agente come `additionalContext`. Un turno pulito azzera la serie.
- **Stato**: `.effort-guard/state.json` (ignorato da git); cartella cambiabile con `EFFORT_GUARD_DIR`, soglia con `EFFORT_GUARD_THRESHOLD`.
- `npm run summary` stampa il riepilogo dei turni.

## Uso

Documentazione: [setup](docs/SETUP.md), [funzionamento](docs/FUNZIONAMENTO.md), [prove sul tuo Copilot](TESTING.md). In breve: `node scripts/install.mjs --user` (globale, CLI e VS Code) oppure `node scripts/install.mjs <repo>` (team).

Barra nella status bar di VS Code: estensione in [`vscode-extension/`](vscode-extension/README.md). Lo stesso indicatore per IntelliJ IDEA e gli altri IDE JetBrains: plugin in [`intellij-plugin/`](intellij-plugin/README.md). Comandi: `summary`, `doctor` (report leggibile: setup, ultime chiamate, avvisi, tabella dei progetti), `selftest` (verifica locale senza Copilot), `reset` (azzera le serie dopo aver cambiato modello o thinking; nell'estensione c'è il pulsante *Reset* nel pannello e il comando *Effort Guard: Reset…*). Opzioni via ambiente: `EFFORT_GUARD_THRESHOLD`, `EFFORT_GUARD_DIR`, `EFFORT_GUARD_DEBUG=1` (salva i payload grezzi).

## Limiti

Niente banda sopra il prompt, toast o slash command (Copilot non li offre) e gli hook non espongono token/contesto. Supporta sia gli eventi della CLI (`userPromptSubmitted`, `postToolUse`, `errorOccurred`) sia quelli di VS Code (`UserPromptSubmit`, `PostToolUse`, riconosciuti da `hook_event_name`). I nomi dei campi sono stati ricavati dalla documentazione e non ancora verificati su una sessione reale: usa il dump dei payload per controllarli.

## Sviluppo

```
npm test
```

## Rilasci

Flusso: i rami di lavoro partono da `develop` e tornano su `develop` con PR (titolo in stile [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`…); quando la situazione è stabile si mergia la PR `develop` → `main` (merge commit, non squash).

Dopo il merge su `main`, [release-please](https://github.com/googleapis/release-please) legge i commit, calcola la versione (`fix:` → patch, `feat:` → minor, `feat!:` o `BREAKING CHANGE` → major) e apre la PR "chore: release X.Y.Z", che aggiorna `package.json`, `vscode-extension/package.json` (stessa versione) e `CHANGELOG.md`. Il workflow `auto-release.yml` lancia la CI su quella PR; unendola (merge) vengono creati il tag `vX.Y.Z` e la GitHub Release. Non modificare a mano `version` né `CHANGELOG.md`. La configurazione sta in `release-config.json` e `release-manifest.json`. Il nome del ramo della PR di release (`release-please--branches--…`) è fissato dallo strumento e non si può cambiare.

Con il secret `RELEASE_PLEASE_TOKEN` (PAT o GitHub App con `contents` e `pull-requests` in scrittura) la PR di release si unisce da sola quando `checks` è verde (serve **Allow auto-merge** nelle impostazioni del repo) e il tag parte senza passaggi manuali. Senza il secret la PR di release va unita a mano. Settings → Actions → General → Workflow permissions: **Read and write** + **Allow GitHub Actions to create and approve pull requests**.

Dopo il merge della PR di release, riporta `main` su `develop` (PR `main` → `develop`) per non far divergere `package.json` e il changelog.

### Estensione VS Code: pubblicazione

A ogni release il job `publish-extension` costruisce il `.vsix` e lo allega alla GitHub Release. Se nei secret del repo c'è `VSCE_PAT`, lo pubblica anche sul Visual Studio Marketplace (identificativo `stefanochieli.copilot-effort-guard-status`), da cui VS Code lo aggiorna da solo.

Una tantum, a cura del proprietario del repo:

1. Crea il publisher `stefanochieli` su <https://marketplace.visualstudio.com/manage> (serve un account Microsoft; l'ID deve coincidere con `publisher` in `vscode-extension/package.json`).
2. Crea su <https://dev.azure.com> un Personal Access Token con organizzazione **All accessible organizations** e scope **Marketplace → Manage**.
3. Salvalo come secret del repo `VSCE_PAT` (Settings → Secrets and variables → Actions).

Alla release successiva l'estensione comparirà sul Marketplace. Senza il secret il job allega solo il `.vsix`.

### Plugin IntelliJ: build e allegato

La CI (`checks` non ne dipende, il job si chiama `intellij-plugin`) compila e prova il plugin con Gradle. A ogni release il job `publish-intellij-plugin` costruisce lo zip e lo allega alla GitHub Release; la versione in `intellij-plugin/gradle.properties` è aggiornata da release-please insieme alle altre. Se nei secret c'è `JETBRAINS_PUBLISH_TOKEN`, il job pubblica lo zip anche sul JetBrains Marketplace (`publishPlugin`; il primo upload della scheda è manuale, ogni versione passa da una revisione JetBrains).
