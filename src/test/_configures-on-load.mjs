import { handDesktopTo } from "../bootstrap/wiring/desktop-owners.ts";
import { installExportFormats } from "../bootstrap/wiring/export-registry.ts";
import { createExportRegistry } from "../application/export/registry.ts";

handDesktopTo({ openPrompterInBrowser: () => Promise.resolve({ ok: false, message: "" }) });
installExportFormats(createExportRegistry());
