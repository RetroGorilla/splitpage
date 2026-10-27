export interface PrompterRecognition {
  readonly start: () => void;
  readonly stop: () => void;
}

export interface PrompterDesktop {
  readonly running: () => boolean;
  readonly canOpen: () => boolean;
  readonly open: () => Promise<{ readonly ok?: boolean; readonly message?: string } | null>;
}

export interface PrompterVoice {
  readonly available: () => boolean;
  readonly known: () => boolean;
  readonly load: () => Promise<unknown>;
  readonly createDesktop: () => PrompterRecognition;
  readonly createRelay: () => PrompterRecognition;
  readonly hasRelay: () => boolean;
  readonly setRelay: (value: string | null) => boolean;
  readonly browserRecognition: () => (new () => PrompterRecognition) | null;
}
