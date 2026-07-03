import { ref, reactive } from "./vendor/vue.esm-browser.prod.js";
import * as AtmelDFU from './AtmelDFU.js';

// --- KONSTANTEN ---
const VENDOR_ATMEL = 0x03eb;
const PID_DFU_MODE = 0x2ff4; 
const PID_APP_MODE = 0x204b; 
const CRYSTAL_FREQ = 26000000;

// --- STATES ---
export const message = ref('Lade...');
export const latestVersion = ref(''); 
export const releaseDate = ref('');
export const isFlashing = ref(false);
export const isError = ref(false);
export const isSuccess = ref(false);
export const isWrongMode = ref(false);

export const isSerialConnected = ref(false);
export const serialLog = ref("Terminal bereit.\n");
export const readmeText = ref("");

export const deviceInfo = reactive({
    fwName: "", hwType: "", freq: "", bw: "", mod: "", power: "", rxState: "", rawRegs: []
});

// Internals
let firmwareUrl = "";
let target = null;
let port = null;
let reader = null;
let readableStreamClosed = null;
let configScanActive = false;
let configScanTimer = null;
let serialWriteChain = Promise.resolve();

// --- INIT ---
export function init() {
    fetchLatestVersion();
    startUSBMonitoring();
}

// --- HELPER: Readme ---
export async function fetchReadme() {
    if (readmeText.value) return;
    try {
        const response = await fetch('./README.md');
        if (!response.ok) throw new Error("README.md nicht gefunden.");
        readmeText.value = await response.text();
    } catch (e) {
        readmeText.value = "# Fehler\nKonnte Anleitung nicht laden.";
    }
}

// --- 1. FIRMWARE & MANIFEST ---
// Trust-Model: Manifest und .hex kommen vom master-Branch des vendor-eigenen
// Repos tostmann/a-culfw. Der Read-Back-Verify nach dem Flash beweist
// flash == download, NICHT die Herkunft/Authentizität der Bytes — die
// Vertrauensgrenze ist also das a-culfw-Repo + GitHub. Bewusste Entscheidung
// für v1.0. Höhere Sicherheit (Out-of-band-Signatur über die .hex gegen einen
// Key ausserhalb des Repos + Anzeige von Version/Hash vor dem Flash) ist für
// eine spätere Version vorgesehen.
async function fetchLatestVersion() {
    isError.value = false;
    message.value = "Lade Manifest..."; 
    try {
        const baseUrl = 'https://raw.githubusercontent.com/tostmann/a-culfw/master/binaries/';
        const manifestUrl = baseUrl + 'manifest.json';
        const response = await fetch(manifestUrl);
        if (!response.ok) throw new Error(`Manifest nicht gefunden`);
        const data = await response.json();
        
        const deviceData = data["CUL_V3"];
        if (!deviceData) throw new Error("CUL_V3 nicht im Manifest");

        const ver = deviceData.version;
        const filename = deviceData.artifacts?.[0]?.file;
        if (!filename) throw new Error("Keine Firmware-Datei");

        latestVersion.value = ver;
        releaseDate.value = deviceData.last_build;
        firmwareUrl = baseUrl + filename;

        if (message.value === "Lade Manifest...") message.value = `Firmware ${ver} bereit.`;
    } catch (e) {
        console.error(e);
        message.value = "Fehler beim Laden der Versionsinfos.";
        isError.value = true;
        latestVersion.value = ""; 
    }
}

function startUSBMonitoring() {
    if (!navigator.usb) return;
    navigator.usb.getDevices().then(devices => handleDevicesFound(devices));
    navigator.usb.addEventListener('connect', (e) => analyzeDevice(e.device));
    navigator.usb.addEventListener('disconnect', (e) => {
        if (target && target.serialNumber === e.device.serialNumber) target = null;
        setTimeout(() => navigator.usb.getDevices().then(devices => handleDevicesFound(devices)), 1000);
    });
}
function handleDevicesFound(devices) {
    const atmelDevice = devices.find(d => d.vendorId === VENDOR_ATMEL);
    if (atmelDevice) analyzeDevice(atmelDevice);
}
function analyzeDevice(device) {
    if (device.vendorId !== VENDOR_ATMEL) return;
    if (device.productId === PID_APP_MODE) {
        isWrongMode.value = true;
        isError.value = true;
        message.value = "App-Mode erkannt. Bitte Config Tab nutzen.";
    } else if (device.productId === PID_DFU_MODE) {
        isWrongMode.value = false;
        isError.value = false;
        message.value = "Bootloader aktiv. Bereit zum Flashen.";
    }
}

