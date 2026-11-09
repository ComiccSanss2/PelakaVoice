# PelakaVoice

Chat vocale, stream multipli con audio, chat di lobby, soundboard e chiamate private per Windows.

## Cosa mandare agli amici

`dist/PelakaVoice-Setup-<versione>.exe`: si manda una volta sola. Dopo, gli aggiornamenti arrivano dentro l'app.

## Creare un server (3 modi)

### 1. Dall'app (consigliato): niente .bat
Settings → **Your server** → **Host online**. L'app avvia server + tunnel Cloudflare e mostra il codice invito
(anche in alto a destra e in basso a sinistra nella lista lobby: clic = copia).
- **When PelakaVoice starts → Host online automatically**: il server parte da solo ogni volta che apri l'app.
- Se chiudi la finestra mentre fai da host (o sei in chiamata), l'app resta nella **tray** (vicino all'orologio).
  Tasto destro sull'icona: copia codice, ferma server, esci.
- Opzione: Settings → **Start PelakaVoice with Windows** = server sempre attivo quando il PC è acceso.
- Il codice invito cambia solo quando il server si riavvia (riavvio app/PC).

### 2. Con la finestra a riga di comando
`AVVIA-SERVER-ONLINE.bat` funziona ancora come prima.

### 3. Server sempre online, senza il tuo PC (gratis, indirizzo fisso)
Usa Render (render.com), il file `render.yaml` è già pronto:
1. Crea un account GitHub e carica questa cartella in un repository (senza `dist/` e `node_modules/`).
2. Su render.com → New → Blueprint → scegli il repository → Apply.
3. Ottieni un indirizzo fisso tipo `https://pelakavoice-server.onrender.com`: gli amici lo incollano una volta.
Nota: il piano gratuito "dorme" dopo 15 minuti senza nessuno; il primo che entra aspetta ~1 minuto.
Gli aggiornamenti dell'app non passano da Render (file troppo grande per GitHub): usa uno dei due modi sopra
per distribuirli, oppure una GitHub Release + `pelaka.updateUrl` in `package.json`.

## Pubblicare un aggiornamento
`PUBLISH-UPDATE.bat` (oppure `npm run release -- 2.3.1 "note"`). Compila l'installer e lo copia sia in
`server/updates` (usato dal .bat) sia in `%APPDATA%\PelakaVoice\updates` (usato dal server dentro l'app).
Chi si collega riceve l'aggiornamento: download in background → "Restart to update".

## Stream
- Più persone possono andare live insieme; ognuno vede più stream contemporaneamente (griglia, focus, fullscreen).
- Ogni stream ha il suo volume. L'audio della stream è l'audio del PC di chi trasmette **senza** le voci della chiamata
  (Windows 10 2004 o più recente).
- Lo stream viene inviato solo a chi lo guarda (risparmio di banda). In Settings → Streams si può disattivare la visione automatica.

## Sviluppo
```
npm start            avvia l'app
npm run server       solo server (porta 3000)
npm run build        installer in dist/
```
La versione 1.0.0 originale dei sorgenti è in `_backup-1.0.0/`.
# PelakaVoice
