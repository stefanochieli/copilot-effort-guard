# copilot-effort-guard

Hook per **GitHub Copilot** (Copilot CLI e agent hooks di VS Code) che osserva i turni dell'agente e, dopo N turni "faticosi" consecutivi, avvisa di passare a un modello più forte o a più reasoning effort. Solo osservazione: non blocca mai un tool. Derivato dalla mod [claude-effort-guard](https://github.com/stefanochieli/claude-effort-guard) (ramo `feat/copilot-hooks`).

## Come funziona

- **Turno faticoso**: un tool fallito (`postToolUseFailure` o `resultType: "failure"`), un comando di test/build (`npm test`, `ng test`, `mvn`, `gradle`, `pytest`, `go test`…) il cui output contiene un fallimento anche con exit code 0, oppure lo stesso comando fallito due volte nel turno.
- **Escalation**: alla soglia (default 3) l'avviso va su stderr e viene offerto all'agente come `additionalContext`. Un turno pulito azzera la serie.
- **Stato**: `.effort-guard/state.json` (ignorato da git); cartella cambiabile con `EFFORT_GUARD_DIR`, soglia con `EFFORT_GUARD_THRESHOLD`.
- `npm run summary` stampa il riepilogo dei turni.

## Uso

Copia `src/` e `.github/hooks/effort-guard.json` nel repository dove usi Copilot (Node >= 20 richiesto).

## Limiti

Niente banda sopra il prompt, toast o slash command (Copilot non li offre) e gli hook non espongono token/contesto. I nomi dei campi del payload e l'uso di `additionalContext` non sono verificati su una sessione Copilot reale: prima dell'uso va provato. `postToolUseFailure` potrebbe non esistere in tutte le versioni; in tal caso conta `resultType`.

## Sviluppo

```
npm test
```
