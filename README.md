# busware CUL Web Flasher & Service Tool

Ein browserbasiertes Tool zum Flashen und Konfigurieren von **busware CUL USB-Sticks**.  
Es ermöglicht Firmware-Updates und Diagnose direkt im Browser (Chrome/Edge), ohne dass lokale Software wie `dfu-programmer` oder Terminal-Programme installiert werden müssen.

🔗 **Live-Tool:** [https://prov.busware.de/culflasher/](https://prov.busware.de/culflasher/)  
🔌 **Hardware-Infos:** [busware.de CUL Wiki](https://busware.de/tiki-index.php?page=CUL)

---

## ✨ Features

* **1-Klick Firmware Update:** Lädt automatisch die neueste `a-culfw` Version (via `manifest.json`) direkt von GitHub und flasht den Stick.
* **Intelligente Erkennung:** Unterscheidet automatisch zwischen **App-Mode** (Laufender Betrieb) und **Bootloader-Mode** (DFU).
* **Integriertes Terminal:** Senden von CUL-Befehlen (z.B. `V`, `X21`, `e`) direkt im Browser über Web Serial API.
* **Konfigurations-Decoder:** Liest die Register des CC1101-Chips aus und zeigt wichtige Parameter im Klartext an:
    * Frequenz (kalkuliert aus Reg `0D`-`0F`)
    * Bandbreite & Modulation
    * Sendeleistung (PA Index)
* **Lokaler Upload:** Möglichkeit, eigene `.hex` Dateien (z.B. Test-Firmware) zu flashen.
* **Sicherheit:** Warnhinweise vor Aktionen, die die Verbindung trennen (Reset, Bootloader-Jump).

---

## 🚀 Nutzung

Das Tool läuft vollständig clientseitig im Browser. Es werden keine Daten an Server gesendet (außer dem Download der Firmware von GitHub).

### Voraussetzungen
* **Browser:** Google Chrome, Microsoft Edge oder Opera (Browser muss **WebUSB** und **Web Serial** unterstützen).
* **Verbindung:** Der Stick muss direkt am PC angeschlossen sein.

### Anleitung für Windows-Nutzer
Windows installiert für den Bootloader oft den falschen Treiber. Damit der Browser Zugriff erhält, muss **einmalig** der Treiber gewechselt werden:
1.  Stick mit gedrücktem Taster einstecken (Bootloader-Modus).
2.  Lade [Zadig](https://zadig.akeo.ie/) herunter und starte es.
3.  Wähle `Options` -> `List All Devices`.
4.  Wähle das Gerät `ATm32U4DFU`.
5.  Ändere den Treiber auf **WinUSB** und klicke "Replace Driver".

Unter **macOS** und **Linux** funktioniert es in der Regel "Out of the Box" (unter Linux sind ggf. udev-Regeln nötig).

---

## 🛠 Funktionsweise

Das Tool besteht aus zwei Hauptkomponenten:

1.  **Flasher (WebUSB):**
    Basiert auf dem DFU-Protokoll für Atmel AVR Chips. Der Browser kommuniziert direkt mit dem Bootloader des ATmega32U4.
    * *Quelle:* Die Firmware wird live via `fetch` vom `a-culfw` GitHub-Repository geladen.

2.  **Terminal (Web Serial API):**
    Baut eine serielle Verbindung (`/dev/ttyACM0` bzw. `COMx`) zum Stick auf, wenn dieser im App-Modus ist.
    * Es parst die Antworten des Sticks live, um Version und CC1101-Registerwerte zu extrahieren und in der GUI anzuzeigen.

---

## 🏗 Credits & Lizenz

Dieses Projekt ist ein Fork und eine spezialisierte Weiterentwicklung von **AVRFlashOnWeb**.

* **Original-Projekt:** [AVRFlashOnWeb](https://github.com/tmk/AVRFlashOnWeb) von [tmk](https://github.com/tmk).
* **Anpassungen:** * Benutzeroberfläche komplett überarbeitet (Tabs, Dashboard).
    * Integration der GitHub API zum automatischen Laden von CUL-Firmware.
    * Hinzufügen eines seriellen Terminals und CC1101-Decoders.
    * Spezifische Anpassungen für den ATmega32U4 auf CUL-Hardware.

Der Quellcode steht unter der **MIT License**.
