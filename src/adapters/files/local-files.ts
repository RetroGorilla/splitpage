import type { LocalFileAccess, LocalFileHandle } from "../../application/files/local-file-access.ts";
import { makeDesktopHandle } from "../desktop/desktop-handle.ts";
import { checkFileConflict } from "./file-target.ts";

export function localFileAccess(window: Window & { readonly showOpenFilePicker?: NonNullable<LocalFileAccess["openPicker"]> }): LocalFileAccess {
  return {
    read: function (handle) { return (handle as LocalFileHandle).getFile(); },
    text: function (file) { return file.text(); },
    permission: function (handle, options) { return (handle as LocalFileHandle).queryPermission(options); },
    get openPicker() { return window.showOpenFilePicker ? function (options: Parameters<NonNullable<LocalFileAccess["openPicker"]>>[0]) { return (window.showOpenFilePicker as NonNullable<LocalFileAccess["openPicker"]>)(options); } : null; },
    desktopHandle: function (entry) { return makeDesktopHandle(entry); },
    checkConflict: function (handle, lastModified) { return checkFileConflict(handle, lastModified); },
    createWritable: function (handle) { return (handle as Required<LocalFileHandle>).createWritable(); }
  };
}
