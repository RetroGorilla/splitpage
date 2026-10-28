export interface OperationContext {
  readonly epoch: number;
  readonly docId: string | null;
  readonly destination: unknown;
  readonly destinationGeneration: number;
  readonly generation: number;
}

export interface OperationPorts {
  readonly session: { readonly epoch: () => number; readonly generation: () => number };
  readonly document: { readonly id: () => string | null };
  readonly destination: {
    readonly identity: () => unknown;
    readonly generation: () => number;
  };
}

export interface Operations {
  readonly capture: () => OperationContext;
  readonly stillOwns: (ctx: OperationContext) => boolean;
}

export function createOperations(ports: OperationPorts): Operations {
  function capture(): OperationContext {
    return Object.freeze({
      epoch: ports.session.epoch(),
      docId: ports.document.id(),
      destination: ports.destination.identity(),
      destinationGeneration: ports.destination.generation(),
      generation: ports.session.generation()
    });
  }

  function stillOwns(ctx: OperationContext): boolean {
    return ctx.epoch === ports.session.epoch() &&
      ctx.docId === ports.document.id() &&
      ctx.destination === ports.destination.identity();
  }

  return Object.freeze({ capture: capture, stillOwns: stillOwns });
}
