# Come funziona

effort-guard è un osservatore: non blocca né modifica nulla. Conta quanti turni consecutivi l'agente "fatica" e, alla soglia, suggerisce di passare a un modello più forte o a più reasoning effort.

## Eventi usati

Copilot esegue lo script come hook, con il payload JSON su stdin.

| Evento CLI | Evento VS Code | Azione |
|---|---|---|
| `userPromptSubmitted` | `UserPromptSubmit` | Chiude il turno precedente, aggiorna la serie e il registro |
| `postToolUse` | `PostToolUse` | Valuta l'esito del tool; consegna l'avviso in sospeso |
| `postToolUseFailure`, `errorOccurred` | — | Segna il turno come faticoso |

L'evento è letto da `hook_event_name` quando c'è (VS Code), altrimenti dall'argomento nel file di configurazione (`prompt`, `tool`, `failure`).

## Cos'è un turno faticoso

Un turno è tutto ciò che accade tra due prompt dell'utente. È faticoso se:

1. un tool fallisce (`resultType: "failure"` o evento di errore);
2. un comando shell di test/build (`npm test`, `ng test`, `mvn`, `gradle`, `pytest`, `go test`, `cargo`, `dotnet`, `make`, `tsc`…) stampa un fallimento anche con exit code 0 (`FAIL`, `N failing`, `BUILD FAILURE`…). Comandi come `cat build.log` o `grep FAIL` non contano;
3. lo stesso comando fallisce due volte nel turno (motivo registrato: `repeated_error`).

Un turno senza fallimenti azzera la serie.

## Avviso

Quando la serie raggiunge la soglia (default 3), una sola volta per serie:

1. l'hook del prompt salva l'avviso come "in sospeso" e lo scrive su stderr;
2. al primo evento di tool successivo viene emesso in JSON: `systemMessage` per l'utente e `hookSpecificOutput.additionalContext` per l'agente, perché VS Code non accetta contesto dall'hook del prompt.

Il testo suggerisce di cambiare modello o aumentare l'effort; il cambio lo fai tu.

## Stato e privacy

Il registro (ultimi 500 turni: ora, esito, motivo, serie) e lo stato del turno sono in un file `state.json` locale. Nulla viene inviato all'esterno. Il dump opzionale `payloads.jsonl` contiene comandi e output dei tool: non condividerlo senza controllarlo.

## Robustezza

Gli errori dello script finiscono su stderr e non interrompono mai l'agente. I nomi dei campi sono letti in modo tollerante (camelCase e snake_case).

## Struttura del codice

- `src/effort-guard.mjs`: transizioni di stato pure (`onTool`, `closeTurn`, `run`) e wrapper di I/O.
- `src/detect.mjs`: riconoscimento dei comandi di test e dei testi di fallimento.
- `scripts/install.mjs`: installazione utente/repository e disinstallazione.
- `tests/`: `npm test` (Node test runner).

## Limiti noti

Niente banda sopra il prompt, toast o slash command, e nessun dato su token e contesto: gli hook non li espongono. I campi del payload vanno ancora confermati su sessioni reali (vedi [TESTING.md](../TESTING.md)).