// --- 2. SERIAL TERMINAL ---

export async function toggleSerial() {
    if (isSerialConnected.value) {
        await closeSerial();
        serialLog.value += "\n[Getrennt]\n";
        return;
    }

    if (!navigator.serial) {
        serialLog.value += "Browser unterstützt kein Web Serial API.\n";
        return;
    }

    try {
        if (port) await closeSerial();
        port = await navigator.serial.requestPort({ filters: [{ usbVendorId: VENDOR_ATMEL }] });
        await port.open({ baudRate: 38400 });
        isSerialConnected.value = true;
        serialLog.value += "[Verbunden]\n";
        readSerialLoop();
    } catch (e) {
        console.error(e);
        serialLog.value += `Fehler: ${e.message}\n`;
        await closeSerial();
    }
}

async function closeSerial() {
    if (reader) {
        try {
            await reader.cancel();
            if (readableStreamClosed) await readableStreamClosed.catch(() => {});
        } catch (e) { console.warn(e); }
        reader = null;
    }
    readableStreamClosed = null;
    if (port) {
        try { await port.close(); } catch (e) { console.warn(e); }
        port = null;
    }
    isSerialConnected.value = false;
}

async function readSerialLoop() {
    const textDecoder = new TextDecoderStream();
    readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
    reader = textDecoder.readable.getReader();
    let buffer = "";

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
                serialLog.value += value;
                buffer += value;
                let lines = buffer.split(/\r?\n/);
                buffer = lines.pop(); 
                for (let line of lines) parseSerialLine(line);
            }
        }
    } catch (e) {
        console.error("Read loop error:", e);
        serialLog.value += `\n[Verbindung unterbrochen]\n`;
        // Abnormaler Exit (Unplug / Geräte-Reset nach B01): Port sauber
        // schließen und Referenzen nullen, statt sie bis zum nächsten
        // Connect dangeln zu lassen. closeSerial ist best-effort/idempotent.
        await closeSerial();
    } finally {
        if (reader) reader.releaseLock();
    }
}

// --- COMMANDS ---

export async function startConfigScan() {
    if (!isSerialConnected.value) { alert("Bitte erst verbinden!"); return; }
    deviceInfo.rawRegs = [];
    configScanActive = true;
    if (configScanTimer) clearTimeout(configScanTimer);
    configScanTimer = setTimeout(() => { configScanActive = false; deviceInfo.rawRegs = []; configScanTimer = null; }, 1500);
    await sendSerial("V");
}

function parseSerialLine(line) {
    line = line.trim();
    if (!line) return;
    if (line.startsWith("V ")) {
        const hwMatch = line.match(/(CUL\w+)/);
        const fwMatch = line.match(/V\s+([\d\.]+)\s+([^\s]+)/);
        if (fwMatch) deviceInfo.fwName = fwMatch[1] + " " + fwMatch[2];
        if (hwMatch) deviceInfo.hwType = hwMatch[1];
        if (configScanActive) setTimeout(() => sendSerial("C99"), 200);
    }
    if (configScanActive && /^[0-9A-F]{16}$/i.test(line)) {
        for (let i = 0; i < 16; i += 2) deviceInfo.rawRegs.push(parseInt(line.substr(i, 2), 16));
        if (deviceInfo.rawRegs.length >= 48) {
            configScanActive = false;
            if (configScanTimer) { clearTimeout(configScanTimer); configScanTimer = null; }
            decodeCC1101(deviceInfo.rawRegs.slice(0, 48));
        }
    }
}

