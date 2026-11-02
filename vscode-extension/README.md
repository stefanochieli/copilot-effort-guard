# Copilot Effort Guard (estensione VS Code)

Voce nella status bar che mostra la serie di turni "faticosi" di Copilot letta dallo stato scritto dagli hook di [copilot-effort-guard](../README.md). Gli hook di Copilot non possono disegnare nulla: l'estensione legge lo stato e lo mostra.

- `effort 1/3`: 1 turno faticoso di fila su una soglia di 3. A soglia raggiunta la voce diventa gialla (`warning`) e compare una notifica.
- `effort -`: nessun dato per la cartella aperta.
- Clic sulla voce: riepilogo di tutti i progetti nel pannello *Output → Effort Guard*.

Funziona con la chat agente di VS Code e con la Copilot CLI lanciata nel terminale integrato (o in una sua sottocartella): conta la cartella di lavoro registrata dagli hook, non chi li ha chiamati.

## Installazione

Prima installa gli hook (`node scripts/install.mjs --user`, vedi [SETUP](../docs/SETUP.md)). Poi:

```
cd vscode-extension
npx --yes @vscode/vsce package --no-dependencies --skip-license
code --install-extension copilot-effort-guard-status-0.1.0.vsix --force
```

Se `code` non è nel PATH (Windows), usa il percorso completo (`%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd`) oppure *Extensions → … → Install from VSIX…* in VS Code. Poi ricarica la finestra (*Developer: Reload Window*).

## Impostazioni

| Impostazione | Default | Effetto |
|---|---|---|
| `effortGuard.copilotHome` | vuoto | Cartella che contiene `effort-guard/` (vuoto: `COPILOT_HOME` o `~/.copilot`) |
| `effortGuard.threshold` | 3 | Soglia di riserva: di norma si usa quella registrata dagli hook (`EFFORT_GUARD_THRESHOLD`) |
| `effortGuard.notify` | true | Notifica al raggiungimento della soglia |

L'indicatore si aggiorna ogni 2 secondi. Se resta `effort -` dopo aver usato Copilot, lancia `doctor` per controllare che gli hook girino.
