export const deliveryOrders = ["D1", "D2", "D3", "dup", "rev", "late-C"] as const;
export type DeliveryOrder = typeof deliveryOrders[number];
export type ReplicaName = "A" | "B" | "C";

export interface DeliveryReplica<Update> {
  onLocalUpdate: (listener: (update: Update) => void) => () => void;
  apply: (update: Update) => void;
}

export interface QueuedDelivery<Update> {
  id: string;
  from: ReplicaName;
  to: ReplicaName;
  update: Update;
}

export class DeliveryQueue<Update> {
  readonly pending: QueuedDelivery<Update>[] = [];
  readonly history: string[] = [];
  private serial = 0;
  private delivering: ReplicaName | null = null;
  private readonly replicas = new Map<ReplicaName, DeliveryReplica<Update>>();
  private readonly detach = new Map<ReplicaName, () => void>();
  private readonly copy: (update: Update) => Update;
  private readonly describe: (update: Update) => string;

  constructor(copy: (update: Update) => Update, describe: (update: Update) => string) {
    this.copy = copy;
    this.describe = describe;
  }

  addReplica(from: ReplicaName, replica: DeliveryReplica<Update>): void {
    if (this.replicas.has(from)) throw new Error(`Replica ${from} already attached`);
    this.replicas.set(from, replica);
    this.detach.set(from, replica.onLocalUpdate(update => {
      if (this.delivering === from) throw new Error(`Replica ${from} reported a delivered update as local`);
      for (const to of this.replicas.keys()) {
        if (to === from) continue;
        const id = `${from}${++this.serial}`;
        this.pending.push({ id, from, to, update: this.copy(update) });
        this.history.push(`enqueue ${id} ${from}->${to} ${this.describe(update)}`);
      }
    }));
  }

  lateJoin(name: ReplicaName, replica: DeliveryReplica<Update>, source: ReplicaName, state: Update): void {
    if (!this.replicas.has(source)) throw new Error(`Missing source ${source}`);
    this.receive(name, replica, this.copy(state));
    this.addReplica(name, replica);
    this.history.push(`late-${name} full state from ${source}`);
  }

  deliver(id: string, copies = 1): void {
    const index = this.pending.findIndex(message => message.id === id);
    const message = this.pending[index];
    if (!message) throw new Error(`No queued delivery ${id}`);
    const recipient = this.replicas.get(message.to);
    if (!recipient) throw new Error(`Missing recipient ${message.to}`);
    for (let copy = 0; copy < copies; copy++) {
      this.history.push(`deliver ${id} ${message.from}->${message.to} copy ${copy + 1}`);
      this.receive(message.to, recipient, this.copy(message.update));
    }
    this.pending.splice(index, 1);
  }

  deliverFrom(from: ReplicaName, order: DeliveryOrder): void {
    const messages = this.pending.filter(message => message.from === from);
    if (order === "rev") messages.reverse();
    for (const message of messages) this.deliver(message.id, order === "dup" ? 2 : 1);
  }

  flush(order: DeliveryOrder): void {
    const messages = [...this.pending];
    if (order === "rev") messages.reverse();
    for (const message of messages) this.deliver(message.id, order === "dup" ? 2 : 1);
    if (this.pending.length > 0) throw new Error("Delivery echoed a remote update");
  }

  destroy(): void {
    for (const detach of this.detach.values()) detach();
    this.detach.clear();
  }

  private receive(name: ReplicaName, replica: DeliveryReplica<Update>, update: Update): void {
    this.delivering = name;
    try {
      replica.apply(update);
    } finally {
      this.delivering = null;
    }
  }
}
