# Setup

## Requisiti

- Node >= 20 nel PATH (`node --version`), sia per il terminale sia per VS Code.
- Copilot CLI recente e/o VS Code con gli agent hooks (anteprima). Sul Copilot aziendale gli hook possono essere disattivati da una policy dell'organizzazione.

## Installazione globale (utente) — CLI e VS Code

```
git clone https://github.com/stefanochieli/copilot-effort-guard
cd copilot-effort-guard
node scripts/install.mjs --user
```

Cosa fa: copia `effort-guard.mjs` e `detect.mjs` in `~/.copilot/effort-guard/` e scrive `~/.copilot/hooks/effort-guard.json`, con il percorso assoluto dello script (su Windows `%USERPROFILE%\.copilot\...`). Vale per tutti i progetti. Lo stato non finisce nei repository: sta in `~/.copilot/effort-guard/state/<cartella>`, una cartella per ogni directory di lavoro.

Poi:

1. **Copilot CLI**: riavvia la CLI (`copilot`). Gli hook utente di `~/.copilot/hooks/*.json` vengono letti all'avvio.
2. **VS Code**: ricarica la finestra (*Developer: Reload Window*) e usa la chat in modalità agente. Se gli hook utente non vengono caricati, aggiungi la cartella nelle impostazioni (il nome esatto va controllato nella pagina *Agent hooks* di VS Code; di solito `chat.hookFilesLocations`) oppure usa l'installazione per repository qui sotto.
3. Verifica: `node ~/.copilot/effort-guard/effort-guard.mjs doctor` e, in VS Code, *Developer: Show Agent Debug Logs* per vedere se l'hook è stato eseguito.

Disinstallazione: `node scripts/install.mjs --user --uninstall`.

## Installazione per repository (team)

```
node scripts/install.mjs /percorso/del/repo
```

Crea `.effort-guard-hooks/` e `.github/hooks/effort-guard.json` nel repository: committali e il team li riceve col normale `git pull`. Lo stato locale è in `.effort-guard/` (già da aggiungere al `.gitignore` del repo).

## Configurazione

Variabili d'ambiente (nel profilo della shell o nelle impostazioni dell'ambiente di VS Code):

| Variabile | Default | Effetto |
|---|---|---|
| `EFFORT_GUARD_THRESHOLD` | `3` | Turni faticosi consecutivi prima dell'avviso |
| `EFFORT_GUARD_DIR` | vedi sopra | Cartella dello stato |
| `EFFORT_GUARD_DEBUG` | spento | Con `1` salva i payload grezzi in `payloads.jsonl` |

## Comandi utili

```
node ~/.copilot/effort-guard/effort-guard.mjs doctor     # configurazione e riepilogo
node ~/.copilot/effort-guard/effort-guard.mjs summary    # riepilogo dei turni
node ~/.copilot/effort-guard/effort-guard.mjs selftest   # prova locale senza Copilot
```

## Aggiornare

`git pull` nel clone e ripeti `node scripts/install.mjs --user`: sovrascrive i file installati.

## Verificare che sia attivo

Copilot non permette a un hook di disegnare una barra o una notifica, quindi non c'è nulla di visibile finché non scatta l'avviso. Per vedere che gli hook girano:

```
node ~/.copilot/effort-guard/effort-guard.mjs doctor   # file hook trovato, ultime chiamate, stato di ogni progetto
node ~/.copilot/effort-guard/effort-guard.mjs status   # stato della cartella corrente in una riga
node ~/.copilot/effort-guard/effort-guard.mjs watch    # vista live in un secondo terminale
```

Ogni chiamata di un hook aggiunge una riga a `~/.copilot/effort-guard/events.log` (ora, evento, nome del tool, cartella; mai il contenuto), e anche gli avvisi (`WARNING`) finiscono lì. `doctor` mostra tutti i progetti, non solo la cartella da cui lo lanci: lo stato è per directory di lavoro, quindi lanciato dal repo di effort-guard non vede la tua sessione su un altro progetto.

## Problemi comuni

- **`doctor` dice "no hook call recorded yet"**: riavvia Copilot CLI (gli hook si leggono all'avvio, una sessione già aperta non li vede), manda un prompt che faccia usare un tool e ripeti `doctor`. Se resta vuoto, la CLI non carica `~/.copilot/hooks` (versione, `COPILOT_HOME`, policy): lancia `copilot` con `COPILOT_HOME` impostato come in `doctor` e controlla la versione.
- **Gli hook girano ma non vedi l'avviso**: secondo la documentazione GitHub l'output degli hook `userPromptSubmitted` definiti in file viene ignorato dalla CLI, e non è chiaro dove finisca stderr. L'avviso è comunque in `events.log` e in `watch`.
- **Turni registrati ma nessun avviso visibile**: il client non mostra stderr o `additionalContext`; l'avviso resta nel riepilogo.
- **Falsi positivi**: alza `EFFORT_GUARD_THRESHOLD`.
- **Verifica dei payload reali**: vedi [TESTING.md](../TESTING.md).
