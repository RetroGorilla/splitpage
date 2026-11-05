const process = require("node:process");
const { app, BrowserWindow } = require("electron");

app.whenReady().then(function () {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, spellcheck: true }
  });
  win.loadFile(process.env.WRITER_LAB_PAGE);
});
app.on("window-all-closed", function () { app.quit(); });
