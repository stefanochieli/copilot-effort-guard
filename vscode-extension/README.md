# Copilot Effort Guard

**Vedi a colpo d'occhio quanto sta faticando il modello di GitHub Copilot, e cosa fare: alzare il thinking, passare a un modello più potente o scendere a uno più leggero.**

Gli hook di [copilot-effort-guard](https://github.com/stefanochieli/copilot-effort-guard#readme) osservano i turni dell'agente Copilot (tool falliti, test che non passano, stesso comando fallito due volte), sia nella **Copilot Chat** (modalità agent) sia nella **Copilot CLI**, anche quando lavorano in parallelo nella stessa cartella. Gli hook non possono disegnare nulla in VS Code: questa estensione legge il loro stato e lo mostra in una barra colorata, in un pannello laterale e in notifiche.

| Il pannello a soglia raggiunta | Il pannello dopo molti turni puliti |
|---|---|
| ![Pannello Effort Guard: il modello fatica](https://raw.githubusercontent.com/stefanochieli/copilot-effort-guard/main/vscode-extension/media/screenshot-warn.png) | ![Pannello Effort Guard: il task è facile](https://raw.githubusercontent.com/stefanochieli/copilot-effort-guard/main/vscode-extension/media/screenshot-calm.png) |

## Cosa vedi

**Nella status bar**: `▰▱▱ 1/3` è una barra a segmenti, qui 1 turno faticoso di fila su una soglia di 3. Il colore cambia con lo stato:

| Stato | Aspetto | Cosa significa |
|---|---|---|
| Tutto ok | testo verde | nessuna fatica |
| Qualche fatica | sfondo giallo | almeno un turno faticoso |
| Soglia raggiunta | sfondo rosso | **alza il thinking / reasoning** |
| Il doppio della soglia | sfondo rosso | più thinking non è bastato: **passa a un modello più potente** |
| Molti turni puliti (default 8) | testo blu con ✓ | il task sembra facile: **scendi a un modello più leggero** o riduci il reasoning per risparmiare token |
| `effort -` | grigio | nessun dato per la cartella aperta |

**Nel pannello laterale** (icona *Effort Guard* nell'Activity Bar, o clic sulla voce di stato): barra grande colorata, avanzamento verso la serie di turni puliti, cronologia degli ultimi turni (verde pulito, rosso faticoso), suggerimento con un'etichetta sull'azione (*↑ Raise thinking*, *↑↑ Upgrade model*, *↓ Downgrade*), sessioni recenti e ultima attività.

**Chat e CLI affiancate**: se nella cartella lavorano sia la Copilot Chat sia la Copilot CLI, il pannello mostra due riquadri, *Chat* e *CLI*, ognuno con la sua serie, lo stato del turno e quando è arrivato l'ultimo hook. Barra, colore e consiglio seguono la corsia che ha più bisogno di attenzione (a pari livello, la più recente), e il consiglio dice a quale si riferisce. *Reset* azzera entrambe. Se il riquadro *Chat* non si aggiorna mentre la chat lavora, gli hook della chat non stanno arrivando: controlla con `node ~/.copilot/effort-guard/effort-guard.mjs doctor` (colonna `src=`).

**Nelle notifiche**: un avviso quando la serie raggiunge la soglia, uno al doppio e uno quando il task sembra facile, sempre con l'azione consigliata.

## Dopo aver cambiato modello o thinking

Premi **Reset** in fondo al pannello (o il comando *Effort Guard: Reset after changing model or thinking*): le serie ripartono da zero e la valutazione riguarda il nuovo modello. Gli hook non vedono il cambio di modello, quindi senza reset la serie continua a contare.

## Installare gli hook dall'estensione

Gli hook sono inclusi nell'estensione: comando *Effort Guard: Install or update the Copilot hooks* (o il pulsante nel pannello). Esegue l'installazione `--user` con Node.js 20+ preso dal PATH, senza clonare il repository. Se gli hook mancano o sono più vecchi dell'estensione, all'avvio te lo propone una volta.

## Soglie per progetto

Pulsante *Thresholds…* nel pannello (o *Effort Guard: Set thresholds for this project*): scrive `.effort-guard.json` nella cartella del progetto, letto dagli hook dal prossimo evento di Copilot. Puoi committarlo per dare le stesse soglie a tutto il team.

## Qualità del risultato

Sezione *Result quality* del pannello: punteggio degli ultimi turni calcolato da esito dei test, richieste di rifare nel prompt successivo, file ritoccati più volte e dal tuo voto. I pulsanti 👍 *Good result* / 👎 *Bad result* (o i comandi *Effort Guard: The last result was good/bad*) votano l'ultimo turno chiuso; un secondo clic toglie il voto. Il CSV esportato contiene anche questi campi.

## Storico

Il pannello mostra i turni degli ultimi 14 giorni (in rosso quelli faticosi) e i motivi più frequenti. *Effort Guard: Export history as CSV* esporta tutti i turni registrati di tutti i progetti (data, esito, motivo; nessun comando né output).

## Sessioni: chat e CLI

Funziona con la chat agente di VS Code e con la Copilot CLI lanciata nel terminale integrato (o in una sua sottocartella). Il consiglio indica da quale sessione viene (`CLI` o `Chat`) e il pannello elenca le sessioni recenti. Le serie sono contate **per cartella e per corsia**: la Chat ha la sua, la CLI la sua (condivisa dalle sessioni CLI di quella cartella): l'estensione non sa quale modello stai usando, osserva soltanto come vanno i turni.

## Requisiti

Gli hook vanno installati una volta per utente, prima dell'estensione:

```
git clone https://github.com/stefanochieli/copilot-effort-guard
node copilot-effort-guard/scripts/install.mjs --user
```

Funziona anche con l'installazione per repository (`install.mjs <repo>`): l'estensione legge pure `<cartella aperta>/.effort-guard/state.json`. Dettagli in [SETUP](https://github.com/stefanochieli/copilot-effort-guard/blob/main/docs/SETUP.md). Serve Node.js 20 o superiore per gli hook.

## Installazione dell'estensione

Dal Marketplace: cerca *Copilot Effort Guard* nelle estensioni, oppure

```
code --install-extension stefanochieli.copilot-effort-guard-status
```

Si aggiorna da sola. In alternativa il `.vsix` allegato a ogni [GitHub Release](https://github.com/stefanochieli/copilot-effort-guard/releases) (*Extensions → … → Install from VSIX…*) o la build da sorgente:

```
cd vscode-extension
npx --yes @vscode/vsce package --no-dependencies --skip-license
code --install-extension copilot-effort-guard-status-<versione>.vsix --force
```

Se `code` non è nel PATH (Windows), usa `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd`. Poi ricarica la finestra (*Developer: Reload Window*).

## Impostazioni

| Impostazione | Default | Effetto |
|---|---|---|
| `effortGuard.copilotHome` | vuoto | Cartella che contiene `effort-guard/` (vuoto: `COPILOT_HOME` o `~/.copilot`) |
| `effortGuard.threshold` | 3 | Soglia di riserva: di norma si usa quella registrata dagli hook (`EFFORT_GUARD_THRESHOLD`) |
| `effortGuard.notify` | true | Mostra le notifiche |

La soglia dei turni puliti si cambia con la variabile d'ambiente `EFFORT_GUARD_CALM` (default 8), letta dagli hook.

## Se qualcosa non va

- Resta `effort -` dopo aver usato Copilot: lancia `node ~/.copilot/effort-guard/effort-guard.mjs doctor` per controllare che gli hook girino.
- Il comando *Effort Guard: Show report* stampa il riepilogo di tutti i progetti nel pannello *Output → Effort Guard*.
- L'indicatore si aggiorna ogni 2 secondi.

Esiste anche un plugin per gli IDE JetBrains (IntelliJ IDEA e simili): vedi [`intellij-plugin/`](https://github.com/stefanochieli/copilot-effort-guard/tree/main/intellij-plugin).
