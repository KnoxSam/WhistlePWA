# Whistle — trascrizioni sul telefono

Web app installabile che trascrive l'audio direttamente sul telefono con il modello Whistle
(Cactus Compute, licenza Apache-2.0). Non serve un PC.

- Al primo avvio scarica motore e modello da Hugging Face (~18 MB) e li salva sul telefono.
- Da quel momento funziona anche senza internet: l'audio non lascia il telefono.
- **Dal vivo**: trascrive in continuo dal microfono mentre parli (streaming Whistle, ~1 s alla volta).
  Il testo grigio in corsivo è provvisorio e si conferma pochi secondi dopo. Tieni lo schermo acceso:
  in standby il browser ferma il microfono.
- File audio/video; lingua e parole chiave; export TXT/SRT/VTT/JSON.
- Android: "Condividi → Whistle" da WhatsApp o dal registratore.

## Pubblicazione con GitHub Pages
1. Crea un repository pubblico (es. `whistle`) su github.com.
2. Add file → Upload files → seleziona tutti i file di questa cartella → Commit changes.
3. Settings → Pages → Branch: `main`, cartella `/ (root)` → Save.
4. Dopo 1-2 minuti l'app è su `https://TUONOME.github.io/whistle/`.

## Aggiornare l'app
Carica i file nuovi nello stesso repository e cambia `VERSION` in `sw.js` (es. `whistle-v3`).
Il telefono prende la nuova versione alla seconda apertura (chiudi e riapri l'app).
