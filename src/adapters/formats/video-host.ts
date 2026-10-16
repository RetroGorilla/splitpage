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

export function videoHostLabel(l: { href?: string | undefined }): string {
  if (!l.href) return "File";
  let host: string;
  try {
    host = new URL(l.href).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (e) {
    return "Link";
  }
  return KNOWN_HOSTS[host] || host;
}
