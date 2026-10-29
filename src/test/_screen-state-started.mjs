import "./_dom.mjs";
import { screenStateOwner, mountScreenStateOwner } from "../bootstrap/wiring/screen-state.ts";

try { screenStateOwner(); } catch { mountScreenStateOwner(); }
