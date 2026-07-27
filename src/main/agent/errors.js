'use strict';

class InvalidArgumentsError extends Error {
  constructor(tool, detail) {
    super(`The ${tool} tool was called with invalid arguments: ${detail}. Rewrite the input so it satisfies the expected schema and call it again.`);
    this.name = 'InvalidArgumentsError';
    this.tool = tool;
  }
}

module.exports = { InvalidArgumentsError };
