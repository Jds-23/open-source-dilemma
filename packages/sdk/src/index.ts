// @osd/sdk: typed client for the Open Source Dilemma contract (interfaces-v2).
// Isomorphic entry; Node-only helpers (fixtures from disk, key files, env config) are in `@osd/sdk/node`.
export * from './types.js';
export * from './constants.js';
export * from './crypto.js';
export * from './events.js';
export * from './transport.js';
export * from './client.js';
export * from './mock.js';
export { RpcViewProvider, agentKeySigner, fullAccessSigner, generateAgentKey, publicKeyOf } from './near.js';
export type { KeySignerOptions, RpcInput } from './near.js';
