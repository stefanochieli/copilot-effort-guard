# Provare effort-guard su Copilot

Gli hook di Copilot sono ancora in evoluzione e i nomi dei campi cambiano tra CLI e VS Code. Questa guida serve a verificare cosa arriva davvero sulla tua installazione.

## 1. Prerequisiti

- Node >= 20 nel PATH (`node --version`).
- Copilot CLI recente, oppure VS Code con gli agent hooks (anteprima). Per Copilot aziendale gli hook possono essere disattivati da una policy dell'organizzazione: se non partono, chiedi all'admin.
- Controllo rapido: `node src/effort-guard.mjs selftest` deve stampare `ok`.

## 2. Installazione

Solo per te (CLI): `node scripts/install.mjs --user` (scrive in `~/.copilot/`).
Per un repository (condiviso col team via git): `node scripts/install.mjs <cartella-repo>`, poi commit di `.effort-guard-hooks/` e `.github/hooks/effort-guard.json`.

## 3. Verifica con il dump dei payload

1. Avvia Copilot con `EFFORT_GUARD_DEBUG=1` (PowerShell: `$env:EFFORT_GUARD_DEBUG=1`) e `EFFORT_GUARD_THRESHOLD=1`.
2. Chiedi all'agente di eseguire un comando di test che fallisce (es. `npm test` su un test rotto) e poi mandagli un altro messaggio.
3. `node <percorso>/effort-guard.mjs doctor` mostra il riepilogo; `.effort-guard/payloads.jsonl` contiene i payload grezzi di ogni evento.
4. Se un evento non compare in `payloads.jsonl`, quell'host non lo invia: segnalalo con una issue allegando il file (senza dati sensibili: contiene comandi e output dei tool).

## 4. Cosa aspettarsi

- Alla soglia l'avviso compare su stderr al prompt successivo e viene passato all'agente come `additionalContext` al primo evento di tool seguente (VS Code non accetta contesto dall'hook del prompt).
- Se non vedi l'avviso ma `doctor` mostra turni "struggling", gli hook funzionano e manca solo la visualizzazione nel tuo client.

## 5. Diffusione al team

1. Prova tu su CLI e VS Code e allega `payloads.jsonl` alla issue di verifica.
2. Installa nel repository del team (punto 2), apri una PR e chiedi a 2-3 colleghi di usarlo per una settimana.
3. Per tutta l'azienda: pubblicare il pacchetto come repo template o come hook a livello di organizzazione (se la policy Copilot lo consente) è il passo successivo; prima serve la conferma dei payload su una versione stabile.
