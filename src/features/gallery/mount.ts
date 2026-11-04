export interface HistoryGalleryPorts {
  restore: (button: HTMLElement) => void;
  open: (row: string | null, slot: number, videos: boolean) => void;
  beatClicked: (row: string | null) => void;
}

export function mountHistoryGallery(ports: HistoryGalleryPorts): { restoreClick: (event: MouseEvent) => boolean; galleryClick: (event: MouseEvent) => boolean; dispose: () => void } {
  let active = true;
  return {
    restoreClick(event): boolean {
      if (!active) return false;
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action="restore-snapshot"]');
      if (!button) return false;
      ports.restore(button);
      return true;
    },
    galleryClick(event): boolean {
      if (!active) return false;
      const target = event.target as HTMLElement;
      const beat = target.closest<HTMLElement>("#rows .row[data-id]");
      if (beat) ports.beatClicked(beat.getAttribute("data-id"));
      const tile = target.closest('[data-action="gallery-open"], [data-action="gallery-open-videos"]');
      if (!tile) return false;
      ports.open(tile.getAttribute("data-id"), Number(tile.getAttribute("data-slot")) || 0, tile.getAttribute("data-action") === "gallery-open-videos");
      return true;
    },
    dispose(): void { active = false; }
  };
}