function decodeCC1101(regs) {
    const freqReg = (regs[0x0D] << 16) | (regs[0x0E] << 8) | regs[0x0F];
    const freqVal = (freqReg * CRYSTAL_FREQ) / 65536.0;
    deviceInfo.freq = (freqVal / 1000000.0).toFixed(3) + " MHz";

    const mdmcfg4 = regs[0x10];
    const chanbw_e = (mdmcfg4 >> 6) & 0x03;
    const chanbw_m = (mdmcfg4 >> 4) & 0x03;
    const bwVal = CRYSTAL_FREQ / (8 * (4 + chanbw_m) * (1 << chanbw_e));
    deviceInfo.bw = (bwVal / 1000.0).toFixed(1) + " kHz";

    const modFormat = (regs[0x12] >> 4) & 0x07;
    const modMap = { 0: "2-FSK", 1: "GFSK", 3: "ASK/OOK", 4: "4-FSK", 7: "MSK" };
    deviceInfo.mod = modMap[modFormat] || "Unknown";

    const rxOffMode = (regs[0x17] >> 2) & 0x03;
    deviceInfo.rxState = (rxOffMode === 3) ? "Always On (RX)" : "Idle nach RX";
    
    const paIndex = regs[0x22] & 0x07;
    deviceInfo.power = `PA Index ${paIndex}`;
}

export function sendSerial(text) {
    // Writes über eine Single-Writer-Queue serialisieren: sonst wirft ein
    // zweiter getWriter() während eines laufenden write() synchron
    // ('WritableStream is locked') und das Kommando geht still verloren
    // (z.B. der setTimeout-C99 während eines manuellen Sends).
    serialWriteChain = serialWriteChain.then(async () => {
        if (!port || !port.writable) return;
        let writer = null;
        try {
            writer = port.writable.getWriter();
            await writer.write(new TextEncoder().encode(text + "\r\n"));
            serialLog.value += `> ${text}\n`;
        } catch (e) {
            serialLog.value += `\n[Sende-Fehler: ${e.message}]\n`;
        } finally {
            if (writer) { try { writer.releaseLock(); } catch (_) {} }
        }
    });
    return serialWriteChain;
}

export async function jumpToBootloader() {
    if (isSerialConnected.value && port) {
        await sendSerial("B01");
        // B01 re-enumeriert den ATmega32U4 in den DFU-Mode → CDC-Port stirbt.
        // Aktiv schließen, damit State konsistent bleibt (nicht auf den
        // Read-Loop-Fehlerpfad warten).
        await closeSerial();
        return;
    }
    try {
        const p = await navigator.serial.requestPort({ filters: [{ usbVendorId: VENDOR_ATMEL }] });
        await p.open({ baudRate: 38400 });
        const w = p.writable.getWriter();
        await w.write(new TextEncoder().encode("B01\r\n"));
        await w.releaseLock();
        setTimeout(() => p.close(), 200);
    } catch(e) { alert(e.message); }
}

// --- 4. FLASHING CORE ---
async function connectDFU() {
    if (!navigator.usb) throw new Error("WebUSB nicht verfügbar — bitte Chrome oder Edge nutzen.");
    let devices = await navigator.usb.getDevices();
    let device = devices.find(d => d.vendorId === VENDOR_ATMEL && d.productId === PID_DFU_MODE);
    
    if (!device) {
        try {
            device = await navigator.usb.requestDevice({ filters: [{ vendorId: VENDOR_ATMEL }] });
        } catch (e) { throw new Error("Kein Gerät ausgewählt."); }
    }
    
    if (device.productId === PID_APP_MODE) { 
        isWrongMode.value = true; 
        throw new Error("App-Mode. Bitte erst in Bootloader wechseln."); 
    }
    
    // VERBINDUNGSAUFBAU
    if (!device.opened) await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    
    // FIX: Explizit claimen und Fehler melden, statt zu verschlucken!
    try {
        await device.claimInterface(0);
    } catch(e) {
        console.error("Claim Error:", e);
        throw new Error("Zugriff verweigert (Interface Claim Failed). Bitte Zadig prüfen: Treiber muss WinUSB sein!");
    }
    
    return device;
}

