import { makeDesktopHandle } from "../desktop/desktop-handle.ts";
import { checkFileConflict } from "./file-target.ts";

export function localFileAccess(window) {
  return {
    read: function (handle) { return handle.getFile(); },
    text: function (file) { return file.text(); },
    permission: function (handle, options) { return handle.queryPermission(options); },
    get openPicker() { return window.showOpenFilePicker ? function (options) { return window.showOpenFilePicker(options); } : null; },
    desktopHandle: function (entry) { return makeDesktopHandle(entry); },
    checkConflict: function (handle, lastModified) { return checkFileConflict(handle, lastModified); },
    createWritable: function (handle) { return handle.createWritable(); }
  };
}
