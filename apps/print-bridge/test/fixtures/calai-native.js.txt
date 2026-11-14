import fs from "fs";
import path from "path";
import net from "net";
import http from "http";
import https from "https";
import { exec } from "child_process";

const CONFIG_FILE_NAME = "config.json";
const DEFAULT_CONFIG = {
  BACKEND_URL: "https://test13.fireai.agency/api",
  PRINTER_TOKEN: "PASTE_YOUR_PRINTER_TOKEN_HERE",
  PRINTER_MAC: "",
  PRINTER_TYPE: "NETWORK", // "NETWORK" or "USB"
  PRINTER_IP: "192.168.0.100",
  PRINTER_PORT: 9100,
  POLL_INTERVAL_MS: 5000,
};

// ==========================================
// 1. Native Zero-Dependency HTTP Helper
// ==========================================
function httpRequest(urlStr, method = "GET", bodyData = null) {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(urlStr);
      const clientLib = urlObj.protocol === "https:" ? https : http;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: method,
        headers: {
          "Content-Type": "application/json",
          Accept: "*/*",
        },
      };

      const req = clientLib.request(options, (res) => {
        let responseText = "";
        res.setEncoding("utf-8");

        res.on("data", (chunk) => {
          responseText += chunk;
        });

        res.on("end", () => {
          let data = responseText;
          try {
            data = JSON.parse(responseText);
          } catch {
            // Keep as raw text
          }
          resolve({ status: res.statusCode, data });
        });
      });

      req.on("error", (err) => reject(err));
      req.setTimeout(10000, () => {
        req.destroy(new Error("Request timed out"));
      });

      if (bodyData) {
        req.write(JSON.stringify(bodyData));
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ==========================================
// 2. Load or Auto-Create Configuration
// ==========================================
function loadConfiguration() {
  const configPath = path.resolve(CONFIG_FILE_NAME);

  if (!fs.existsSync(configPath)) {
    console.log(
      `💡 ${CONFIG_FILE_NAME} not found. Creating default configuration...`,
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify(DEFAULT_CONFIG, null, 2),
      "utf-8",
    );
    return DEFAULT_CONFIG;
  }

  try {
    const rawData = fs.readFileSync(configPath, "utf-8");
    const userConfig = JSON.parse(rawData);
    return { ...DEFAULT_CONFIG, ...userConfig };
  } catch (err) {
    console.error(
      `⚠️ Error reading ${CONFIG_FILE_NAME}, using default values:`,
      err.message,
    );
    return DEFAULT_CONFIG;
  }
}

const config = loadConfiguration();

console.log("====================================================");
console.log("   🖨️  CALAI THERMAL PRINT BRIDGE (ESC/POS)  🖨️   ");
console.log("====================================================");
console.log(`Backend URL:    ${config.BACKEND_URL}`);
console.log(`Printer Type:   ${config.PRINTER_TYPE}`);
if (config.PRINTER_TYPE === "USB") {
  console.log(`USB Target:     Windows Default Printer`);
} else {
  console.log(`Network Target: ${config.PRINTER_IP}:${config.PRINTER_PORT}`);
}
console.log(`Poll Interval:  ${config.POLL_INTERVAL_MS / 1000} seconds`);
console.log("====================================================\n");

/**
 * Sends receipt data directly over RAW TCP socket to network ESC/POS printer (Port 9100)
 */
function sendToNetworkPrinter(ip, port, textContent) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    client.setTimeout(10000); // 10s connection timeout

    console.log(
      `[${new Date().toLocaleTimeString()}] 🔌 Connecting to Network Printer at ${ip}:${port}...`,
    );

    client.connect(port, ip, () => {
      console.log(
        `[${new Date().toLocaleTimeString()}] 📡 Sending ESC/POS print job data...`,
      );
      
      // Select Character Code Table: CP437 (Standard DOS)
      // Command: ESC t 0 (0x1B 0x74 0x00)
      const initCommand = Buffer.from([0x1b, 0x74, 0x00]);
      
      // Replace Pound (£) symbol with its CP437 byte value (0x9C)
      const processedText = textContent.replace(/£/g, '\x9c');
      const textBuffer = Buffer.from(processedText, "binary");
      
      const payload = Buffer.concat([initCommand, textBuffer]);

      client.write(payload, () => {
        // Send ESC/POS cut paper command (\x1DV\x41\x03)
        const cutCommand = Buffer.from([0x1d, 0x56, 0x41, 0x03]);
        client.write(cutCommand, () => {
          client.end();
          resolve();
        });
      });
    });

    client.on("error", (err) => {
      client.destroy();
      reject(err);
    });

    client.on("timeout", () => {
      client.destroy();
      reject(new Error(`Connection to printer at ${ip}:${port} timed out.`));
    });
  });
}

