# copilot-effort-guard

Hook per **GitHub Copilot** che osserva i turni dell'agente e, dopo N turni "faticosi" consecutivi, avvisa di passare a un modello più forte o a più reasoning effort. Funziona con la **Copilot Chat in modalità agent di VS Code** e con la **Copilot CLI**, anche in parallelo nella stessa cartella: ognuna ha la sua serie. Solo osservazione: non blocca mai un tool. Derivato dalla mod [claude-effort-guard](https://github.com/stefanochieli/claude-effort-guard) (ramo `feat/copilot-hooks`).

## Come funziona

- **Turno faticoso**: un tool fallito (`postToolUseFailure` o `resultType: "failure"`), un comando di test/build (`npm test`, `ng test`, `mvn`, `gradle`, `pytest`, `go test`…) il cui output contiene un fallimento anche con exit code 0, un comando shell con exit code diverso da 0 (letto da `exitCode`/`exit_code` o dal testo "exit code N"; ignorato per `grep`, `diff`, `test`…), oppure lo stesso comando fallito due volte nel turno. Se nello stesso turno un comando di test/build riesce dopo un fallimento (rosso poi verde) il turno non conta come faticoso (`EFFORT_GUARD_RED_GREEN=0` lo disattiva).
- **Escalation**: alla soglia (default 3) l'avviso va su stderr e viene offerto all'agente come `additionalContext`. Un turno pulito azzera la serie.
- **Cosa non conta**: errori che non dicono nulla sulla difficoltà del task, elencati in [`src/benign.mjs`](src/benign.mjs): `view_range out of bounds`, `too large, not read`, comandi rifiutati da una regola (`--deny-tool`, "Permission to run this tool was denied"). Un comando non installato (exit 9009/127, "Python non è stato trovato") viene perdonato una volta per turno; il secondo conta. Le sonde "esiste?" (`Get-ChildItem`, `Test-Path`, `ls`, `dir`…) non contano l'exit code. Un fallimento di test/build vero conta sempre. Per repository si aggiungono voci in `.effort-guard.json`: `"benignErrors": ["PLAN_MISMATCH"]` (testo nell'output) e `"probeCommands": ["javap"]` (prima parola del comando).
- **Test verdi**: se l'ultimo comando di test/build del turno è verde, il turno non è faticoso anche se prima qualcosa è fallito, e la serie si azzera (nel log resta il motivo in `cleared`).
- **Nuovo episodio**: se nella stessa corsia passano più di 30 minuti senza eventi, il prompt successivo riparte da serie 0, così due fatiche a ore di distanza non si sommano. Soglia in `.effort-guard.json` (`"gapMinutes": 30`, `0` disattiva) o `EFFORT_GUARD_GAP_MINUTES`. Con `"resetOnSessionChange": true` (o `EFFORT_GUARD_RESET_ON_SESSION=1`) la serie riparte anche quando cambia la sessione; è spento di default perché nella CLI ogni agente di una coda (`copilot -p`) è una sessione a sé e si perderebbe una coda che fallisce agente dopo agente.
- **Stato**: `.effort-guard/state.json` (l'installazione per repository aggiunge `.effort-guard/` al `.gitignore` del repo, salvo `--no-gitignore`); cartella cambiabile con `EFFORT_GUARD_DIR`, soglia con `EFFORT_GUARD_THRESHOLD`. Soglie per progetto: `.effort-guard.json` (`{"threshold": 4, "calmThreshold": 10}`) nella cartella o in una cartella superiore, scritto anche dalle estensioni e committabile per condividerlo col team; le variabili d'ambiente hanno la precedenza.
- **Chat e CLI in parallelo**: ogni cartella ha due corsie, *Chat* (agent di VS Code) e *CLI* (Copilot CLI, anche lanciata dal terminale di VS Code o da un agente). Ognuna ha il suo turno aperto, la sua serie e la sua serie pulita, quindi un prompt della CLI non chiude il turno della Chat. Il log dei turni è comune e ogni voce dice da quale corsia viene. La sorgente si riconosce dal payload (nome dell'evento, campi in snake_case, `transcript_path`) e dall'ambiente dell'extension host di VS Code; `payloads` e `doctor` (`src=`) mostrano cosa è stato rilevato.
- **Storico per canale**: il pannello dell'estensione ha la sezione *By channel* con, per Chat e CLI, turni, quota faticosa, qualità del risultato, cause principali e storico a parte, così il modello di ciascuno si sceglie sui propri numeri. Il canale si riconosce dal formato del payload, dall'ambiente di VS Code e dai nomi dei tool (`read_file`, `grep_search`, `run_in_terminal`… sono della Chat); una sessione vista come Chat resta Chat anche per i suoi prompt. I turni registrati prima della 0.12.0 non hanno canale e stanno nella riga *Before the split*. Se la Chat non compare mai, `doctor` mostra la colonna *source* di ogni chiamata. Una cattura reale ha mostrato solo chiamate della CLI: la Chat di VS Code non carica `~/.copilot/hooks`. Il pannello Chat di VS Code che apre sessioni *Copilot CLI* (agente, "Run on: This computer") esegue la CLI stessa: i suoi turni arrivano come `cli` (senza `TERM_PROGRAM`) e il terminale integrato come `cli@vscode`; entrambi finiscono nella corsia CLI, e con zero turni Chat il pannello nasconde la riga Chat e mostra una nota neutra invece dell'avviso. Per tracciarla installa nel progetto (`node scripts/install.mjs <cartella-repo>`, crea `.github/hooks/effort-guard.json`) oppure aggiungi la cartella degli hook a `chat.hookFilesLocations`, poi controlla Output → *GitHub Copilot Chat Hooks*. Dall'estensione VS Code basta il comando *Effort Guard: Enable the hooks for Copilot Chat* (o il pulsante *Enable Chat hooks* nel pannello): installa gli hook se mancano e aggiunge `~/.copilot/hooks` a `chat.hookFilesLocations`.
- `npm run summary` stampa il riepilogo dei turni.

## Qualità del risultato

Accanto allo sforzo, ogni turno chiuso registra segnali sulla qualità del risultato (non cambiano la serie):

- **test**: esito dell'ultimo comando di test/build del turno (`green` / `red`);
- **rilavorazione**: il prompt successivo chiede di correggere o rifare ("non funziona", "rifai", "still failing", "revert"…); il testo del prompt viene solo classificato, mai salvato;
- **ritocchi**: file modificati di nuovo che uno dei 3 turni precedenti aveva già modificato (si salvano hash brevi dei percorsi, non i percorsi);
- **voto**: 👍/👎 dal pannello delle estensioni, che prevale sugli altri segnali.

Punteggio per turno: 100% meno 50 per test rossi, 40 per rilavorazione, 20 per ritocchi; il pannello mostra la media degli ultimi 20 turni con un segnale (buona ≥ 75%, mista ≥ 50%). I nomi dei tool di modifica non sono ancora confermati su una cattura reale: `payloads` li mostra.

## Uso

Documentazione: [setup](docs/SETUP.md), [funzionamento](docs/FUNZIONAMENTO.md), [prove sul tuo Copilot](TESTING.md). In breve: `node scripts/install.mjs --user` (globale, CLI e VS Code) oppure `node scripts/install.mjs <repo>` (team).

Barra nella status bar di VS Code: estensione in [`vscode-extension/`](vscode-extension/README.md). Lo stesso indicatore per IntelliJ IDEA e gli altri IDE JetBrains: plugin in [`intellij-plugin/`](intellij-plugin/README.md). Comandi: `summary`, `doctor` (report leggibile: setup, ultime chiamate, avvisi, tabella dei progetti), `selftest` (verifica locale senza Copilot), `payloads` (riassunto dei payload catturati con `EFFORT_GUARD_DEBUG=1`: solo nomi di campi e tipi, nessun valore; mostra anche l'origine rilevata, Chat o CLI, e i nomi delle variabili d'ambiente usate per riconoscerla), `reset` (azzera le serie dopo aver cambiato modello o thinking; nell'estensione c'è il pulsante *Reset* nel pannello e il comando *Effort Guard: Reset…*). Opzioni via ambiente: `EFFORT_GUARD_THRESHOLD`, `EFFORT_GUARD_DIR`, `EFFORT_GUARD_DEBUG=1` (salva i payload di ogni evento, con segreti oscurati: token, password, header Authorization; `raw` li salva senza oscuramento).

## Limiti

Niente banda sopra il prompt, toast o slash command (Copilot non li offre) e gli hook non espongono token/contesto. Supporta sia gli eventi della CLI (`userPromptSubmitted`, `postToolUse`, `errorOccurred`) sia quelli di VS Code (`UserPromptSubmit`, `PostToolUse`, riconosciuti da `hook_event_name`). I nomi dei campi sono stati ricavati dalla documentazione e non ancora verificati su una sessione reale: usa il dump dei payload per controllarli (le fixture in `tests/fixtures/` sono costruite dagli schemi documentati, non catturate). Verificato dal vivo finora solo che gli hook partono su VS Code (2026-11-02). In particolare non è confermato dove Copilot metta l'exit code di un comando: oggi un comando con exit code diverso da 0 conta solo se l'evento è un fallimento o se è un comando di test con output di fallimento. Se lo stesso hook è registrato due volte (file utente e file del repo) il duplicato viene scartato solo quando il payload ha sessione e timestamp.

## Sviluppo

```
npm test
```

## Rilasci

Flusso: i rami di lavoro partono da `develop` e tornano su `develop` con PR (titolo in stile [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`…); quando la situazione è stabile si mergia la PR `develop` → `main` (merge commit, non squash).

La versione si decide a mano, con lo stesso flusso degli altri repo: workflow **prepare-release** (Actions → prepare-release → Run workflow, scegli `patch`/`minor`/`major` e, se vuoi, le note). Aggiorna `CHANGELOG.md` (note dai commit dall'ultimo tag, raggruppati per `feat`/`fix`/altro), `package.json`, `vscode-extension/package.json` e `intellij-plugin/gradle.properties`, committa su `develop` e apre la PR `develop` → `main` "Release vX.Y.Z". Il workflow **release-guard** controlla sulle PR verso `main` che la versione in testa al changelog sia nuova e maggiore dell'ultimo tag. Unendo la PR con merge commit, il workflow **release** crea il tag `vX.Y.Z` e la GitHub Release dalla voce in testa a `CHANGELOG.md`, poi lancia i job di pubblicazione. Si può rilanciare a mano (Actions → release → Run workflow) se il tag non è comparso. Non modificare a mano `version` né `CHANGELOG.md` fuori da `prepare-release`. Gli script stanno in `.github/scripts/` (`bump-version.mjs`, `check-release-version.mjs`; `node .github/scripts/bump-version.mjs minor` funziona anche in locale).

Per far partire i check sulla PR creata da `prepare-release` serve il secret `RELEASE_PAT` (PAT con `contents` e `pull-requests` in scrittura): le PR create con `GITHUB_TOKEN` non attivano altri workflow. Settings → Actions → General → Workflow permissions: **Read and write** + **Allow GitHub Actions to create and approve pull requests**.

Dopo il merge `develop` → `main`, `develop` e `main` sono già allineate; se il workflow `sync-develop` apre una PR `main` → `develop`, uniscila.

### Estensione VS Code: pubblicazione

A ogni release il job `publish-extension` costruisce il `.vsix` e lo allega alla GitHub Release. Se nei secret del repo c'è `VSCE_PAT`, lo pubblica anche sul Visual Studio Marketplace (identificativo `stefanochieli.copilot-effort-guard-status`), da cui VS Code lo aggiorna da solo.

Una tantum, a cura del proprietario del repo:

1. Crea il publisher `stefanochieli` su <https://marketplace.visualstudio.com/manage> (serve un account Microsoft; l'ID deve coincidere con `publisher` in `vscode-extension/package.json`).
2. Crea su <https://dev.azure.com> un Personal Access Token con organizzazione **All accessible organizations** e scope **Marketplace → Manage**.
3. Salvalo come secret del repo `VSCE_PAT` (Settings → Secrets and variables → Actions).

Alla release successiva l'estensione comparirà sul Marketplace. Senza il secret il job allega solo il `.vsix`.

### Plugin IntelliJ: build e allegato

La CI (`checks` non ne dipende, il job si chiama `intellij-plugin`) compila e prova il plugin con Gradle. A ogni release il job `publish-intellij-plugin` costruisce lo zip e lo allega alla GitHub Release; la versione in `intellij-plugin/gradle.properties` è aggiornata da `prepare-release` insieme alle altre. Se nei secret c'è `JETBRAINS_PUBLISH_TOKEN`, il job pubblica lo zip anche sul JetBrains Marketplace (`publishPlugin`; il primo upload della scheda è manuale, ogni versione passa da una revisione JetBrains).
