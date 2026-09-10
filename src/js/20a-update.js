  /* ================= updates =================

     The launcher (start.mjs) writes update-status.json next to the app before
     it serves anything, and rewrites it after a background check. This reads
     that file — it never talks to the network itself and it can never install
     anything. Installing is start.mjs's job at launch, deliberately: this page
     is served by a localhost server with no authentication, so an endpoint
     that replaced app files on request could be driven by any other page the
     browser has open.

     Absent file, file:// open, or a hosted deployment: the fetch fails or
     404s, nothing is shown, and the app behaves exactly as it did before. */

  var updateStatus = null;

  function loadUpdateStatus() {
    /* no-store: the whole point is to see what the launcher wrote THIS run */
    fetch("update-status.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) {
        if (!body || typeof body !== "object") return;
        updateStatus = body;
        renderUpdateNotice();
      })
      .catch(function () { /* not launched by start.mjs — nothing to say */ });
  }

  function renderUpdateNotice() {
    var bar = document.getElementById("update-bar");
    if (!bar || !updateStatus) return;

    /* Staged and waiting beats merely available: it is one restart away and
       needs nothing from the user but closing the window. */
    if (updateStatus.pending) {
      document.getElementById("update-bar-text").textContent =
        "Splitpage " + updateStatus.pending.to + " is ready — restart to finish installing it.";
      bar.hidden = false;
      return;
    }
    if (updateStatus.updateAvailable && updateStatus.latest) {
      document.getElementById("update-bar-text").textContent =
        "Splitpage " + updateStatus.latest + " is available. You have " + (updateStatus.version || "?") + ".";
      bar.hidden = false;
      return;
    }
    bar.hidden = true;
  }

  function dismissUpdateNotice() {
    var bar = document.getElementById("update-bar");
    if (bar) bar.hidden = true;
  }

  function showAbout() {
    var lines = [];
    var version = (updateStatus && updateStatus.version) || readEmbeddedVersion();
    lines.push("Splitpage " + (version || "(version unknown)"));

    if (!updateStatus) {
      lines.push("");
      lines.push("Opened without the launcher, so updates cannot be checked from here.");
      lines.push("Start it with start.bat (Windows) or ./start.sh, or run:");
      lines.push("    node update.mjs check");
    } else if (updateStatus.pending) {
      lines.push("");
      lines.push("Version " + updateStatus.pending.to + " is downloaded and verified.");
      lines.push("Close this window and start Splitpage again to install it.");
    } else if (updateStatus.updateAvailable) {
      lines.push("");
      lines.push("Version " + updateStatus.latest + " is available.");
      lines.push("Run  node update.mjs  to download it, then restart.");
    } else if (updateStatus.error) {
      lines.push("");
      lines.push("Last update check failed: " + updateStatus.error);
    } else if (updateStatus.latest) {
      lines.push("");
      lines.push("Up to date.");
    }
    window.alert(lines.join("\n"));
  }

  /* The version the page itself was built as, for the file:// case where
     there is no launcher to ask. */
  function readEmbeddedVersion() {
    var meta = document.querySelector('meta[name="splitpage-version"]');
    return meta ? meta.getAttribute("content") : null;
  }
