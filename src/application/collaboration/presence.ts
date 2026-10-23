export interface PresencePerson {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly rowId: string;
  readonly field: string;
}

export interface PresenceView {
  readonly shown: () => readonly PresencePerson[];
}
