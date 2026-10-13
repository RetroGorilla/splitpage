export interface OperationContext {
  readonly epoch: number;
  readonly docId: string | null;
  readonly destination: unknown;
  readonly generation: number;
  readonly connection: unknown;
  readonly revision: number | null;
}

export interface OperationPorts {
  readonly session: { readonly epoch: () => number; readonly generation: () => number };
  readonly document: { readonly id: () => string | null };
  readonly destination: { readonly identity: () => unknown; readonly revision: () => number | null };
  readonly connection: { readonly current: () => unknown };
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
      generation: ports.session.generation(),
      connection: ports.connection.current(),
      revision: ports.destination.revision()
    });
  }

  function stillOwns(ctx: OperationContext): boolean {
    return ctx.epoch === ports.session.epoch() &&
      ctx.docId === ports.document.id() &&
      ctx.destination === ports.destination.identity() &&
      ctx.connection === ports.connection.current();
  }

  return Object.freeze({ capture: capture, stillOwns: stillOwns });
}
