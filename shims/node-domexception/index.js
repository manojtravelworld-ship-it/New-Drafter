// Use the platform's native DOMException as recommended by npm.
module.exports = typeof globalThis.DOMException !== 'undefined' ? globalThis.DOMException : Error;
