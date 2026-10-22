export type ExportGroup = "whole" | "part";

export interface ExportToggle {
  readonly id: string;
  readonly label: string;
  readonly on: () => boolean;
  readonly set: (on: boolean) => void;
}

export interface ExportCardDecl {
  readonly id: string;
  readonly group: ExportGroup;
  readonly name: string;
  readonly ext: string;
  readonly icon: string;
  readonly purpose: string;
  readonly option?: string;
  readonly pictures?: boolean;
  readonly extras?: boolean;
  readonly toggle?: ExportToggle;
}

export interface ExportChoice {
  readonly value: string;
  readonly label: string;
}

export interface ExportDiagnostics {
  readonly imagesLeftOut: number;
}

export interface ExportProduct {
  readonly data: string | Uint8Array;
  readonly diagnostics?: ExportDiagnostics;
  readonly imageBundle?: boolean;
}

export interface FileNameOptions {
  readonly imageBundle?: boolean;
}

export interface ExporterDecl<Request = unknown, Doc = unknown> {
  readonly id: string;
  readonly writeback?: boolean;
  readonly bundlesPictures?: boolean;
  readonly fileName: (baseName: string, opts: FileNameOptions) => string;
  readonly build: (request: Request, baseName: string) => ExportProduct | Promise<ExportProduct>;
  readonly defaults?: Readonly<Record<string, unknown>>;
  readonly action?: string;
  readonly card?: string;
  readonly choice?: ExportChoice;
  readonly name?: string;
  readonly menuLabel?: string;
  readonly words?: string;
  readonly reason?: (doc: Doc) => string;
  readonly refusal?: string;
}

export type Exporter<Request = unknown, Doc = unknown> = Readonly<ExporterDecl<Request, Doc>>;

export interface ExportCard<Request = unknown, Doc = unknown> extends ExportCardDecl {
  readonly variants: readonly Exporter<Request, Doc>[];
}

export interface ExportRegistry<Request = unknown, Doc = unknown> {
  defineCard: (card: ExportCardDecl) => () => void;
  register: (exporter: ExporterDecl<Request, Doc>) => () => void;
  card: (id: string) => ExportCard<Request, Doc> | undefined;
  cards: () => readonly ExportCard<Request, Doc>[];
  exporters: () => readonly Exporter<Request, Doc>[];
  byId: (id: string) => Exporter<Request, Doc> | undefined;
  byAction: (action: string) => Exporter<Request, Doc> | undefined;
  isAction: (action: unknown) => boolean;
  onChange: (listener: () => void) => () => void;
}

function refuse(message: string): never {
  throw new Error("Export registry: " + message);
}

export function createExportRegistry<Request = unknown, Doc = unknown>(): ExportRegistry<Request, Doc> {
  const cardDecls: ExportCardDecl[] = [];
  const entries: Exporter<Request, Doc>[] = [];
  const listeners: (() => void)[] = [];

  function changed(): void {
    listeners.slice().forEach((listener) => listener());
  }

  function variantsOf(cardId: string): Exporter<Request, Doc>[] {
    return entries.filter((e) => e.card === cardId && e.action !== undefined);
  }

  function checkSurface(e: ExporterDecl<Request, Doc>): void {
    if (e.action === undefined) {
      if (e.card !== undefined || e.choice !== undefined) refuse(e.id + " names a card without an action");
      return;
    }
    if (e.card === undefined || e.name === undefined || e.menuLabel === undefined) {
      refuse(e.action + " needs a card, a name and a menu label");
    }
    if (!cardDecls.some((c) => c.id === e.card)) refuse(e.action + " names card " + e.card + ", which is not defined");
    if (entries.some((x) => x.action === e.action)) refuse("action " + e.action + " is already registered");
    const siblings = variantsOf(e.card);
    if (e.choice === undefined && siblings.length) refuse(e.action + " needs a choice beside " + String(siblings[0]?.action));
    if (e.choice !== undefined && siblings.some((s) => s.choice === undefined)) {
      refuse(e.action + " has a choice but " + String(siblings.find((s) => s.choice === undefined)?.action) + " has none");
    }
    const value = e.choice?.value;
    if (value !== undefined && siblings.some((s) => s.choice?.value === value)) {
      refuse("card " + e.card + " already has a choice " + value);
    }
  }

  function defineCard(card: ExportCardDecl): () => void {
    if (cardDecls.some((c) => c.id === card.id)) refuse("card " + card.id + " is already defined");
    cardDecls.push(Object.freeze({ ...card }));
    changed();
    return () => {
      const at = cardDecls.findIndex((c) => c.id === card.id);
      if (at === -1) return;
      if (variantsOf(card.id).length) refuse("card " + card.id + " still has exporters");
      cardDecls.splice(at, 1);
      changed();
    };
  }

  function register(decl: ExporterDecl<Request, Doc>): () => void {
    if (entries.some((e) => e.id === decl.id)) refuse("exporter " + decl.id + " is already registered");
    checkSurface(decl);
    const exporter: Exporter<Request, Doc> = Object.freeze({ ...decl });
    entries.push(exporter);
    changed();
    return () => {
      const at = entries.indexOf(exporter);
      if (at === -1) return;
      entries.splice(at, 1);
      changed();
    };
  }

  function cards(): readonly ExportCard<Request, Doc>[] {
    return cardDecls
      .map((c) => ({ ...c, variants: variantsOf(c.id) }))
      .filter((c) => c.variants.length > 0);
  }

  return {
    defineCard,
    register,
    card: (id) => cards().find((c) => c.id === id),
    cards,
    exporters: () => entries.filter((e) => e.action !== undefined),
    byId: (id) => entries.find((e) => e.id === id),
    byAction: (action) => entries.find((e) => e.action === action),
    isAction: (action) => typeof action === "string" && action !== "" && entries.some((e) => e.action === action),
    onChange: (listener) => {
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at !== -1) listeners.splice(at, 1);
      };
    }
  };
}

export function exportToggleOptions<Request, Doc>(
  registry: Pick<ExportRegistry<Request, Doc>, "card">,
  exporter: Exporter<Request, Doc> | null | undefined,
  overrides?: Readonly<Record<string, unknown>> | null
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const toggle = exporter?.card ? registry.card(exporter.card)?.toggle : undefined;
  if (toggle) {
    const given = overrides?.[toggle.id];
    out[toggle.id] = typeof given === "boolean" ? given : toggle.on();
  }
  return out;
}
