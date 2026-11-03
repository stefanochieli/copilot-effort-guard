# Copilot Effort Guard (estensione VS Code)

Voce nella status bar che mostra la serie di turni "faticosi" di Copilot letta dallo stato scritto dagli hook di [copilot-effort-guard](https://github.com/stefanochieli/copilot-effort-guard#readme). Gli hook di Copilot non possono disegnare nulla: l'estensione legge lo stato e lo mostra.

- `▰▱▱ 1/3`: barra a segmenti, 1 turno faticoso di fila su una soglia di 3. Il colore cambia con lo stato: verde (ok), blu (molti turni puliti), sfondo giallo (qualche fatica), sfondo rosso a soglia raggiunta, con una notifica che dice cosa fare, in due passi: a soglia raggiunta *alza il thinking / reasoning*; se i turni faticosi continuano fino al doppio della soglia, *passa a un modello più potente*.
- **Pannello laterale** (icona *Effort Guard* nell'Activity Bar, o clic sulla voce di stato): barra grande colorata, avanzamento verso la serie di turni puliti, cronologia colorata degli ultimi turni (verde pulito, rosso faticoso), suggerimento e sessione. Un'etichetta indica l'azione: *↑ Raise thinking*, *↑↑ Upgrade model*, *↓ Downgrade*.
- Icona con la spunta (`✓ effort 0/3`) dopo molti turni puliti di fila (default 8, `EFFORT_GUARD_CALM`): il task sembra semplice, la notifica dice di *scendere* a un modello più leggero o meno reasoning per risparmiare token.
- `effort -`: nessun dato per la cartella aperta.
- Comando *Effort Guard: Show report*: riepilogo di tutti i progetti nel pannello *Output → Effort Guard*.

Funziona con la chat agente di VS Code e con la Copilot CLI lanciata nel terminale integrato (o in una sua sottocartella): conta la cartella di lavoro registrata dagli hook, non chi li ha chiamati.

## Installazione

Dal Marketplace (dopo la pubblicazione): cerca *Copilot Effort Guard* nelle estensioni oppure `code --install-extension stefanochieli.copilot-effort-guard-status`; si aggiorna da sola. Altrimenti dal `.vsix` allegato a ogni [GitHub Release](https://github.com/stefanochieli/copilot-effort-guard/releases), oppure da sorgente:

Prima installa gli hook (`node scripts/install.mjs --user`, vedi [SETUP](https://github.com/stefanochieli/copilot-effort-guard/blob/main/docs/SETUP.md)). Poi:

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
