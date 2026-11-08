# busware CUL Web Flasher & Service Tool

A browser tool to flash and configure **busware CUL USB sticks**.
It updates the firmware and shows diagnostics directly in the browser (Chrome/Edge), without installing `dfu-programmer` or a terminal program.

🔗 **Live tool:** [https://install.busware.de/cul/](https://install.busware.de/cul/)  
🔌 **Hardware info:** [busware.de CUL Wiki](https://busware.de/tiki-index.php?page=CUL)

---

## ✨ Features

* **One-click firmware update:** flashes the `a-culfw` release the page ships with; its version is shown above the button. The firmware file comes from the same server as the page.
* **Mode detection:** tells **firmware mode** (normal operation) from **bootloader mode** (DFU) and offers the restart into the bootloader.
* **Terminal:** sends CUL commands (e.g. `V`, `X21`, `e`) over the Web Serial API.
* **Configuration decoder:** reads the CC1101 registers and shows the key settings in plain text:
    * frequency (from registers `0D`-`0F`)
    * bandwidth and modulation
    * output power (PA index)
* **Local file:** flash your own `.hex` file (e.g. a test firmware).
* **Safety:** asks before actions that close the connection (reset, jump to the bootloader).

---

## 🚀 Usage

The tool runs entirely in the browser. It sends no data anywhere; the only download is the firmware file from the server that hosts the page.

### Requirements
* **Browser:** Google Chrome, Microsoft Edge or Opera (the browser must support **WebUSB** and **Web Serial**).
* **Connection:** plug the stick directly into the computer.

### Windows
Windows often installs the wrong driver for the bootloader. To give the browser access, change the driver **once**:
1.  Plug the stick in with its button held down (bootloader mode).
2.  Download and start [Zadig](https://zadig.akeo.ie/).
3.  Select `Options` -> `List All Devices`.
4.  Select the device `ATm32U4DFU`.
5.  Set the driver to **WinUSB** and click "Replace Driver".

On **macOS** and **Linux** it usually works out of the box (Linux may need udev rules).

---

## 🛠 How it works

The tool has two parts:

1.  **Flasher (WebUSB):**
    Speaks the DFU protocol of the Atmel AVR bootloader; the browser talks directly to the bootloader of the ATmega32U4.
    * *Source:* the firmware is a pinned `a-culfw` release, deployed next to the page together with its `manifest.json`.

2.  **Terminal (Web Serial API):**
    Opens a serial connection (`/dev/ttyACM0` or `COMx`) to the stick while it runs its firmware.
    * It parses the replies as they arrive to show the version and the CC1101 register values.

---

## 🏗 Credits & License

This project is a fork and a specialised continuation of **AVRFlashOnWeb**.

* **Original project:** [AVRFlashOnWeb](https://github.com/tmk/AVRFlashOnWeb) by [tmk](https://github.com/tmk).
* **Changes:**
    * user interface rebuilt (tabs, dashboard)
    * firmware loaded automatically from a manifest
    * serial terminal and CC1101 decoder added
    * adjustments for the ATmega32U4 on CUL hardware

The source code is under the **MIT License**.
