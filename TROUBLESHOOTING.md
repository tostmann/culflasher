# Troubleshooting Connection Issues

The **busware CUL Web Flasher** uses modern browser technologies (**WebUSB** and **Web Serial**) to communicate directly with your hardware.

For security reasons, operating systems (Windows, Linux) do not allow web browsers to access USB hardware by default. You may need to perform a **one-time setup** to grant these permissions.

---

## 🪟 Windows Users

### The Problem
When trying to flash, you might see an error like:
> *"Failed to execute 'controlTransferOut' on 'USBDevice': The specified interface has not been claimed."\*
> or
> *"Access Denied"\*

This happens because Windows automatically assigns a standard driver to the device, but the browser requires the generic **WinUSB** driver to talk to it.

### The Solution (Zadig)
You need to replace the driver for the **Bootloader** interface.

**⚠️ Important:** The stick presents itself as two different devices depending on its mode. You must perform these steps while the stick is in **Bootloader Mode**.

1.  **Unplug** the CUL stick from your computer.
2.  **Press and hold** the "PROGRAM" button (the micro-switch on the back of the stick).
3.  **Plug the stick in** while holding the button. (The LED should remain off or blink differently than usual).
4.  Download and run the free tool **[Zadig](https://zadig.akeo.ie/)**.
5.  In Zadig, go to the menu **Options** -> **List All Devices**.
6.  In the dropdown list, select **ATm32U4DFU**.
    * *Note: If you see "CUL V3", you are in the wrong mode. Start over from Step 1.*
7.  Look at the green arrow. The target driver (right side) must be **WinUSB**.
    * If it is not selected, use the small arrows to select **WinUSB (v6.x.x.x)**.
8.  Click **Replace Driver** (or "Install Driver").
9.  Wait for the confirmation message, then close Zadig.
10. **Restart your browser** (Chrome/Edge) completely.

Now the web tool should be able to connect and flash the device.

---

## 🐧 Linux Users (Ubuntu/Debian)

### The Problem
When trying to connect, you see:
> *"Access denied."\*
> or
> *"No device selected."* (even though you clicked on it)

Linux restricts access to raw USB devices to the `root` user by default. To allow your browser (running as a normal user) to access the stick, you need a **udev rule**.

### The Solution (udev rules)

Open your terminal and paste the following command block. This creates a rule file allowing access to busware/Atmel devices for all users.

```bash
# 1. Create the rule file
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="03eb", ATTR{idProduct}=="2ff4", MODE="0666", GROUP="plugdev"
SUBSYSTEM=="usb", ATTR{idVendor}=="03eb", ATTR{idProduct}=="204b", MODE="0666", GROUP="plugdev"' | sudo tee /etc/udev/rules.d/99-cul-stick.rules

# 2. Reload the permission system
sudo udevadm control --reload-rules
sudo udevadm trigger
```

**After running this:**
1.  Unplug the stick.
2.  Plug it back in.
3.  Try the web tool again.

### Special Note for Ubuntu (Snap Packages)
If you are using **Ubuntu** and installed **Chromium** or **Chrome** via the Software Center, it is likely running as a **Snap package**. Snaps run in a sandbox and might ignore the udev rules above.

You must manually grant the browser permission to access raw USB interfaces:

```bash
# For Chromium
sudo snap connect chromium:raw-usb

# For Google Chrome (if installed via Snap)
sudo snap connect google-chrome:raw-usb
```

If it still does not work, we recommend installing the **classic .deb version** of Google Chrome directly from the [Google Website](https://www.google.com/chrome/), as it does not suffer from these sandbox restrictions.

---

## 🍎 macOS Users

On macOS, the tool usually works out of the box without additional drivers.
If you experience issues:
1.  Check your USB cable (some are for charging only).
2.  Avoid USB hubs if possible; connect directly to the Mac.
3.  Ensure you are using a Chromium-based browser (Chrome, Edge, Opera, Brave). **Safari is not supported.**
