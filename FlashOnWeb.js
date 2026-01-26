import { ref, reactive } from "vue";
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
let target = null; // WebUSB
let port = null;   // WebSerial
let reader = null;
let readableStreamClosed = null; // WICHTIG für sauberes Trennen
let configScanActive = false;

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

// --- USB MONITORING ---
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

// --- 2. SERIAL TERMINAL (ROBUST LOCK HANDLING) ---

export async function toggleSerial() {
    // 1. TRENNEN
    if (isSerialConnected.value) {
        await closeSerial();
        serialLog.value += "\n[Getrennt]\n";
        return;
    }

    // 2. VERBINDEN
    if (!navigator.serial) {
        serialLog.value += "Browser unterstützt kein Web Serial API.\n";
        return;
    }

    try {
        // Sicherstellen, dass alles zu ist
        if (port) await closeSerial();

        port = await navigator.serial.requestPort({ filters: [{ usbVendorId: VENDOR_ATMEL }] });
        await port.open({ baudRate: 38400 });
        
        isSerialConnected.value = true;
        serialLog.value += "[Verbunden]\n";
        
        // Leseschleife starten
        readSerialLoop();

    } catch (e) {
        console.error(e);
        serialLog.value += `Fehler: ${e.message}\n`;
        await closeSerial(); 
    }
}

async function closeSerial() {
    // A. Reader stoppen
    if (reader) {
        try {
            await reader.cancel(); // Das beendet die Schleife in readSerialLoop
            // WICHTIG: Wir müssen warten, bis der Pipe-Stream wirklich zu ist!
            if (readableStreamClosed) {
                await readableStreamClosed.catch(() => {}); 
            }
        } catch (e) { console.warn(e); }
        reader = null;
    }

    // B. Port schließen (geht nur, wenn Reader Lock weg ist)
    if (port) {
        try {
            await port.close();
        } catch (e) { console.warn("Port close error:", e); }
        port = null;
    }
    
    isSerialConnected.value = false;
}

async function readSerialLoop() {
    const textDecoder = new TextDecoderStream();
    // Promise speichern, auf das wir beim Schließen warten müssen
    readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
    reader = textDecoder.readable.getReader();
    
    let buffer = "";

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                // Stream wurde durch reader.cancel() beendet
                break; 
            }
            if (value) {
                serialLog.value += value;
                buffer += value;
                let lines = buffer.split(/\r?\n/);
                buffer = lines.pop(); 
                for (let line of lines) parseSerialLine(line);
            }
        }
    } catch (e) {
        console.error("Read Loop Error:", e);
        serialLog.value += `\n[Verbindungsabbruch]\n`;
        isSerialConnected.value = false;
    } finally {
        // WICHTIG: Lock freigeben, sonst blockiert port.close() für immer
        if (reader) {
            reader.releaseLock();
        }
    }
}

// --- SERIAL PARSER & COMMANDS ---

export async function startConfigScan() {
    if (!isSerialConnected.value) { alert("Bitte erst verbinden!"); return; }
    deviceInfo.rawRegs = []; 
    configScanActive = true; 
    await sendSerial("V");
}

function parseSerialLine(line) {
    line = line.trim();
    if (!line) return;
    if (line.startsWith("V ")) {
        const hwMatch = line.match(/(CUL\d+)/); 
        const fwMatch = line.match(/V\s+([\d\.]+)\s+([^\s]+)/);
        if (fwMatch) deviceInfo.fwName = fwMatch[2];
        if (hwMatch) deviceInfo.hwType = hwMatch[1];
        if (configScanActive) setTimeout(() => sendSerial("C99"), 200);
    }
    if (configScanActive && /^[0-9A-F]{16}$/i.test(line)) {
        for (let i = 0; i < 16; i += 2) deviceInfo.rawRegs.push(parseInt(line.substr(i, 2), 16));
        if (deviceInfo.rawRegs.length >= 48) {
            configScanActive = false;
            decodeCC1101(deviceInfo.rawRegs);
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

export async function sendSerial(text) {
    if (!port || !port.writable) return;
    const writer = port.writable.getWriter();
    await writer.write(new TextEncoder().encode(text + "\r\n"));
    writer.releaseLock();
    serialLog.value += `> ${text}\n`;
}

export async function jumpToBootloader() {
    if (isSerialConnected.value && port) {
        await sendSerial("B01");
        // Wir müssen hier nicht manuell schließen, der Stick startet neu 
        // und der Loop wirft einen Error -> Clean close passiert dort.
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
    
    if (!device.opened) await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    try { await device.claimInterface(0); } catch(e){}
    return device;
}

async function runFlashSequence(hexData) {
    if(target) { try{await target.close();}catch(e){} target=null; }
    target = await connectDFU();

    message.value = "Lösche Flash-Speicher...";
    await AtmelDFU.chipErase(target);
    
    message.value = `Schreibe ${hexData.length} Bytes...`;
    await AtmelDFU.writeMemory(target, 0x0000, hexData.length - 1, hexData);
    
    message.value = "Verifiziere Daten...";
    const mem = await AtmelDFU.readMemory(target, 0, hexData.length - 1);
    for(let i=0; i<mem.byteLength; i++) if(mem[i]!==hexData[i]) throw new Error("Verify Error");
    
    message.value = "Starte CUL neu...";
    await AtmelDFU.launch(target);
    isSuccess.value = true; message.value = "Update erfolgreich abgeschlossen!";
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
        if(target) { try{await target.close();}catch(e){} target=null; } 
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
        if(target) { try{await target.close();}catch(e){} target=null; } 
        isFlashing.value = false; 
    }
}

function loadHex(text) {
    let data = []; let ext_addr = 0; let lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        let line = lines[index].trim(); if (line.length < 11 || line.at(0) !== ':') continue;
        let bytes = line.slice(1).match(/[0-9a-fA-F]{2}/g).map((h) => parseInt(h,16));
        let type = bytes[3]; let addr = (bytes[1] << 8) | bytes[2]; let payload = bytes.slice(4, 4+bytes[0]);
        if (type === 0) {
            if (data.length < ext_addr + addr) for (let i = data.length; i < ext_addr + addr; i++) data.push(0xff);
            data.push(...payload);
        } else if (type === 2) ext_addr = ((payload[0] << 8) | payload[1]) * 16;
        else if (type === 4) ext_addr = ((payload[0] << 8) | payload[1]) << 16;
    }
    return data;
}

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
