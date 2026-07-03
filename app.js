// Haupt-App (ES-Modul, ausgelagert aus index.html fuer die CSP script-src 'self').
// Vue wird direkt aus dem vendored Full-Build importiert (kein Importmap noetig).
// Der Full-Build kompiliert das In-DOM-Template zur Laufzeit via Function(),
// weshalb die CSP 'unsafe-eval' braucht (siehe <meta> in index.html).
import { createApp, ref, watch, nextTick, computed } from './vendor/vue.esm-browser.prod.js'
import * as FlashOnWeb from './FlashOnWeb.js'
import { VERSION as appVersion } from './version.js'
import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';

// Check again inside module to be safe
if ('usb' in navigator || 'serial' in navigator) {
    FlashOnWeb.init();

    createApp({
      setup() {
        const currentTab = ref('update');
        const serialInput = ref('');
        const showModal = ref(false);
        const modalText = ref('');
        const pendingCmd = ref('');
        const showReadme = ref(false);

        const parsedReadme = computed(() => {
            // marked erzeugt rohes HTML → vor v-html durch DOMPurify sanitizen,
            // damit ein <img onerror>/<script> in README.md nichts ausfuehrt.
            return FlashOnWeb.readmeText.value
                ? DOMPurify.sanitize(marked.parse(FlashOnWeb.readmeText.value))
                : "Lade...";
        });

        watch(FlashOnWeb.serialLog, () => {
            nextTick(() => {
                const el = document.getElementById('termWin');
                if(el) el.scrollTop = el.scrollHeight;
            });
        });

        const triggerSend = () => {
            if(!serialInput.value) return;
            FlashOnWeb.sendSerial(serialInput.value);
            serialInput.value = '';
        };

        const askConfirm = (cmd) => {
            pendingCmd.value = cmd;
            if (cmd === 'e') {
                modalText.value = "Werkseinstellungen laden & Neustart?";
            } else if (cmd === 'B01') {
                modalText.value = "In den Bootloader neustarten?<br>Verbindung wird getrennt.";
            } else {
                modalText.value = "Befehl senden?";
            }
            showModal.value = true;
        };

        const executeConfirm = () => {
            showModal.value = false;
            if (pendingCmd.value === 'B01') {
                FlashOnWeb.jumpToBootloader();
            } else {
                FlashOnWeb.sendSerial(pendingCmd.value);
            }
        };

        const triggerFileSelect = () => {
            document.getElementById('hexInput').click();
        };

        const handleFileUpload = (e) => {
            const file = e.target.files[0];
            if(file) FlashOnWeb.uploadFirmware(file);
            e.target.value = null;
        };

        const showReadmeModal = () => {
            FlashOnWeb.fetchReadme();
            showReadme.value = true;
        }

        return {
            appVersion,
            currentTab, serialInput, triggerSend,
            showModal, modalText, askConfirm, executeConfirm,
            triggerFileSelect, handleFileUpload,
            showReadme, parsedReadme, showReadmeModal,
            ...FlashOnWeb
        }
      }
    }).mount('#app')
}