async function runFlashSequence(hexData) {
    if(target) { try{await target.close();}catch(e){} target=null; }
    
    try {
        target = await connectDFU();

        const _dev = AtmelDFU.deviceInfo.find(d => d.productId === target.productId);
        if (_dev && hexData.length > _dev.flashSize - _dev.bootSize)
            throw new Error(`Firmware zu groß (${hexData.length} B > App-Bereich ${_dev.flashSize - _dev.bootSize} B) — falscher Chip oder Datei?`);

        message.value = "Lösche Flash-Speicher...";
        await AtmelDFU.chipErase(target);
        
        message.value = `Schreibe ${hexData.length} Bytes...`;
        await AtmelDFU.writeMemory(target, 0x0000, hexData.length - 1, hexData);
        
        message.value = "Verifiziere Daten...";
        const mem = await AtmelDFU.readMemory(target, 0, hexData.length - 1);
        for(let i=0; i<mem.byteLength; i++) if(mem[i]!==hexData[i]) throw new Error("Verify Error");
        
        message.value = "Starte CUL neu...";
        await AtmelDFU.launch(target);
        
        isSuccess.value = true; 
        message.value = "Update erfolgreich abgeschlossen!";
        
        // Nach erfolgreichem Flash Verbindung schließen
        try{await target.close();}catch(e){} target=null;
        
    } catch(e) {
        throw e; // Fehler weiterreichen
    }
}

export async function programFlash() {
    if (!firmwareUrl) return;
    isFlashing.value = true; isError.value = false;
    try {
        message.value = "Lade Firmware Datei...";
        const resp = await fetch(firmwareUrl);
        if(!resp.ok) throw new Error("Download Fehler");
        const hex = loadHex(await resp.text());
        await runFlashSequence(hex);
    } catch(e) { 
        console.error(e); 
        if(!isWrongMode.value) { isError.value = true; message.value = e.message; }
    } finally { 
        isFlashing.value = false; 
    }
}

export async function uploadFirmware(file) {
    isFlashing.value = true; isError.value = false;
    try {
        message.value = `Lese Datei ${file.name}...`;
        const text = await file.text();
        const hex = loadHex(text);
        await runFlashSequence(hex);
    } catch(e) {
        console.error(e);
        isError.value = true; message.value = "Fehler: " + e.message;
    } finally {
        isFlashing.value = false; 
    }
}

function loadHex(text) {
    const MAX_ADDR = 0x40000; // Obergrenze gegen Type-4-Adress-Blaehung (DoS)
    let data = []; let ext_addr = 0; let lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        let line = lines[index].trim(); if (line.length < 11 || line.at(0) !== ':') continue;
        let bytes = line.slice(1).match(/[0-9a-fA-F]{2}/g).map((h) => parseInt(h,16));
        let len = bytes[0];
        if (bytes.length !== len + 5) throw new Error(`HEX Zeile ${index+1}: Laenge falsch`);
        if ((bytes.reduce((a, b) => a + b, 0) & 0xff) !== 0) throw new Error(`HEX Zeile ${index+1}: Pruefsumme`);
        let type = bytes[3]; let addr = (bytes[1] << 8) | bytes[2]; let payload = bytes.slice(4, 4 + len);
        if (type === 0) {
            let base = ext_addr + addr;
            if (base < 0 || base + payload.length > MAX_ADDR) throw new Error(`HEX: Adresse 0x${base.toString(16)} ausserhalb`);
            for (let i = 0; i < payload.length; i++) data[base + i] = payload[i];
        } else if (type === 2) ext_addr = ((payload[0] << 8) | payload[1]) * 16;
        else if (type === 4) ext_addr = ((payload[0] << 8) | payload[1]) << 16;
    }
    for (let i = 0; i < data.length; i++) if (data[i] === undefined) data[i] = 0xff;
    return data;
}

// EXPERT FUNCTIONS
export async function selectDevice() { 
    try{ 
        target = await connectDFU(); 
        message.value="Verbunden (DFU Mode)"; 
    } catch(e){
        message.value=e.message;
    } 
}

export async function eraseChip() { 
    try {
        if(!target) target = await connectDFU();
        await AtmelDFU.chipErase(target); 
        message.value = "Chip vollständig gelöscht.";
    } catch(e) {
        message.value = "Fehler: " + e.message;
    }
}

export async function startApp() {
    try {
        if(!target) target = await connectDFU();
        message.value = "Sende Start-Kommando...";
        await AtmelDFU.launch(target);
        message.value = "Anwendung gestartet (Bootloader verlassen).";
        try{await target.close();}catch(e){} target=null;
    } catch(e) {
        message.value = "Fehler: " + e.message;
    }
}
