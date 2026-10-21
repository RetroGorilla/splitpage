let open = false;
let playing = false;
let skipShot = false;
let voiceFollowing = false;

export const prompterIsOpen = (): boolean => open;
export const setPrompterOpen = (value: boolean): void => { open = value; };
export const prompterIsPlaying = (): boolean => playing;
export const setPrompterPlayingFlag = (value: boolean): void => { playing = value; };
export const prompterSkipsShot = (): boolean => skipShot;
export const setPrompterSkipShot = (value: boolean): void => { skipShot = value; };
export const voiceIsFollowing = (): boolean => voiceFollowing;
export const setVoiceFollowing = (value: boolean): void => { voiceFollowing = value; };