/**
 * Sends receipt text to local Windows USB Default Printer using PowerShell
 */
function sendToUsbPrinter(filePath) {
  return new Promise((resolve, reject) => {
    // If the printer driver expects raw data, Get-Content without encoding works best for binary written files
    const printCommand = `powershell -Command "Get-Content -Path '${filePath}' | Out-Printer"`;
    exec(printCommand, (error, stdout, stderr) => {
      if (error) {
        return reject(error);
      }
      resolve();
    });
  });
}

/**
 * Main polling loop
 */
async function pollServer() {
  try {
    const pollPayload = {
      printerMAC: config.PRINTER_MAC || undefined,
      token:
        config.PRINTER_TOKEN !== "PASTE_YOUR_PRINTER_TOKEN_HERE"
          ? config.PRINTER_TOKEN
          : undefined,
      statusCode: "200",
    };

    const pollResponse = await httpRequest(
      `${config.BACKEND_URL}/printer/poll`,
      "POST",
      pollPayload,
    );

    if (
      pollResponse.status === 200 &&
      pollResponse.data &&
      pollResponse.data.jobReady
    ) {
      const { jobToken } = pollResponse.data;
      console.log(
        `[${new Date().toLocaleTimeString()}] 🔔 New print job found! Job Token: ${jobToken}`,
      );

      const contentResponse = await httpRequest(
        `${config.BACKEND_URL}/printer/poll?token=${encodeURIComponent(jobToken)}`,
        "GET",
      );

      const receiptText =
        typeof contentResponse.data === "string"
          ? contentResponse.data
          : JSON.stringify(contentResponse.data);

      if (config.PRINTER_TYPE === "USB") {
        // Local Windows USB Printing
        const tempPath = path.resolve("temp-receipt.txt");
        // Replace £ with its CP437 byte value (0x9C) for standard raw thermal driver printing
        const processedText = receiptText.replace(/£/g, '\x9c');
        fs.writeFileSync(tempPath, processedText, "binary");
        try {
          await sendToUsbPrinter(tempPath);
          console.log(
            `[${new Date().toLocaleTimeString()}] ✅ Printed successfully to USB Default Printer`,
          );
        } catch (usbErr) {
          console.error(
            `[${new Date().toLocaleTimeString()}] ❌ USB Printing failed:`,
            usbErr.message,
          );
        } finally {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        }
      } else {
        // Direct Network Socket Printing
        try {
          await sendToNetworkPrinter(
            config.PRINTER_IP,
            config.PRINTER_PORT,
            receiptText,
          );
          console.log(
            `[${new Date().toLocaleTimeString()}] ✅ Printed successfully to Network Printer (${config.PRINTER_IP}:${config.PRINTER_PORT})`,
          );
        } catch (netErr) {
          console.error(
            `[${new Date().toLocaleTimeString()}] ❌ Network Printing failed:`,
            netErr.message,
          );
          setTimeout(pollServer, config.POLL_INTERVAL_MS);
          return;
        }
      }

      // Confirm completion with backend
      try {
        await httpRequest(
          `${config.BACKEND_URL}/printer/poll?token=${encodeURIComponent(jobToken)}&code=200`,
          "DELETE",
        );
        console.log(
          `[${new Date().toLocaleTimeString()}] 🎉 Job confirmed & completed in database.\n`,
        );
      } catch (confirmErr) {
        console.error(
          `[${new Date().toLocaleTimeString()}] ⚠️ Server confirmation error:`,
          confirmErr.message,
        );
      }
    }
  } catch (error) {
    if (error.status === 204) {
      // No jobs pending - quiet polling
    } else {
      console.error(
        `[${new Date().toLocaleTimeString()}] ⚠️ Polling error:`,
        error.message,
      );
    }
  }

  setTimeout(pollServer, config.POLL_INTERVAL_MS);
}

pollServer();
