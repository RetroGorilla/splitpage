export interface PrompterState {
  readonly isOpen: () => boolean;
  readonly isPlaying: () => boolean;
  readonly skipsShot: () => boolean;
  readonly voiceFollowing: () => boolean;
  readonly setOpen: (value: boolean) => void;
  readonly setPlaying: (value: boolean) => void;
  readonly setSkipShot: (value: boolean) => void;
  readonly setVoiceFollowing: (value: boolean) => void;
}

export function createPrompterState(): PrompterState {
  let open = false;
  let playing = false;
  let skipShot = false;
  let voiceFollowing = false;
  return Object.freeze({
    isOpen: (): boolean => open,
    isPlaying: (): boolean => playing,
    skipsShot: (): boolean => skipShot,
    voiceFollowing: (): boolean => voiceFollowing,
    setOpen: (value: boolean): void => { open = value; },
    setPlaying: (value: boolean): void => { playing = value; },
    setSkipShot: (value: boolean): void => { skipShot = value; },
    setVoiceFollowing: (value: boolean): void => { voiceFollowing = value; }
  });
}
