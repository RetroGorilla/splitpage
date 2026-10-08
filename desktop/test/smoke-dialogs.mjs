export function modalShownExpr(id) {
  return "(function(){ var m = document.getElementById(" + JSON.stringify(id) + "); if (!m || m.hidden) return false;" +
    " var open = document.querySelectorAll('.modal-backdrop:not([hidden])');" +
    " return open.length > 0 && open[open.length - 1] === m; })()";
}

export function createDialogHelpers(deps) {
  const { evalPage, poll } = deps;
  const shownTimeoutMs = deps.shownTimeoutMs || 5000;
  const listedTimeoutMs = deps.listedTimeoutMs || 15000;
  const joinedTimeoutMs = deps.joinedTimeoutMs || 20000;
  const requireShown = (id) => "if (!" + modalShownExpr(id) + ") return false;";
  const run = (cdp, js) => evalPage(cdp, js, { awaitPromise: false });

  async function waitModalShown(cdp, id) {
    return !!(await poll(cdp, modalShownExpr(id), shownTimeoutMs).catch(() => false));
  }

  async function connectTabViaDialog(cdp, srv, opts) {
    const o = opts || {};
    await run(cdp, "(function(){ document.querySelector('#file-menu [data-file-action=\"servers\"]').click(); return true; })()");
    if (!(await waitModalShown(cdp, "connect-modal"))) return false;
    const js = "(function(){" + requireShown("connect-modal") +
      "document.getElementById('connect-name').value=" + JSON.stringify(o.name || ("Srv " + srv.port)) + ";" +
      "document.getElementById('connect-url').value=" + JSON.stringify(srv.url) + ";" +
      "document.getElementById('connect-pin').value=" + JSON.stringify(srv.pin || "") + ";" +
      "document.getElementById('connect-remember').checked=" + (o.remember ? "true" : "false") + ";" +
      (o.ssh
        ? "var t=document.getElementById('connect-ssh-toggle');t.checked=true;t.dispatchEvent(new Event('change'));" +
          "document.getElementById('connect-ssh-userhost').value=" + JSON.stringify(o.ssh.userHost) + ";" +
          "document.getElementById('connect-ssh-remote').value=" + JSON.stringify(String(o.ssh.remotePort)) + ";" +
          "document.getElementById('connect-ssh-local').value=" + JSON.stringify(String(o.ssh.localPort)) + ";"
        : "") +
      "document.querySelector('#connect-modal [data-connect-action=\"add\"]').click(); return true; })()";
    if ((await run(cdp, js)) !== true) return false;
    const ok = await poll(cdp, "(function(){ var c = window.__hostedTest.conn(); return c.serverUrl === " +
      JSON.stringify(srv.url) + " && c.hasToken && !document.getElementById('menu-server-open').hidden; })()", joinedTimeoutMs)
      .catch(() => false);
    await run(cdp, "(function(){ var b = document.querySelector('#connect-modal [data-connect-action=\"close\"]'); if (b) b.click(); return true; })()");
    return !!ok;
  }

  async function openViaPicker(cdp, docId) {
    await run(cdp, "(function(){ document.getElementById('menu-server-open').click(); return true; })()");
    if (!(await waitModalShown(cdp, "server-modal"))) return false;
    const sel = "#server-modal [data-action=\"server-open\"][data-id=" + JSON.stringify(docId) + "]";
    const listed = await poll(cdp, "!!document.querySelector(" + JSON.stringify(sel) + ")", listedTimeoutMs).catch(() => false);
    if (!listed) return false;
    return (await run(cdp, "(function(){" + requireShown("server-modal") +
      "document.querySelector(" + JSON.stringify(sel) + ").click(); return true; })()")) === true;
  }

  async function submitPin(cdp, pin) {
    if (!(await waitModalShown(cdp, "pin-modal"))) return false;
    return (await run(cdp, "(function(){" + requireShown("pin-modal") +
      "document.getElementById('pin-input').value=" + JSON.stringify(pin) + ";" +
      "document.querySelector('#pin-modal [data-connect-action=\"pin-submit\"]').click(); return true; })()")) === true;
  }

  return { waitModalShown, connectTabViaDialog, openViaPicker, submitPin };
}
