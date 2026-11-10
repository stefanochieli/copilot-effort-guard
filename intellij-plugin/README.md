# Copilot Effort Guard per IntelliJ (e gli altri IDE JetBrains)

Mostra quanto sta faticando il modello di GitHub Copilot, con consigli su cosa fare: alzare il thinking, passare a un modello più potente o scendere a uno più leggero. È l'equivalente per la IntelliJ Platform dell'[estensione VS Code](../vscode-extension/README.md): non calcola niente, legge lo stato scritto dagli hook di [copilot-effort-guard](../README.md) in `~/.copilot/effort-guard/state/<hash>/state.json` (installazione `--user`) oppure in `<progetto>/.effort-guard/state.json` (installazione per repository).

> Stato: prima versione. Il codice è compilato e provato dalla CI (Gradle, IntelliJ Platform 2024.2), ma è stato scritto senza poter aprire un IDE: se qualcosa nell'interfaccia non torna, segnalalo con uno screenshot.

## Cosa mostra

- **Status bar**: `🟢 ▰▱▱ 1/3`, una barra a segmenti (turni faticosi di fila su una soglia di 3) con un pallino colorato: ⚪ nessun dato, 🟢 ok, 🔵 molti turni puliti, 🟡 qualche fatica, 🔴 soglia raggiunta. Un clic apre la tool window. Il tooltip riassume i numeri.
- **Tool window "Effort Guard"** (a destra): barra grande colorata, avanzamento verso la serie di turni puliti, cronologia degli ultimi turni (verde pulito, rosso faticoso), consiglio con etichetta (*↑ Raise thinking*, *↑↑ Upgrade model*, *↓ Downgrade*), sessioni recenti della cartella (CLI o Chat), cartella e ultima attività.
- **Notifiche** (balloon *Effort Guard*) quando la serie raggiunge la soglia, il doppio della soglia, o quando il task sembra facile.
- **Reset**: pulsante nella tool window e voce *Tools | Effort Guard: Reset After Changing Model or Thinking*. Da usare dopo aver cambiato modello o thinking: le serie ripartono da zero (la cronologia resta).

Il consiglio in due passi è lo stesso dell'estensione VS Code: a soglia raggiunta *alza il thinking / reasoning*; se i turni faticosi continuano fino al doppio della soglia, *passa a un modello più potente*; dopo molti turni puliti (default 8, `EFFORT_GUARD_CALM`) *scendi a un modello più leggero*.

## Requisiti

1. Gli hook installati: `node scripts/install.mjs --user` (vedi [SETUP](../docs/SETUP.md)).
2. Un IDE basato sulla IntelliJ Platform 2024.2 o successiva (IntelliJ IDEA, Android Studio, WebStorm, PyCharm, ...) con Java 21 (già incluso nell'IDE).
3. Copilot che gli hook li esegua davvero. Per sapere se succede con la tua configurazione, usa Copilot per qualche richiesta e lancia in un terminale:
   ```
   node ~/.copilot/effort-guard/effort-guard.mjs doctor
   ```
   Se tra le chiamate compaiono quelle fatte dall'IDE, gli hook girano. Con la **Copilot CLI** lanciata nel terminale integrato dell'IDE funziona di sicuro; per l'agente di Copilot dentro l'IDE JetBrains dipende dal supporto agli hook della versione che usi: se `doctor` non vede nulla, il plugin resta su `Effort -`.

La cartella dello stato è `~/.copilot` oppure quella della variabile d'ambiente `COPILOT_HOME`. Il plugin usa la cartella principale del progetto aperto (e le sue sottocartelle, dove può essere stata avviata la CLI).

## Installazione

Dalle [GitHub Release](https://github.com/stefanochieli/copilot-effort-guard/releases): scarica `copilot-effort-guard-intellij-<versione>.zip`, poi in IntelliJ *Settings | Plugins | ⚙ | Install Plugin from Disk…* e riavvia l'IDE. In alternativa cerca *Copilot Effort Guard* in *Settings | Plugins | Marketplace* (aggiornamenti automatici).

Da sorgente:

```
cd intellij-plugin
./gradlew buildPlugin        # Windows: gradlew.bat buildPlugin
```

Lo zip è in `build/distributions/`. `./gradlew runIde` apre un IDE di prova con il plugin caricato, `./gradlew test` esegue i test.

## Com'è fatto

| File | Cosa fa |
|---|---|
| `core/Json.kt` | lettore e scrittore JSON minimale (nessuna libreria esterna) |
| `core/EffortCore.kt` | logica pura, senza dipendenze dall'IDE, gemella di `vscode-extension/lib.js`: livelli, barra, consigli, notifiche, abbinamento cartella-stato, reset |
| `ui/EffortMonitor.kt` | servizio di progetto: legge lo stato ogni 2 secondi, aggiorna la vista e mostra le notifiche |
| `ui/EffortStatusBarWidget.kt` | voce nella status bar |
| `ui/EffortToolWindow.kt` | tool window con barra, cronologia, consiglio, sessioni e pulsante Reset |
| `ui/ResetAction.kt`, `ui/EffortStartup.kt` | azione del menu Tools e avvio del monitor all'apertura del progetto |
| `META-INF/plugin.xml` | registrazione di widget, tool window, notifiche e azione |

La logica in `core/` ha i suoi test (`EffortCoreTest.kt`); l'interfaccia si prova con `runIde`.

## Release

La versione in `gradle.properties` è aggiornata da release-please insieme al resto del repository. A ogni release il job `publish-intellij-plugin` costruisce lo zip e lo allega alla GitHub Release. Se nei secret del repo c'è `JETBRAINS_PUBLISH_TOKEN` (token di <https://plugins.jetbrains.com/author/me/tokens>), lo stesso job pubblica lo zip anche sul JetBrains Marketplace con `publishPlugin`; ogni versione passa da una breve revisione JetBrains. Il primo upload della scheda va fatto a mano.
