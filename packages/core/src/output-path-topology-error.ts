export class OutputPathTopologyError extends Error {
  constructor(message: string, readonly path: string) {
    super(message);
    this.name = "OutputPathTopologyError";
    Object.setPrototypeOf(this, OutputPathTopologyError.prototype);
  }
}
