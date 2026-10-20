export class AgentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentError";
  }
}

export class AgentUnavailableError extends AgentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentUnavailableError";
  }
}

export class AgentVersionMismatchError extends AgentError {
  constructor(actual: string, expected: string) {
    super(`OpenCode service version ${actual} does not satisfy ${expected}`);
    this.name = "AgentVersionMismatchError";
  }
}
