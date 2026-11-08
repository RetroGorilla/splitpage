import { VIDEO_FILE_EXT } from "../../../shared/video-path.ts";

const KNOWN_HOSTS: Record<string, string> = {
  "youtube.com": "YouTube",
  "youtu.be": "YouTube",
  "youtube-nocookie.com": "YouTube",
  "vimeo.com": "Vimeo",
  "player.vimeo.com": "Vimeo",
  "loom.com": "Loom",
  "dailymotion.com": "Dailymotion",
  "dai.ly": "Dailymotion",
  "twitch.tv": "Twitch",
  "tiktok.com": "TikTok",
  "wistia.com": "Wistia",
  "frame.io": "Frame.io",
  "vidyard.com": "Vidyard",
  "streamable.com": "Streamable"
};

const FILE_KINDS: readonly (readonly [RegExp, string])[] = [
  [VIDEO_FILE_EXT, "File"],
  [/\.pdf$/i, "PDF"],
  [/\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|aif|aiff|wma)$/i, "Audio"],
  [/\.(doc|docx|odt|rtf|pages)$/i, "Document"],
  [/\.(xls|xlsx|ods|csv|numbers)$/i, "Sheet"],
  [/\.(ppt|pptx|odp|key)$/i, "Slides"],
  [/\.(txt|md|fdx|fountain)$/i, "Text"],
  [/\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp|svg|psd)$/i, "Image"],
  [/\.(zip|rar|7z|tar|gz)$/i, "Archive"]
];

export function videoHostLabel(l: { href?: string | undefined; name?: string | undefined }): string {
  if (!l.href) {
    const name = typeof l.name === "string" ? l.name : "";
    const kind = FILE_KINDS.filter(function (k) { return k[0].test(name); })[0];
    return kind ? kind[1] : "File";
  }
  let host: string;
  try {
    host = new URL(l.href).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (e) {
    return "Link";
  }
  return KNOWN_HOSTS[host] || host;
}
