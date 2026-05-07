// content.js
// This script runs in the context of the Google Apps Script sidebar
// It acts as a bridge between the sidebar and the extension background worker.

let pollingAttempts = 0;

function initBridge() {
  const hostname = window.location.hostname;
  const protocol = window.location.protocol;

  if (!hostname.endsWith('googleusercontent.com') && protocol !== 'file:') {
    return;
  }

  if (pollingAttempts === 0) {
    console.log("Finanda Export Extension: Content script loaded. Polling for bridge elements...");
  }

  const reqBtn = document.getElementById("finanda-req-btn");
  if (!reqBtn) {
    pollingAttempts++;
    if (pollingAttempts <= 6) {
      setTimeout(initBridge, 500);
    } else {
      console.warn("Finanda Export Extension: Bridge elements not found after 3 seconds. Stopping polling.");
    }
    return;
  }

  if (reqBtn.dataset.bridgeInitialized) return;
  reqBtn.dataset.bridgeInitialized = "true";

  console.log("Finanda Export Extension: Bridge elements found! Attaching listeners.");

  reqBtn.addEventListener("click", () => {
    const reqInput = document.getElementById("finanda-req-input");
    if (!reqInput) return;

    let data;
    try {
      data = JSON.parse(reqInput.value);
    } catch (err) { return; }

    console.log("Content script received request from DOM:", data);

    if (data && data.action === "FINANDA_PING") {
      const resInput = document.getElementById("finanda-res-input");
      const resBtn = document.getElementById("finanda-res-btn");
      if (resInput && resBtn) {
        resInput.value = JSON.stringify({ action: "FINANDA_PING", payload: { status: "PONG" } });
        resBtn.click();
      }
      return;
    }

    // Forward the message to the background script
    if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage(data, (response) => {
        console.log("Content script received response from background:", response);
        const resInput = document.getElementById("finanda-res-input");
        const resBtn = document.getElementById("finanda-res-btn");
        if (resInput && resBtn) {
          resInput.value = JSON.stringify({ action: data.action, payload: response });
          resBtn.click();
        }
      });
    } else {
      console.error("Content script: chrome.runtime is not available");
    }
  });
}

initBridge();
